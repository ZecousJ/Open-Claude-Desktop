package com.claudex.core

import kotlin.test.*

class ComposerQueueTest {
    private fun input(id: String, text: String = "synthetic") = SendInput(id, text, Mode.CHAT, ModelOption("m", "m", "", "p"), emptyList())
    private fun conversation(id: String, running: Boolean = false, slim: Boolean = false) = Conversation(id, id, providerId = "p", model = "m", slim = slim,
        turns = listOf(Turn("turn", "synthetic", status = if (running) TurnStatus.IN_PROGRESS else TurnStatus.COMPLETED)))
    private fun queue() = ComposerQueue().apply { activate(1) }
    private fun add(book: ComposerQueue, id: String) = book.add(1, input(id))!!
    @Test fun distinctConversationsClaimIndependentlyAndNeverCrossTargets() {
        val q = queue(); val a = add(q, "a"); val b = add(q, "b")
        q.update(1, a.copy(state = QueuedState.QUEUED)); q.update(1, b.copy(state = QueuedState.QUEUED))
        assertEquals("b", q.takeNext(1, conversation("b"))!!.input.conversationId)
        assertEquals("a", q.takeNext(1, conversation("a"))!!.input.conversationId)
        assertNull(q.takeNext(1, conversation("a")))
    }
    @Test fun acceptedMessageWaitsForClientIdReceiptAndLeavesQueueExactlyOnce() {
        val q = queue(); val e = add(q, "a"); q.update(1, e.copy(state = QueuedState.STEERED, messageId = "receipt"))
        q.reconcile(1, conversation("a", true), setOf("unrelated")); assertEquals(1, q.snapshot()["a"]!!.size)
        q.reconcile(1, conversation("a", true), setOf("receipt")); assertTrue(q.snapshot().isEmpty())
        q.reconcile(1, conversation("a"), emptySet()); assertNull(q.takeNext(1, conversation("a")))
    }
    @Test fun knownAcceptedButUnreadMessageBecomesNextTurnOnlyWithCompleteTerminalRecord() {
        val q = queue(); val e = add(q, "a"); q.update(1, e.copy(state = QueuedState.STEERED, messageId = "receipt"))
        q.reconcile(1, conversation("a", slim = true), emptySet()); assertNull(q.takeNext(1, conversation("a", slim = true)))
        assertEquals(QueuedState.STEERED, q.snapshot()["a"]!!.single().state)
        q.reconcile(1, conversation("a"), emptySet()); assertNotNull(q.takeNext(1, conversation("a")))
    }
    @Test fun failureHoldsFifoWithoutAutomaticMutationReplay() {
        val q = queue(); val first = add(q, "a"); q.update(1, first.copy(state = QueuedState.QUEUED))
        val second = add(q, "a"); q.update(1, second.copy(state = QueuedState.QUEUED))
        val sent = q.takeNext(1, conversation("a"))!!
        q.update(1, sent.copy(state = QueuedState.QUEUED, error = "uncertain result"))
        repeat(10) { assertNull(q.takeNext(1, conversation("a"))) }
        assertEquals(listOf(first.id, second.id), q.snapshot()["a"]!!.map { it.id })
        q.remove(1, "a", first.id); assertEquals(second.id, q.takeNext(1, conversation("a"))!!.id)
    }
    @Test fun accountChangeRejectsOldCompletionsAndKeepsNewAccountEntries() {
        val q = queue(); val old = add(q, "a"); q.activate(2)
        val current = q.add(2, input("a", "new account"))!!
        assertFalse(q.update(1, old.copy(state = QueuedState.QUEUED)))
        assertNull(q.remove(1, "a", current.id)); assertFalse(q.contains(1, "a", old.id))
        assertEquals("new account", q.snapshot()["a"]!!.single().input.text)
    }
    @Test fun logoutClearAlsoRejectsAnOldCompletionBeforeAccountGenerationChanges() {
        val q = queue(); val old = add(q, "a"); q.clear()
        val newDraft = add(q, "a")
        assertFalse(q.contains(1, "a", old.id)); assertFalse(q.update(1, old.copy(state = QueuedState.QUEUED)))
        assertEquals(newDraft.id, q.snapshot()["a"]!!.single().id)
    }
    @Test fun partialReceiptCannotCauseUnknownDeliveryToBeResent() {
        val q = queue(); val e = add(q, "a"); q.update(1, e.copy(state = QueuedState.STEERED, messageId = "receipt"))
        q.reconcile(1, conversation("a", slim = true), setOf("receipt"))
        assertEquals(e.id, q.snapshot()["a"]!!.single().id); assertNull(q.takeNext(1, conversation("a", slim = true)))
    }
    @Test fun runningAndSubmittingStatesPreventDuplicateClaims() {
        val q = queue(); val e = add(q, "a")
        assertNull(q.add(1, input("a"))); assertNull(q.takeNext(1, conversation("a")))
        q.update(1, e.copy(state = QueuedState.QUEUED)); assertNull(q.takeNext(1, conversation("a", true)))
        assertNotNull(q.takeNext(1, conversation("a"))); assertNull(q.takeNext(1, conversation("a")))
    }
    @Test fun failedDraftRestorationKeepsNewTypingAndBothAttachmentSets() {
        val a = Attachment("a", "a.txt", "synthetic", "document", 1)
        val b = a.copy(id = "b", name = "b.txt")
        val restored = restoreQueuedDraft(QueuedDraft("original instruction", listOf(a)), QueuedDraft("new typing", listOf(a, b)))
        assertEquals("original instruction\nnew typing", restored.text)
        assertEquals(listOf("a", "b"), restored.attachments.map { it.id })
        assertEquals("original instruction", restoreQueuedDraft(QueuedDraft("original instruction", emptyList()), QueuedDraft("original instruction", emptyList())).text)
    }
}
