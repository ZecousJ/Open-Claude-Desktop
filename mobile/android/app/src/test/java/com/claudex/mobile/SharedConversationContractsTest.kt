package com.claudex.mobile

import com.claudex.core.*
import org.json.JSONObject
import kotlin.test.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest

class SharedConversationContractsTest {
    private fun rawConversation() = JSONObject("""{
      "id":"c1","title":"Rich","mode":"chat","providerId":"p","model":"m","cwd":"/workspace","research":{"state":"running"},
      "turns":[{"id":"t1","prompt":"hello","status":"inProgress","createdAt":1,"reconnecting":true,"tokenUsage":{"total":12},
        "attachments":[{"id":"a1","name":"a.png","kind":"image","path":"/safe/a","size":12,"previewDigest":"abc"}],
        "items":[{"id":"tool","type":"commandExecution","command":"pwd","cwd":"/workspace","aggregatedOutput":"out","status":"running","progress":{"step":2},"sources":[{"url":"https://example.com"}]},
          {"id":"reason","type":"reasoning","summary":["one"],"content":[{"text":"reason","extra":true}]},
          {"id":"message","type":"agentMessage","text":"answer","citations":[{"url":"https://example.com/a"}],"generatedFiles":[{"id":"f1","name":"test.md","path":"/safe/f","state":"ready","content":"file","language":"markdown","capturedAt":7,"operation":"update","previousPath":"/old"}]}]}],
      "savedBranches":[{"id":"old","visited":1,"custom":true,"turns":[]}]
    }""")
    @Test fun roundTripRetainsStructuredFieldsAndDoesNotInventToolText() {
        val original = rawConversation(); val model = WireCodec.conversation(original); val result = WireCodec.conversation(model)
        val tool = result.getJSONArray("turns").getJSONObject(0).getJSONArray("items").getJSONObject(0)
        assertEquals("pwd", tool.getString("command")); assertEquals(2, tool.getJSONObject("progress").getInt("step")); assertFalse(tool.has("text"))
        assertTrue(result.getJSONArray("turns").getJSONObject(0).getBoolean("reconnecting"))
        val reasoning = result.getJSONArray("turns").getJSONObject(0).getJSONArray("items").getJSONObject(1)
        assertTrue(reasoning.getJSONArray("content").getJSONObject(0).getBoolean("extra")); assertFalse(reasoning.has("text"))
        assertTrue(result.getJSONArray("savedBranches").getJSONObject(0).getBoolean("custom"))
        assertEquals("abc", result.getJSONArray("turns").getJSONObject(0).getJSONArray("attachments").getJSONObject(0).getString("previewDigest"))
        val file = result.getJSONArray("turns").getJSONObject(0).getJSONArray("items").getJSONObject(2).getJSONArray("generatedFiles").getJSONObject(0)
        assertEquals("/old", file.getString("previousPath")); assertEquals(7, file.getInt("capturedAt"))
        assertEquals("running", result.getJSONObject("research").getString("state"))
    }
    @Test fun rawSnapshotsAreImmutableAndTypedUpdatesOverrideStaleRawArrays() {
        val json = rawConversation(); val c = WireCodec.conversation(json)
        json.put("title", "mutated externally")
        assertEquals("Rich", WireCodec.conversation(c).getString("title"))
        val result = WireCodec.conversation(c.copy(title = "new", turns = listOf(Turn("new", "hydrated")), savedBranches = emptyList(), slim = false))
        assertEquals("new", result.getString("title")); assertEquals("new", result.getJSONArray("turns").getJSONObject(0).getString("id")); assertEquals(0, result.getJSONArray("savedBranches").length())
    }
    @Test fun metadataDeltaCannotOverrideIdentityTurnsOrSlimAndKeepsUnknownFields() {
        val c = WireCodec.conversation(rawConversation()).copy(slim = true)
        val patched = WireCodec.mergeConversationPatch(c, JSONObject("""{"id":"evil","turns":[],"slim":false,"title":"new","activeBranchId":"b","research":{"state":"done"},"model":"m2"}"""))
        assertEquals(c.id, patched.id); assertEquals(c.turns, patched.turns); assertTrue(patched.slim); assertEquals("m2", patched.model); assertEquals("b", patched.activeBranchId)
        assertEquals("done", WireCodec.conversation(patched).getJSONObject("research").getString("state"))
    }
    @Test fun inFlightMutationKeepsNewMetadataFromBothSources() {
        val before = WireCodec.conversation(rawConversation())
        val current = WireCodec.mergeConversationPatch(before, JSONObject("""{"research":{"state":"done"},"model":"m2","providerId":"p2","projectId":"project"}"""))
        val returned = WireCodec.mergeConversationPatch(before, JSONObject("""{"serverAdded":42}"""))
        val merged = WireCodec.preserveObservedMetadata(before, current, returned, ConversationMutationReconciler.merge(before, current, returned))
        val result = WireCodec.conversation(merged)
        assertEquals("m2", result.getString("model")); assertEquals("p2", result.getString("providerId")); assertEquals("project", result.getString("projectId")); assertEquals(42, result.getInt("serverAdded")); assertEquals("done", result.getJSONObject("research").getString("state"))
    }
    @Test fun parserRejectsGenericRpcAndBadIds() {
        for (version in listOf("1.9", "\"1\"", "2")) assertFails { ConversationBridgePolicy.parse(JSONObject("""{"version":$version,"sessionId":"s","requestId":"1","type":"copyText","payload":{"text":"a"}}""")) }
        assertFails { ConversationBridgePolicy.parse(JSONObject("""{"version":1,"sessionId":"s","requestId":"1","type":"rpc","payload":{"method":"deleteConversation"}}""")) }
        assertFails { ConversationBridgePolicy.parse(JSONObject("""{"version":1,"sessionId":"s","requestId":"../bad","type":"copyText","payload":{"text":"hi"}}""")) }
        assertEquals(ConversationActionType.FEEDBACK, ConversationBridgePolicy.parse(JSONObject("""{"version":1,"sessionId":"s","requestId":"req:1","type":"replyFeedback","payload":{"conversationId":"c1","turnId":"t1","rating":null}}""")).type)
    }
    @Test fun textAndLinkScopeCannotEscapeCurrentConversation() {
        val c = WireCodec.conversation(rawConversation())
        ConversationBridgePolicy.requireCurrentText(c, "answer")
        assertFails { ConversationBridgePolicy.requireCurrentText(c, "unrelated clipboard payload") }
        assertEquals("https://example.com/", ConversationBridgePolicy.requireCurrentLink(c, "https://example.com/"))
        assertEquals("https://example.com/a", ConversationBridgePolicy.requireCurrentLink(c, "https://example.com/a"))
        assertFails { ConversationBridgePolicy.requireCurrentLink(c, "javascript:alert(1)") }
        assertFails { ConversationBridgePolicy.requireCurrentLink(c, "https://example.com/other") }
        assertFails { ConversationBridgePolicy.requireCurrentLink(c, "https://user:pass@example.com/a") }
    }
    @Test fun guardRejectsStreamingSlimCompactionAndNonChatMutations() {
        val c = WireCodec.conversation(rawConversation()); val t = c.turns.single()
        assertFails { ConversationBridgePolicy.requireEditable(c, t, false) }
        val idle = c.copy(turns = listOf(t.copy(status = TurnStatus.COMPLETED)))
        ConversationBridgePolicy.requireEditable(idle, idle.turns.single(), false)
        assertFails { ConversationBridgePolicy.requireEditable(idle.copy(slim = true), idle.turns.single(), false) }
        assertFails { ConversationBridgePolicy.requireEditable(idle.copy(mode = Mode.CODE), idle.turns.single(), false) }
        assertFails { ConversationBridgePolicy.requireEditable(idle, idle.turns.single().copy(compaction = true), false) }
        assertFails { ConversationBridgePolicy.requireEditable(idle, idle.turns.single(), true) }
    }
    @Test fun generatedIdentityResolvesExactCurrentDescriptor() {
        val c = WireCodec.conversation(rawConversation())
        val good = JSONObject("""{"artifactId":"generated:f1:undefined","sourcePath":"/safe/f"}""")
        assertEquals("f1", ConversationBridgePolicy.generatedFile(c, good)?.id)
        assertNull(ConversationBridgePolicy.generatedFile(c, JSONObject(good.toString()).put("sourcePath", "/etc/passwd")))
        assertNull(ConversationBridgePolicy.generatedFile(c, JSONObject(good.toString()).put("sourceDigest", "forged")))
    }
    @Test fun fencesResolveFromNativeTextWithoutAcceptingSuppliedHtml() {
        val c = Conversation("c", "Code", providerId = "p", model = "m", turns = listOf(Turn("t", "", items = listOf(Item("i:1", "agentMessage", "```html\n<p>Hi</p>\n```\n```ts\nconst a = 1\n```")))))
        assertEquals("const a = 1\n", ConversationBridgePolicy.fenceArtifact(c, "fence:i:1:1")?.content)
        assertNull(ConversationBridgePolicy.fenceArtifact(c, "fence:i:1:2")); assertNull(ConversationBridgePolicy.fenceArtifact(c, "fence:other:0"))
    }
    @Test fun quoteSelectionAcceptsBoundedRenderedMarkdownButNotOtherTurnsOrMetadata() {
        val c = Conversation("c", "Secret title", providerId = "p", model = "m", turns = listOf(Turn("t", "prompt only", items = listOf(Item("i", "agentMessage", "**Hello** world\n\nA [link](https://example.com) and ~~removed~~ text")))))
        ConversationBridgePolicy.requireQuotedText(c, "Hello world")
        ConversationBridgePolicy.requireQuotedText(c, "A link and removed text")
        assertFails { ConversationBridgePolicy.requireQuotedText(c, "Secret title") }
        assertFails { ConversationBridgePolicy.requireQuotedText(c, "prompt only") }
        assertFails { ConversationBridgePolicy.requireCurrentText(c, "Hello world") }
    }
    @Test fun remoteImagesRejectPrivateLiteralAndLocalHosts() {
        fun c(url: String) = Conversation("c", "c", providerId = "p", model = "m", turns = listOf(Turn("t", "", items = listOf(Item("i", "agentMessage", "![]($url)")))))
        for (url in listOf("http://127.0.0.1/a", "http://10.1.2.3/a", "http://host.local/a", "http://localhost/a", "http://[::1]/a")) assertFails { ConversationBridgePolicy.requireRemoteImageUrl(c(url), url) }
        assertEquals("https://example.com/a.png", ConversationBridgePolicy.requireRemoteImageUrl(c("https://example.com/a.png"), "https://example.com/a.png"))
    }
    @Test fun preservesRealToolTextAndIntentionalEmptyReasoningText() {
        val c = rawConversation()
        c.getJSONArray("turns").getJSONObject(0).getJSONArray("items").getJSONObject(0).put("text", "label")
        c.getJSONArray("turns").getJSONObject(0).getJSONArray("items").getJSONObject(1).put("text", "")
        val result = WireCodec.conversation(WireCodec.conversation(c)).getJSONArray("turns").getJSONObject(0).getJSONArray("items")
        assertEquals("label", result.getJSONObject(0).getString("text")); assertEquals("", result.getJSONObject(1).getString("text"))
    }
    @Test fun copyToolbarUsesCanonicalDoubleNewlineForMultipleMessages() {
        val c = Conversation("c", "c", providerId = "p", model = "m", turns = listOf(Turn("t", "", items = listOf(Item("a", "agentMessage", "first"), Item("b", "agentMessage", "second")))))
        ConversationBridgePolicy.requireCurrentText(c, "first\n\nsecond")
        assertFails { ConversationBridgePolicy.requireCurrentText(c, "first\n\nforged") }
    }
    @Test fun staleAccountActionCannotUnlockNewSameIdOperation() {
        val locks = ConversationActionLocks(); val old = locks.start("same-id")!!
        locks.clear(); val current = locks.start("same-id")!!
        locks.finish("same-id", old); assertEquals(setOf("same-id"), locks.ids)
        assertNull(locks.start("same-id")); locks.finish("same-id", current); assertTrue(locks.ids.isEmpty())
    }
    @Test fun planAndReasoningFencesResolveIndependently() {
        val c = presentation("x").conversation.copy(turns = listOf(Turn("t", "", items = listOf(
            Item("plan", "plan", "```json\n{}\n```"),
            Item("reason", "reasoning", rawJson = JSONObject().put("summary", org.json.JSONArray(listOf("```txt\nsummary\n```"))).toString())
        ))))
        assertEquals("{}\n", ConversationBridgePolicy.fenceArtifact(c, "fence:plan:0")?.content)
        assertEquals("summary\n", ConversationBridgePolicy.fenceArtifact(c, "fence-summary:reason:0")?.content)
        assertNull(ConversationBridgePolicy.fenceArtifact(c, "fence:reason:0"))
    }
    @Test fun urlsUseBrowserEquivalentNormalizationWithoutBroadeningScope() {
        val c = presentation("[Unicode](HTTPS://example.com/中文) [balanced](https://example.com/a(b)) [idn](https://例子.com/path)").conversation
        ConversationBridgePolicy.requireCurrentLink(c, "https://example.com/%E4%B8%AD%E6%96%87")
        ConversationBridgePolicy.requireCurrentLink(c, "https://example.com/a(b)")
        ConversationBridgePolicy.requireCurrentLink(c, "https://xn--fsqu00a.com/path")
        assertFails { ConversationBridgePolicy.requireCurrentLink(c, "https://example.com/a(b)/forged") }
    }
    @Test fun unchangedMediaIsNotResentOnEachStreamingTokenAndRemovalsResetState() {
        val old = presentation("a").copy(media = ConversationMedia(mapOf("a" to "data:image/png;base64,eA==")))
        val next = presentation("ab").copy(media = old.media)
        assertFalse(conversationDelivery(old, next, "s", 1, 2).body.has("media"))
        val cleared = conversationDelivery(old, next.copy(media = ConversationMedia()), "s", 1, 2)
        assertEquals("update", cleared.method); assertEquals(0, cleared.body.getJSONObject("media").getJSONObject("attachmentPreviews").length())
    }
    @Test fun onlyExactLocalTopFrameReceivesNativeCapabilities() {
        val origin = ConversationBridgePolicy.ORIGIN; val entry = ConversationBridgePolicy.ENTRY
        assertTrue(ConversationBridgePolicy.acceptsFrame(origin, true, entry))
        assertFalse(ConversationBridgePolicy.acceptsFrame(origin, false, entry))
        assertFalse(ConversationBridgePolicy.acceptsFrame("https://evil.example", true, entry))
        assertFalse(ConversationBridgePolicy.acceptsFrame("$origin.evil.example", true, entry))
        assertFalse(ConversationBridgePolicy.acceptsFrame("$origin/conversation", true, entry))
        assertFalse(ConversationBridgePolicy.acceptsFrame(origin, true, "https://evil.example"))
    }
    @Test fun longHistoryTokenUpdateContainsOnlyNewText() {
        val old = presentation("initial").let { value -> value.copy(conversation = value.conversation.copy(turns = (0 until 300).map { n -> Turn("t$n", "prompt", items = listOf(Item("i$n", "agentMessage", "x".repeat(4000))), createdAt = n.toLong()) })) }
        val last = old.conversation.turns.last()
        val next = old.copy(conversation = old.conversation.copy(turns = old.conversation.turns.dropLast(1) + last.copy(items = listOf(last.items.single().copy(text = last.items.single().text + "tail")))))
        val change = conversationDelivery(old, next, "s", 1, 2)
        assertEquals("update", change.method); assertTrue(change.body.toString().length < 1024)
        assertEquals("tail", change.body.getJSONArray("changes").getJSONObject(0).getString("text"))
        val raw = WireCodec.conversation(WireCodec.conversation(old.conversation))
        assertFalse(raw.rawJson!!.contains("xxxx")); assertFalse(raw.turns.last().rawJson!!.contains("xxxx"))
    }
    @Test fun continuationUsesOnlyCurrentIdleLengthStoppedTurnInEverySupportedMode() {
        val turn = Turn("last", "", status = TurnStatus.FAILED, rawJson = "{\"stopReason\":\"length\"}")
        for (mode in Mode.entries) {
            val c = Conversation("c", "", mode, providerId = "p", model = "m", turns = listOf(turn))
            ConversationBridgePolicy.requireContinuable(c, false)
            assertFails { ConversationBridgePolicy.requireContinuable(c.copy(turns = c.turns + Turn("new", "complete")), false) }
            assertFails { ConversationBridgePolicy.requireContinuable(c.copy(slim = true), false) }
            assertFails { ConversationBridgePolicy.requireContinuable(c, true) }
        }
    }
    @Test fun canceledPickerReservationCannotBeReassignedToNewBytes() {
        val slots = NativePickerReservation<Any>(); val first = Any(); val next = Any()
        slots.reserve(first)
        // Canceling the bridge Deferred deliberately does not release the OS activity's reservation.
        assertFails { slots.reserve(next) }; slots.abortBeforeLaunch(next); assertSame(first, slots.pending)
        assertSame(first, slots.takeResult()); assertNull(slots.takeResult())
        slots.reserve(next); assertSame(next, slots.takeResult())
    }
    @Test fun batchDownloadValidatesWholeBoundedIdentityListBeforeSaving() {
        val c = WireCodec.conversation(rawConversation())
        val file = JSONObject("""{"conversationId":"c1","artifactId":"generated:f1:undefined"}""")
        fun batch(values: List<JSONObject>) = JSONObject().put("conversationId", "c1").put("files", org.json.JSONArray(values))
        assertEquals(1, ConversationBridgePolicy.downloadIdentities(c, batch(listOf(file))).size)
        assertFails { ConversationBridgePolicy.downloadIdentities(c, batch(emptyList())) }
        assertFails { ConversationBridgePolicy.downloadIdentities(c, batch(List(33) { file })) }
        assertFails { ConversationBridgePolicy.downloadIdentities(c, batch(listOf(file, JSONObject(file.toString()).put("sourcePath", "/safe/f")))) }
        assertFails { ConversationBridgePolicy.downloadIdentities(c, batch(listOf(JSONObject(file.toString()).put("conversationId", "other")))) }
        assertFails { ConversationBridgePolicy.downloadIdentities(c, batch(listOf(JSONObject(file.toString()).put("artifactId", "forged")))) }
    }
    // A fixed creation time: two calls a millisecond apart must not differ in metadata.
    private fun presentation(text: String) = ConversationPresentation(Conversation("c", "Chat", providerId = "p", model = "m", createdAt = 1, turns = listOf(Turn("t", "p", items = listOf(Item("i", "agentMessage", text)), createdAt = 1))), false, emptyMap(), false)
    @Test fun initialStateRendersAndTextStreamingAppendsWithoutCopyingWholeHistory() {
        val old = presentation("hello"); val next = presentation("hello world")
        assertEquals("render", conversationDelivery(null, old, "s", 0, 1).method)
        assertEquals("zh-CN", conversationDelivery(null, old, "s", 0, 1).body.getString("locale"))
        val delta = conversationDelivery(old, next, "s", 1, 2)
        assertEquals("update", delta.method); assertEquals(1, delta.body.getInt("baseRevision"))
        val change = delta.body.getJSONArray("changes").getJSONObject(0)
        assertEquals("appendItemText", change.getString("type")); assertEquals(" world", change.getString("text"))
        assertEquals("hello world", next.conversation.turns.single().items.single().text)
    }
    @Test fun lifecycleChangesUpsertAndBranchMetadataTriggersRender() {
        val old = presentation("hello")
        val changed = old.copy(conversation = old.conversation.copy(turns = old.conversation.turns.map { it.copy(status = TurnStatus.FAILED, error = "offline") }))
        assertEquals("upsertTurn", conversationDelivery(old, changed, "s", 1, 2).body.getJSONArray("changes").getJSONObject(0).getString("type"))
        assertEquals("render", conversationDelivery(old, old.copy(conversation = old.conversation.copy(activeBranchId = "other")), "s", 1, 2).method)
    }
    private fun confirmationHost(answer: suspend () -> Boolean) = object : ConversationNativeActions {
        override suspend fun confirm(title: String, message: String) = answer()
        override fun copy(text: String) = error("No side effect expected")
        override suspend fun download(name: String, mime: String, bytes: ByteArray): String? = error("No export expected")
        override fun navigate(route: String) = error("No navigation expected")
        override fun openLink(url: String) = error("No external intent expected")
    }
    @Test fun explicitDeclineIsTypedAndPreventsMutation() = runTest {
        var mutationCount = 0
        val error = assertFailsWith<ConversationUserDeclinedException> {
            confirmationHost { false }.confirmOrDecline("Retry", "Confirm")
            mutationCount++
        }
        assertEquals(0, mutationCount)
        assertEquals("userDeclined", conversationCancellationReason(error))
    }
    @Test fun acceptedConfirmationAllowsContinuationOnce() = runTest {
        var count = 0
        confirmationHost { true }.confirmOrDecline("Retry", "Confirm")
        count++
        assertEquals(1, count)
    }
    @Test fun lifecycleCancellationAndLookalikeTextAreNotUserDecline() = runTest {
        val lifecycle = CancellationException("已取消")
        val error = assertFailsWith<CancellationException> {
            confirmationHost { throw lifecycle }.confirmOrDecline("Retry", "Confirm")
        }
        assertSame(lifecycle, error)
        assertNull(conversationCancellationReason(error))
        assertNull(conversationCancellationReason(CancellationException("Action cancelled")))
    }
    @Test fun concurrentScopeCancellationWinsOverFalseConfirmation() = runTest {
        var observed: CancellationException? = null
        val child = launch {
            try {
                confirmationHost {
                    currentCoroutineContext().cancel(CancellationException("view disposed"))
                    false
                }.confirmOrDecline("Retry", "Confirm")
            } catch (error: CancellationException) { observed = error }
        }
        child.join()
        assertNotNull(observed)
        assertNull(conversationCancellationReason(observed!!))
    }
    @Test fun concurrentScopeCancellationAlsoPreventsAcceptedContinuation() = runTest {
        var mutations = 0
        val child = launch {
            try {
                confirmationHost { currentCoroutineContext().cancel(); true }.confirmOrDecline("Retry", "Confirm")
                mutations++
            } catch (_: CancellationException) { }
        }
        child.join()
        assertEquals(0, mutations)
    }
    @Test fun realConfirmationFailureIsNotConvertedToCancellation() = runTest {
        val original = IllegalStateException("native UI unavailable")
        val error = assertFailsWith<IllegalStateException> {
            confirmationHost { throw original }.confirmOrDecline("Retry", "Confirm")
        }
        assertSame(original, error)
    }

    @Test fun idleRollbackQueuesBehindBusyInFlightEvenWhenEqualToOldApplied() {
        val idle = presentation("done"); val busy = idle.copy(sending = true)
        assertTrue(shouldQueueConversationPresentation(idle, null, busy, idle))
        // Reproduce the old optimization that lost this exact rollback.
        fun oldWouldQueue(next: ConversationPresentation, pending: ConversationPresentation?, flight: ConversationPresentation?, applied: ConversationPresentation?) =
            !(next == pending || (pending == null && (next == flight || next == applied)))
        assertFalse(oldWouldQueue(idle, null, busy, idle))
        assertTrue(isCurrentConversationAcknowledgement(12, 12))
        val rollback = conversationDelivery(busy, idle, "lease", 12, 13)
        assertEquals("update", rollback.method)
        assertFalse(rollback.body.getBoolean("sending"))
        assertEquals(0, rollback.body.getJSONArray("changes").length())
    }
    @Test fun identicalNewestStateDeduplicatesWithoutUsingOlderAppliedState() {
        val idle = presentation("done"); val busy = idle.copy(sending = true)
        assertFalse(shouldQueueConversationPresentation(busy, null, busy, idle))
        assertFalse(shouldQueueConversationPresentation(idle, idle, busy, idle))
        assertFalse(shouldQueueConversationPresentation(idle, null, null, idle))
        assertTrue(shouldQueueConversationPresentation(busy, idle, busy, idle))
        assertTrue(shouldQueueConversationPresentation(idle.copy(dark = true), idle, busy, idle))
    }
    @Test fun staleAcknowledgementCannotRetireNewFlightOrPendingRollback() {
        val idle = presentation("done"); val busy = idle.copy(sending = true)
        var applied = idle
        var flight: Pair<Long, ConversationPresentation>? = 12L to busy
        var pending: ConversationPresentation? = idle
        fun acknowledge(revision: Long) {
            if (!isCurrentConversationAcknowledgement(revision, flight?.first)) return
            applied = flight!!.second
            flight = null
            // The native controller retains pending until its next flush.
        }
        acknowledge(11)
        assertEquals(12L, flight?.first); assertEquals(idle, applied); assertEquals(idle, pending)
        acknowledge(12)
        assertNull(flight); assertEquals(busy, applied); assertEquals(idle, pending)
        flight = 13L to pending!!; pending = null
        acknowledge(12)
        assertEquals(13L, flight?.first); assertEquals(busy, applied)
        acknowledge(13)
        assertNull(flight); assertEquals(idle, applied)
        assertFalse(isCurrentConversationAcknowledgement(0, null))
        assertFalse(isCurrentConversationAcknowledgement(-1, null))
    }

}
