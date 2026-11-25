package com.claudex.core

enum class QueuedState { SUBMITTING, QUEUED, STEERED, SENDING }
data class QueuedMessage(val id: String, val conversationId: String, val input: SendInput,
    val state: QueuedState = QueuedState.SUBMITTING, val messageId: String? = null, val error: String? = null)
data class SteerResult(val messageId: String, val conversation: Conversation)
data class QueuedDraft(val text: String, val attachments: List<Attachment>)
fun restoreQueuedDraft(original: QueuedDraft, current: QueuedDraft): QueuedDraft = QueuedDraft(
    if (current.text.isBlank() || current.text == original.text) original.text else "${original.text}\n${current.text}",
    (original.attachments + current.attachments).distinctBy { it.id })

/** Window-lifetime state, isolated by account generation and conversation, never persisted. */
class ComposerQueue {
    private var generation = Long.MIN_VALUE
    private val entries = linkedMapOf<String, List<QueuedMessage>>()
    fun activate(next: Long) { if (next != generation) { entries.clear(); generation = next } }
    fun clear() { entries.clear() }
    fun snapshot(): Map<String, List<QueuedMessage>> = entries.toMap()
    fun accepts(expected: Long) = generation == expected
    fun contains(expected: Long, conversationId: String, id: String) = accepts(expected) && entries[conversationId].orEmpty().any { it.id == id }
    fun add(expected: Long, input: SendInput): QueuedMessage? {
        if (!accepts(expected)) return null
        val id = requireNotNull(input.conversationId)
        if (entries.values.sumOf { it.size } >= 64) return null
        if (entries[id].orEmpty().any { it.state == QueuedState.SUBMITTING }) return null
        val entry = QueuedMessage(newId(), id, input)
        entries[id] = entries[id].orEmpty() + entry
        return entry
    }
    fun update(expected: Long, entry: QueuedMessage): Boolean {
        if (!accepts(expected) || entries[entry.conversationId].orEmpty().none { it.id == entry.id }) return false
        entries[entry.conversationId] = entries[entry.conversationId].orEmpty().map { if (it.id == entry.id) entry else it }
        return true
    }
    fun remove(expected: Long, conversationId: String, id: String): QueuedMessage? {
        if (!accepts(expected)) return null
        val old = entries[conversationId].orEmpty()
        val removed = old.find { it.id == id } ?: return null
        val next = old.filterNot { it.id == id }
        if (next.isEmpty()) entries.remove(conversationId) else entries[conversationId] = next
        return removed
    }
    fun reconcile(expected: Long, conversation: Conversation, delivered: Set<String>) {
        if (!accepts(expected) || conversation.slim) return
        val running = conversation.turns.any { it.status == TurnStatus.IN_PROGRESS }
        val next = entries[conversation.id].orEmpty().mapNotNull { entry ->
            when {
                entry.state != QueuedState.STEERED -> entry
                entry.messageId in delivered -> null
                !running -> entry.copy(state = QueuedState.QUEUED)
                else -> entry
            }
        }
        if (next.isEmpty()) entries.remove(conversation.id) else entries[conversation.id] = next
    }
    /** Claims exactly one next message. Errors hold order; snapshot notifications cannot replay a claim. */
    fun takeNext(expected: Long, conversation: Conversation): QueuedMessage? {
        if (!accepts(expected) || conversation.slim || conversation.turns.any { it.status == TurnStatus.IN_PROGRESS }) return null
        val queue = entries[conversation.id].orEmpty()
        if (queue.any { it.state != QueuedState.QUEUED }) return null
        val first = queue.firstOrNull()?.takeIf { it.error == null } ?: return null
        val sending = first.copy(state = QueuedState.SENDING)
        update(expected, sending)
        return sending
    }
}
