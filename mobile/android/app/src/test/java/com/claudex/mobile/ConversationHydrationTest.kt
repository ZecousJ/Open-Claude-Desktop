package com.claudex.mobile

import com.claudex.core.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.*

/** Uses the real NativeApi/RPC codec; no full-Conversation hydration fixture is allowed. */
class ConversationHydrationTest {
    private val suffix = "__AFTER_1024_SENTINEL__"
    private val fullOutput = "x".repeat(1024) + suffix
    private val fullPrompt = "p".repeat(1100) + "__PROMPT_END__"
    private val fullAssistant = "a".repeat(1100) + "__ASSISTANT_END__"

    private fun turn(output: String = fullOutput, id: String = "turn"): JSONObject = JSONObject()
        .put("id", id).put("prompt", fullPrompt).put("attachments", JSONArray())
        .put("status", "completed").put("createdAt", 1)
        .put("items", JSONArray(listOf(
            JSONObject().put("id", "command-$id").put("type", "commandExecution")
                .put("command", "echo test").put("aggregatedOutput", output),
            JSONObject().put("id", "answer-$id").put("type", "agentMessage").put("text", fullAssistant)
        )))

    private fun conversation(slim: Boolean? = true, output: String = "x".repeat(1024) + "…", id: String = "chat"): JSONObject = JSONObject()
        .put("id", id).put("title", "Preserved title").put("providerId", "provider").put("model", "model")
        .put("mode", "code").put("pinned", true).put("archived", false).put("createdAt", 1).put("updatedAt", 2)
        .put("projectId", "project").put("turns", JSONArray(listOf(turn(output))))
        .also { if (slim != null) it.put("slim", slim) }

    private fun snapshot(vararg conversations: JSONObject) = JSONObject()
        .put("conversations", JSONArray(conversations.toList())).put("settings", JSONObject())
        .put("projects", JSONArray()).put("engine", JSONObject().put("state", "ready"))

    // This response intentionally has no id, title, model, providerId, or other Conversation metadata.
    private fun turnsDocument(output: String = fullOutput, id: String = "turn") = JSONObject()
        .put("turns", JSONArray(listOf(turn(output, id))))
        .put("savedBranches", JSONArray(listOf(JSONObject().put("id", "branch").put("turns", JSONArray(listOf(turn(output)))))))

    private fun event(seq: Long, value: JSONObject) = JSONObject().put("t", "event").put("seq", seq).put("event", value)
    private fun output(repo: RemoteRepository, id: String = "chat") = repo.snapshot.value.conversations.first { it.id == id }.turns.first().items.first().text

    private class Harness(initial: JSONObject, val scope: CoroutineScope) : AutoCloseable {
        val currentSnapshot = AtomicReference(initial)
        val reads = AtomicInteger()
        @Volatile var snapshotRead: (() -> JSONObject)? = null
        val requests = mutableListOf<JSONObject>()
        @Volatile var read: (Int) -> Pair<Int, JSONObject> = { error("Unconfigured hydration") }
        val vault = NativeApiTest.MemoryVault(Session("test-access", "test-refresh", System.currentTimeMillis() + 3_600_000, "test@example.test"))
        val api = NativeApi("https://example.test", vault, OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val method = request.url.encodedPath.substringAfterLast('/')
            val reply = when (method) {
                "snapshot" -> 200 to JSONObject().put("ok", true).put("value", snapshotRead?.invoke() ?: currentSnapshot.get())
                "modelCatalog" -> 200 to JSONObject().put("ok", true).put("value", JSONObject.NULL)
                "conversationTurns" -> {
                    val payload = JSONObject(request.body!!.let { body -> Buffer().also(body::writeTo).readUtf8() })
                    synchronized(requests) { requests += payload }
                    read(reads.incrementAndGet()).let { (status, value) ->
                        status to if (status == 200) JSONObject().put("ok", true).put("value", value)
                        else JSONObject().put("ok", false).put("error", JSONObject().put("code", "TEMPORARY").put("message", "Try again"))
                    }
                }
                "login" -> 200 to JSONObject().put("code", 0).put("data", JSONObject()
                    .put("access_token", "next-account-access").put("refresh_token", "next-account-refresh")
                    .put("expires_in", 3600).put("user", JSONObject().put("email", "new@example.test")))
                "logout" -> 200 to JSONObject().put("code", 0).put("data", JSONObject())
                "me" -> 200 to JSONObject().put("code", 0).put("data", JSONObject().put("username", "synthetic-user"))
                else -> error("Unexpected method: $method")
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(reply.first).message("test")
                .body(reply.second.toString().toResponseBody("application/json".toMediaType())).build()
        }.build())
        val repo = RemoteRepository(api, scope)
        override fun close() { repo.clearLocalSession(); scope.cancel(); api.client.dispatcher.executorService.shutdownNow() }
    }

    private fun harness(initial: JSONObject) = Harness(initial, CoroutineScope(SupervisorJob() + Dispatchers.Default))
    private suspend fun complete(repo: RemoteRepository, id: String = "chat") = withTimeout(5_000) {
        repo.snapshot.first { snapshot -> snapshot.conversations.any { it.id == id && !it.slim } }
    }
    private fun await(latch: CountDownLatch) = assertTrue(latch.await(5, TimeUnit.SECONDS), "Timed out waiting for controlled request")

    @Test fun slimSnapshotHydratesActualTurnsEnvelopeAndKeepsMetadata() = runBlocking {
        harness(snapshot(conversation())).use { h ->
            h.read = { 200 to turnsDocument() }
            h.repo.refresh()
            val before = h.repo.snapshot.value.conversations.single()
            assertTrue(before.slim)
            assertFalse(output(h.repo).contains(suffix))
            assertEquals(fullPrompt, before.turns.single().prompt)
            assertEquals(fullAssistant, before.turns.single().items[1].text)
            h.repo.beginViewingConversation("chat")
            complete(h.repo)
            val after = h.repo.snapshot.value.conversations.single()
            assertEquals(fullOutput, output(h.repo))
            assertEquals("branch", after.savedBranches.single().id)
            assertEquals(before.copy(turns = after.turns, savedBranches = after.savedBranches, slim = false), after)
            assertEquals(fullPrompt, after.turns.single().prompt)
            assertEquals(fullAssistant, after.turns.single().items[1].text)
            assertEquals("chat", h.requests.single().getJSONArray("args").getString(0))
            assertEquals(1, h.reads.get())
        }
    }

    @Test fun oldRunnerWithoutSlimMarkerAndFullConversationSkipHydration() = runBlocking {
        harness(snapshot(conversation(null, fullOutput))).use { h ->
            h.repo.refresh(); h.repo.beginViewingConversation("chat")
            assertFalse(h.repo.snapshot.value.conversations.single().slim)
            assertEquals(fullOutput, output(h.repo)); assertEquals(0, h.reads.get())
            h.currentSnapshot.set(snapshot(conversation(false, fullOutput)))
            h.repo.refresh(); assertEquals(0, h.reads.get())
        }
    }

    @Test fun exactly1024And1025CharactersRoundTripWithoutClientTruncation() = runBlocking {
        for (size in listOf(1024, 1025)) harness(snapshot(conversation())).use { h ->
            val expected = "k".repeat(size - 1) + "Z"
            h.read = { 200 to turnsDocument(expected) }; h.repo.refresh(); h.repo.beginViewingConversation("chat"); complete(h.repo)
            assertEquals(size, output(h.repo).length); assertEquals(expected, output(h.repo))
        }
    }

    @Test fun duplicateViewsAndRetryClicksShareOneInflightRead() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        harness(snapshot(conversation())).use { h ->
            try {
                h.read = { entered.countDown(); await(release); 200 to turnsDocument() }
                h.repo.refresh(); val oldLease = h.repo.beginViewingConversation("chat"); await(entered)
                repeat(20) { h.repo.beginViewingConversation("chat"); h.repo.retryConversationContent("chat") }
                h.repo.endViewingConversation(oldLease) // Outgoing task destination must not clear the newer chat lease.
                assertEquals(1, h.reads.get()); release.countDown(); complete(h.repo)
                assertEquals(1, h.reads.get()); assertEquals(fullOutput, output(h.repo))
            } finally { release.countDown() }
        }
    }

    @Test fun failureKeepsSlimAndDoesNotLoopUntilExplicitRetry() = runBlocking {
        harness(snapshot(conversation())).use { h ->
            h.read = { attempt -> if (attempt == 1) 503 to JSONObject() else 200 to turnsDocument() }
            h.repo.refresh(); h.repo.beginViewingConversation("chat")
            withTimeout(5_000) { h.repo.contentLoads.first { it["chat"] is ContentLoadState.Failed } }
            assertTrue(h.repo.snapshot.value.conversations.single().slim)
            assertEquals("x".repeat(1024) + "…", output(h.repo))
            delay(150); assertEquals(1, h.reads.get())
            h.repo.retryConversationContent("chat"); complete(h.repo); assertEquals(2, h.reads.get())
        }
    }

    @Test fun malformedSuccessfulPayloadRemainsRetryableAndIncomplete() = runBlocking {
        harness(snapshot(conversation())).use { h ->
            h.read = { 200 to JSONObject().put("id", "not-a-turns-document") }
            h.repo.refresh(); h.repo.beginViewingConversation("chat")
            withTimeout(5_000) { h.repo.contentLoads.first { it["chat"] is ContentLoadState.Failed } }
            assertTrue(h.repo.snapshot.value.conversations.single().slim); assertEquals(1, h.reads.get())
        }
    }

    @Test fun refreshAndSocketSnapshotsRehydrateAnAlreadyOpenConversation() = runBlocking {
        harness(snapshot(conversation())).use { h ->
            h.read = { attempt -> 200 to turnsDocument("full-$attempt-$suffix") }
            h.repo.refresh(); h.repo.beginViewingConversation("chat"); complete(h.repo)
            h.repo.refresh(); complete(h.repo); assertEquals("full-2-$suffix", output(h.repo))
            h.repo.receiveFrame(JSONObject().put("t", "snapshot").put("seq", 10).put("snapshot", snapshot(conversation())))
            complete(h.repo); assertEquals("full-3-$suffix", output(h.repo)); assertEquals(3, h.reads.get())
        }
    }

    @Test fun reconnectReadyResyncRehydratesTheOpenSlimConversation() = runBlocking {
        harness(snapshot(conversation())).use { h ->
            h.read = { attempt -> 200 to turnsDocument("ready-$attempt") }
            h.repo.refresh(); h.repo.beginViewingConversation("chat"); complete(h.repo)
            h.repo.receiveFrame(JSONObject().put("t", "ready").put("v", 1).put("seq", 4).put("resumed", false))
            // The fresh stream's state read is coalesced and runs shortly after ready.
            withTimeout(5_000) { while (h.reads.get() < 2 || output(h.repo) != "ready-2") delay(20) }
            assertEquals("ready-2", output(h.repo)); assertEquals(2, h.reads.get())
        }
    }

    @Test fun lateHydrationCannotOverwriteNewerFullConversationEvent() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        harness(snapshot(conversation())).use { h ->
            try {
                h.read = { entered.countDown(); await(release); 200 to turnsDocument("OLD") }
                h.repo.refresh(); h.repo.beginViewingConversation("chat"); await(entered)
                h.repo.receiveFrame(event(1, JSONObject().put("type", "conversation").put("conversation", conversation(false, "NEW FULL"))))
                release.countDown(); withTimeout(5_000) { h.repo.contentLoads.first { it["chat"] == null } }; delay(100)
                assertEquals("NEW FULL", output(h.repo)); assertFalse(h.repo.snapshot.value.conversations.single().slim)
            } finally { release.countDown() }
        }
    }

    @Test fun turnEventKeepsSlimAndSupersedesOlderHydrationRead() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        harness(snapshot(conversation())).use { h ->
            try {
                h.read = { attempt -> if (attempt == 1) { entered.countDown(); await(release); 200 to turnsDocument("OLD") } else 200 to turnsDocument("NEW TURN") }
                h.repo.refresh(); h.repo.beginViewingConversation("chat"); await(entered)
                h.repo.receiveFrame(event(1, JSONObject().put("type", "conversation-turn").put("conversationId", "chat").put("turn", turn("NEW TURN"))))
                assertTrue(h.repo.snapshot.value.conversations.single().slim)
                release.countDown()
                withTimeout(5_000) { h.repo.contentLoads.first { it["chat"] is ContentLoadState.Failed } }
                assertTrue(h.repo.snapshot.value.conversations.single().slim); assertEquals("NEW TURN", output(h.repo)); assertEquals(1, h.reads.get())
                h.repo.retryConversationContent("chat"); complete(h.repo); assertEquals("NEW TURN", output(h.repo)); assertEquals(2, h.reads.get())
            } finally { release.countDown() }
        }
    }


    @Test fun manyStreamingDeltasCannotCreateAnAutomaticHydrationLoop() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        harness(snapshot(conversation())).use { h ->
            try {
                h.read = { attempt -> if (attempt == 1) { entered.countDown(); await(release); 200 to turnsDocument("OLD") } else 200 to turnsDocument("FULL FINAL") }
                h.repo.refresh(); h.repo.beginViewingConversation("chat"); await(entered)
                repeat(50) { index -> h.repo.receiveFrame(event(index + 1L, JSONObject().put("type", "conversation-turn").put("conversationId", "chat").put("turn", turn("delta-$index")))) }
                release.countDown()
                withTimeout(5_000) { h.repo.contentLoads.first { it["chat"] is ContentLoadState.Failed } }
                repeat(50) { index -> h.repo.receiveFrame(event(index + 51L, JSONObject().put("type", "conversation-turn").put("conversationId", "chat").put("turn", turn("later-$index")))) }
                h.repo.receiveFrame(event(101, JSONObject().put("type", "conversation").put("conversation", conversation(false, "UNRELATED", "other"))))
                delay(100); assertEquals(1, h.reads.get()); assertTrue(h.repo.snapshot.value.conversations.first { it.id == "chat" }.slim)
                h.repo.retryConversationContent("chat"); complete(h.repo); assertEquals(2, h.reads.get()); assertEquals("FULL FINAL", output(h.repo))
            } finally { release.countDown() }
        }
    }

    @Test fun newerSnapshotRevisionRejectsOldHydrationAndFetchesCurrentContent() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        harness(snapshot(conversation())).use { h ->
            try {
                h.read = { attempt -> if (attempt == 1) { entered.countDown(); await(release); 200 to turnsDocument("OLD") } else 200 to turnsDocument("AFTER REFRESH") }
                h.repo.refresh(); h.repo.beginViewingConversation("chat"); await(entered)
                h.currentSnapshot.set(snapshot(conversation(true, "NEW SLIM"))); h.repo.refresh()
                assertEquals("NEW SLIM", output(h.repo)); release.countDown(); complete(h.repo)
                assertEquals("AFTER REFRESH", output(h.repo)); assertEquals(2, h.reads.get())
            } finally { release.countDown() }
        }
    }

    @Test fun deletionWhileLoadingCannotResurrectConversation() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        harness(snapshot(conversation())).use { h ->
            try {
                h.read = { entered.countDown(); await(release); 200 to turnsDocument() }
                h.repo.refresh(); h.repo.beginViewingConversation("chat"); await(entered)
                h.currentSnapshot.set(snapshot()); h.repo.refresh(); release.countDown(); delay(150)
                assertTrue(h.repo.snapshot.value.conversations.isEmpty()); assertTrue(h.repo.contentLoads.value.isEmpty())
            } finally { release.countDown() }
        }
    }

    @Test fun navigatingAwayRejectsLateReadAndReopeningCanLoadAgain() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        harness(snapshot(conversation(), conversation(false, "OTHER", "other"))).use { h ->
            try {
                h.read = { attempt -> if (attempt == 1) { entered.countDown(); await(release); 200 to turnsDocument("OLD VIEW") } else 200 to turnsDocument("REOPENED") }
                h.repo.refresh(); h.repo.beginViewingConversation("chat"); await(entered)
                h.repo.beginViewingConversation("other"); release.countDown(); delay(150)
                assertTrue(h.repo.snapshot.value.conversations.first { it.id == "chat" }.slim)
                assertFalse(output(h.repo).contains("OLD VIEW")); assertEquals("OTHER", output(h.repo, "other"))
                h.repo.beginViewingConversation("chat"); complete(h.repo); assertEquals("REOPENED", output(h.repo))
            } finally { release.countDown() }
        }
    }

    @Test fun signedOutEventClearsPendingReadEvenWithSequenceGap() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        harness(snapshot(conversation())).use { h ->
            try {
                h.read = { entered.countDown(); await(release); 200 to turnsDocument("OLD ACCOUNT") }
                h.repo.refresh(); h.repo.beginViewingConversation("chat"); await(entered)
                h.repo.receiveFrame(event(900, JSONObject().put("type", "signed-out")))
                release.countDown(); delay(150)
                assertNull(h.api.session); assertTrue(h.repo.snapshot.value.conversations.isEmpty()); assertTrue(h.repo.contentLoads.value.isEmpty())
            } finally { release.countDown() }
        }
    }


    @Test fun commandOutputWinsOverIncidentalLabelAndEmptyContentWithoutChangingAssistant() {
        val value = turn()
        value.getJSONArray("items").getJSONObject(0).put("text", "Command label").put("content", JSONArray())
        val decoded = WireCodec.turn(value)
        assertEquals(fullOutput, decoded.items[0].text)
        assertEquals(fullAssistant, decoded.items[1].text)
        assertEquals(fullPrompt, decoded.prompt)
    }

    @Test fun utf16BoundaryOutputIsHydratedWithoutSplittingOrDroppingUnicode() = runBlocking {
        val expected = "🙂".repeat(512) + "Z"
        assertEquals(1025, expected.length)
        harness(snapshot(conversation(true, expected.take(1024) + "…"))).use { h ->
            h.read = { 200 to turnsDocument(expected) }
            h.repo.refresh(); h.repo.beginViewingConversation("chat"); complete(h.repo)
            assertEquals(expected, output(h.repo)); assertEquals(1025, output(h.repo).length)
        }
    }

    @Test fun accountSwitchRejectsLateReadAndOldQueuedSocketFrameForTheSameId() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        harness(snapshot(conversation())).use { h ->
            try {
                h.read = { attempt -> if (attempt == 1) { entered.countDown(); await(release); 200 to turnsDocument("OLD ACCOUNT") } else 200 to turnsDocument("NEW ACCOUNT") }
                h.repo.refresh(); h.repo.beginViewingConversation("chat"); await(entered)
                h.repo.clearLocalSession(); h.api.clear()
                h.api.login("new@example.test", "transient-password")
                h.currentSnapshot.set(snapshot(conversation(true, "NEW ACCOUNT SLIM")))
                h.repo.refresh(); h.repo.beginViewingConversation("chat"); complete(h.repo)
                release.countDown(); delay(100)
                h.repo.receiveFrame(JSONObject().put("t", "snapshot").put("seq", 900).put("snapshot", snapshot(conversation(false, "OLD SOCKET"))), expectedEpoch = 0, expectedSocket = 0)
                assertEquals("NEW ACCOUNT", output(h.repo)); assertEquals("new@example.test", h.api.session?.accountLabel)
                assertEquals(2, h.reads.get())
            } finally { release.countDown() }
        }
    }


    @Test fun sessionResetDuringGapOrReadyResyncCannotReviveOldDataOrConnection() = runBlocking {
        for (kind in listOf("gap", "ready")) {
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            harness(snapshot(conversation(false, "INITIAL"))).use { h ->
                try {
                    h.repo.receiveFrame(JSONObject().put("t", "snapshot").put("seq", 1).put("snapshot", snapshot(conversation(false, "INITIAL"))))
                    h.snapshotRead = { entered.countDown(); await(release); snapshot(conversation(false, "OLD RESYNC")) }
                    val frame = if (kind == "gap") event(4, JSONObject().put("type", "conversation").put("conversation", conversation(false, "OLD EVENT")))
                        else JSONObject().put("t", "ready").put("v", 1).put("seq", 4).put("resumed", false)
                    val pending = async(Dispatchers.Default) { h.repo.receiveFrame(frame) }
                    await(entered)
                    // Deliberately retain NativeApi's credential epoch: this verifies the repository's
                    // own post-await guard instead of relying on NativeApi rejecting the response.
                    h.repo.clearLocalSession(); release.countDown(); pending.await()
                    assertTrue(h.repo.snapshot.value.conversations.isEmpty(), kind)
                    assertTrue(h.repo.contentLoads.value.isEmpty(), kind)
                    assertEquals(com.claudex.core.Connection.Offline, h.repo.connection.value, kind)
                } finally { release.countDown() }
            }
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun cancelBeforeLazyRequestStartsDoesNotLeaveSingleFlightStuck() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val h = Harness(snapshot(conversation()), CoroutineScope(SupervisorJob() + dispatcher))
        try {
            h.read = { 200 to turnsDocument() }; h.repo.refresh()
            val lease = h.repo.beginViewingConversation("chat"); h.repo.endViewingConversation(lease)
            runCurrent(); assertTrue(h.repo.contentLoads.value.isEmpty()); assertEquals(0, h.reads.get())
            h.repo.beginViewingConversation("chat"); runCurrent()
            withContext(Dispatchers.Default) { complete(h.repo) }
            assertEquals(1, h.reads.get())
        } finally { h.close() }
    }
}
