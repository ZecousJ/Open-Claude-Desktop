package com.claudex.mobile

import com.claudex.core.*
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import java.security.MessageDigest
import java.util.Base64
import kotlin.test.*

class ChatContractsTest {
    private fun conversation(id: String = "chat") = JSONObject().put("id", id).put("title", "Real shape").put("providerId", "provider").put("model", "model").put("projectId", "project").put("turns", JSONArray(listOf(JSONObject().put("id", "turn").put("prompt", "Question").put("status", "completed").put("items", JSONArray()))))
    private class Harness(val handle: (String, JSONArray) -> Any?) : AutoCloseable {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val calls = mutableListOf<Pair<String, JSONArray>>()
        val api = NativeApi("https://example.test", NativeApiTest.MemoryVault(Session("access", "refresh", System.currentTimeMillis() + 3600000, "test@example.test")), OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request(); val name = req.url.pathSegments.last()
            val args = JSONObject(req.body!!.let { body -> Buffer().also(body::writeTo).readUtf8() }).getJSONArray("args")
            synchronized(calls) { calls += name to args }
            val value = handle(name, args)
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(200).message("fixture").body(JSONObject().put("ok", true).put("value", value ?: JSONObject.NULL).toString().toResponseBody("application/json".toMediaType())).build()
        }.build())
        val repo = RemoteRepository(api, scope)
        override fun close() { repo.clearLocalSession(); scope.cancel(); api.client.dispatcher.executorService.shutdownNow() }
    }
    @Test fun retryEditAndVersionPayloadsUsePositionalWebArguments() = runBlocking {
        Harness { _, _ -> conversation() }.use { h ->
            h.repo.retryResponse("chat", "turn", "provider", "model")
            h.repo.editPrompt("chat", "turn", "Edited", "provider", "model")
            h.repo.selectVersion("chat", "turn", "other", false)
            h.repo.selectVersion("chat", "turn", "other-prompt", true)
            assertEquals(listOf("retryResponse", "editPrompt", "selectReplyVersion", "selectPromptVersion"), h.calls.map { it.first })
            assertEquals("[\"chat\",\"turn\",\"provider\",\"model\"]", h.calls[0].second.toString())
            assertEquals("[\"chat\",\"turn\",\"Edited\",\"provider\",\"model\"]", h.calls[1].second.toString())
            assertEquals("[\"chat\",\"turn\",\"other\"]", h.calls[2].second.toString())
            assertEquals("chat", h.repo.snapshot.value.conversations.single().id)
        }
    }
    @Test fun ratingsUseReturnedMapAndExplicitNullToClear() = runBlocking {
        Harness { _, args -> if (args.isNull(2)) JSONObject() else JSONObject().put(feedbackKey("chat", "turn"), args.getString(2)) }.use { h ->
            h.repo.setReplyFeedback("chat", "turn", "up"); assertEquals("up", h.repo.snapshot.value.replyFeedback[feedbackKey("chat", "turn")])
            h.repo.setReplyFeedback("chat", "turn", null); assertTrue(h.calls.last().second.isNull(2)); assertTrue(h.repo.snapshot.value.replyFeedback.isEmpty())
            assertTrue(h.calls.all { it.first == "setReplyFeedback" }) // Never submits an excerpt/report implicitly.
        }
    }
    @Test fun deleteRemovesOnlyAfterAckAndIgnoresLateConversationEvent() = runBlocking {
        Harness { method, _ -> when (method) { "retryResponse" -> conversation(); "deleteConversation" -> null; else -> error(method) } }.use { h ->
            h.repo.retryResponse("chat", "turn", "provider", "model"); h.repo.deleteConversation("chat")
            assertEquals("[\"chat\"]", h.calls.last().second.toString()); assertTrue(h.repo.snapshot.value.conversations.isEmpty())
            h.repo.receiveFrame(JSONObject().put("t", "event").put("seq", 1).put("event", JSONObject().put("type", "conversation").put("conversation", conversation())))
            assertTrue(h.repo.snapshot.value.conversations.isEmpty())
        }
    }
    @Test fun projectDeletionDetachesConversationsAndKeepsThem() = runBlocking {
        Harness { method, _ -> if (method == "retryResponse") conversation() else null }.use { h ->
            h.repo.retryResponse("chat", "turn", "provider", "model"); h.repo.deleteProject("project")
            assertEquals("deleteProject", h.calls.last().first); assertEquals("[\"project\"]", h.calls.last().second.toString())
            assertNull(h.repo.snapshot.value.conversations.single().projectId)
        }
    }
    @Test fun generatedFileUsesDigestNotTranscriptPathAndRejectsCorruption() = runBlocking {
        val bytes = byteArrayOf(0, 1, -1, 40, 10); val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val file = GeneratedFile("file", "../file.pdf", "ready", digest, bytes.size.toLong(), "application/pdf", true)
        Harness { _, _ -> Base64.getEncoder().encodeToString(bytes) }.use { h ->
            assertContentEquals(bytes, h.repo.readGeneratedFile(file)); assertEquals("readGeneratedFile", h.calls.single().first)
            assertEquals(JSONArray(listOf(digest)).toString(), h.calls.single().second.toString())
            assertFails { h.repo.readGeneratedFile(file.copy(digest = "0".repeat(64))) }; Unit
        }
    }
    @Test fun invalidGeneratedFileNeverMakesNetworkRequest() = runBlocking {
        Harness { _, _ -> error("must not call") }.use { h ->
            assertFails { h.repo.readGeneratedFile(GeneratedFile("f", "x", "unavailable", blob = true)) }
            assertFails { h.repo.readGeneratedFile(GeneratedFile("f", "x", "ready", "../bad", blob = true)) }
            assertTrue(h.calls.isEmpty())
        }
    }
    @Test fun wireCodecKeepsBinaryDescriptorsAndBranches() {
        val raw = conversation().put("savedBranches", JSONArray(listOf(JSONObject().put("id", "old").put("visited", 9).put("turns", JSONArray(listOf(JSONObject().put("id", "prior").put("responseGroupId", "turn").put("promptGroupId", "prompt").put("promptVersionId", "v1")))))))
        val item = JSONObject().put("id", "output").put("type", "agentMessage").put("generatedFiles", JSONArray(listOf(JSONObject().put("id", "f").put("name", "report.pdf").put("state", "ready").put("blob", true).put("mime", "application/pdf").put("digest", "a".repeat(64)).put("bytes", 8))))
        raw.getJSONArray("turns").getJSONObject(0).put("items", JSONArray(listOf(item)))
        val decoded = WireCodec.conversation(raw)
        assertEquals("application/pdf", decoded.turns.single().items.single().generatedFiles.single().mime)
        assertEquals("v1", decoded.savedBranches.single().turns.single().promptVersionId)
        val snapshot = WireCodec.snapshot(JSONObject().put("conversations", JSONArray(listOf(raw))), null)
        assertTrue(snapshot.artifacts.single().generatedFile!!.blob)
    }
    @Test fun independentRatingsKeepBothWhenResponsesFinishInReverseOrder() = runBlocking {
        val entered = java.util.concurrent.CountDownLatch(1); val release = java.util.concurrent.CountDownLatch(1)
        Harness { _, args ->
            val id = args.getString(0)
            if (id == "a") { entered.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
            JSONObject().put(feedbackKey(id, "turn"), "up")
        }.use { h ->
            try {
                val first = async(Dispatchers.Default) { h.repo.setReplyFeedback("a", "turn", "up") }
                assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
                h.repo.setReplyFeedback("b", "turn", "up")
                release.countDown(); first.await()
                assertEquals(mapOf(feedbackKey("a", "turn") to "up", feedbackKey("b", "turn") to "up"), h.repo.snapshot.value.replyFeedback)
            } finally { release.countDown() }
        }
    }
    @Test fun newerStreamedTurnSurvivesLateRetryResponse() = runBlocking {
        val entered = java.util.concurrent.CountDownLatch(1); val release = java.util.concurrent.CountDownLatch(1); var calls = 0
        Harness { _, _ ->
            calls++
            if (calls == 2) { entered.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
            conversation()
        }.use { h ->
            try {
                h.repo.retryResponse("chat", "turn", "provider", "model")
                val retry = async(Dispatchers.Default) { h.repo.retryResponse("chat", "turn", "provider", "model") }
                assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
                val turn = JSONObject().put("id", "turn").put("status", "inProgress").put("items", JSONArray(listOf(JSONObject().put("id", "answer").put("type", "agentMessage").put("text", "newer streamed content"))))
                h.repo.receiveFrame(JSONObject().put("t", "event").put("seq", 1).put("event", JSONObject().put("type", "conversation-turn").put("conversationId", "chat").put("turn", turn)))
                release.countDown(); retry.await()
                assertEquals("newer streamed content", h.repo.snapshot.value.conversations.single().turns.single().items.single().text)
            } finally { release.countDown() }
        }
    }
}
