package com.claudex.mobile

import com.claudex.core.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.json.JSONObject

/** Scoped ordinary composer work, not a generic renderer RPC or retry mechanism. */
internal class QueuedComposer(private val api: NativeApi, private val repository: ClaudexRepository,
    private val scope: CoroutineScope, private val authenticated: () -> Boolean) {
    private val book = ComposerQueue()
    private val jobs = mutableMapOf<String, Job>()
    private var demoSummary = ""
    val messages = MutableStateFlow<Map<String, List<QueuedMessage>>>(emptyMap())
    init {
        book.activate(api.sessionGeneration)
        scope.launch { repository.snapshot.collect { reconcile(it) } }
        scope.launch { api.authenticated.collect { if (!book.accepts(api.sessionGeneration)) clear() } }
    }
    private fun launchTracked(key: String, block: suspend CoroutineScope.() -> Unit) {
        // Main.immediate can finish a local operation inline: register it before starting.
        val job = scope.launch(start = CoroutineStart.LAZY, block = block)
        jobs[key] = job
        job.start()
    }
    private fun valid(generation: Long, entry: QueuedMessage) = authenticated() && api.sessionGeneration == generation && book.contains(generation, entry.conversationId, entry.id)
    private fun publish() {
        val current = book.snapshot()
        messages.value = current
        if (BuildConfig.DEMO_MODE) {
            val summary = current.values.flatten().joinToString { "${it.conversationId}:${it.id}:${it.state}:error=${it.error != null}" }
            if (summary != demoSummary) { android.util.Log.i("ClaudexQueue", summary.ifEmpty { "empty" }); demoSummary = summary }
        }
    }
    fun submitting(conversationId: String?) = book.snapshot()[conversationId].orEmpty().any { it.state == QueuedState.SUBMITTING || it.state == QueuedState.SENDING }
    fun clear() { jobs.values.toList().forEach(Job::cancel); jobs.clear(); book.clear(); book.activate(api.sessionGeneration); publish() }
    private fun reconcile(snapshot: Snapshot) {
        val generation = api.sessionGeneration
        if (!book.accepts(generation)) { clear(); book.activate(generation) }
        if (!authenticated()) { clear(); return }
        snapshot.conversations.forEach { c ->
            val delivered = c.turns.flatMap { it.items }.mapNotNull { item ->
                if (item.type != "userMessage") null else runCatching {
                    val raw = JSONObject(item.rawJson ?: "{}")
                    raw.optString("clientId").takeIf { raw.optBoolean("steered") && it.isNotBlank() }
                }.getOrNull()
            }.toSet()
            book.reconcile(generation, c, delivered)
            val next = book.takeNext(generation, c)
            if (next != null) launchTracked("send:${next.id}") {
                try {
                    if (!valid(generation, next)) return@launchTracked
                    val sentId = api.withCurrentSession { repository.send(next.input) }; require(sentId == c.id)
                    if (valid(generation, next)) book.remove(generation, c.id, next.id)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (valid(generation, next)) book.update(generation, next.copy(state = QueuedState.QUEUED,
                        error = error.message ?: UserText.get(R.string.claudex_msg_send_unconfirmed)))
                } finally { jobs.remove("send:${next.id}"); publish(); if (authenticated() && api.sessionGeneration == generation) reconcile(repository.snapshot.value) }
            }
        }
        publish()
    }
    fun submit(input: SendInput, upload: suspend () -> List<Attachment>, failed: (String) -> Unit): Boolean {
        val generation = api.sessionGeneration
        if (!authenticated()) return false
        if (!book.accepts(generation)) clear()
        val entry = book.add(generation, input) ?: return false
        publish()
        launchTracked("steer:${entry.id}") {
            try {
                api.withCurrentSession {
                    if (!valid(generation, entry)) return@withCurrentSession
                    val attachments = upload()
                    if (!valid(generation, entry)) return@withCurrentSession
                    val result = repository.steerTurn(entry.conversationId, input.text, attachments)
                    if (valid(generation, entry)) book.update(generation, entry.copy(input = input.copy(attachments = attachments),
                        state = if (result == null) QueuedState.QUEUED else QueuedState.STEERED, messageId = result?.messageId))
                }
                if (valid(generation, entry)) reconcile(repository.snapshot.value)
            } catch (cancelled: CancellationException) { if (valid(generation, entry)) { book.remove(generation, entry.conversationId, entry.id); failed(UserText.get(R.string.claudex_msg_steer_unconfirmed)) }; throw cancelled }
            catch (error: Exception) { if (valid(generation, entry)) { book.remove(generation, entry.conversationId, entry.id); failed(error.message ?: UserText.get(R.string.claudex_msg_steer_unconfirmed)) } }
            finally { jobs.remove("steer:${entry.id}"); publish() }
        }
        return true
    }
    fun remove(conversationId: String, id: String): QueuedMessage? {
        val entry = messages.value[conversationId]?.find { it.id == id } ?: return null
        if (entry.state != QueuedState.QUEUED) return null
        return book.remove(api.sessionGeneration, conversationId, id).also { publish() }
    }
    fun sendNow(conversationId: String, id: String) {
        val generation = api.sessionGeneration
        val entry = messages.value[conversationId]?.find { it.id == id && it.state == QueuedState.QUEUED && it.error == null } ?: return
        if (!valid(generation, entry)) return
        book.update(generation, entry.copy(state = QueuedState.SUBMITTING)); publish()
        launchTracked("steer:${entry.id}") {
            try {
                val result = api.withCurrentSession { repository.steerTurn(conversationId, entry.input.text, entry.input.attachments) }
                if (valid(generation, entry)) book.update(generation, entry.copy(
                    state = if (result == null) QueuedState.QUEUED else QueuedState.STEERED,
                    messageId = result?.messageId, error = if (result == null) UserText.get(R.string.claudex_msg_queued_not_sent) else null))
                if (valid(generation, entry)) reconcile(repository.snapshot.value)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (valid(generation, entry)) book.update(generation, entry.copy(state = QueuedState.QUEUED, error = error.message ?: UserText.get(R.string.claudex_msg_steer_unconfirmed))) }
            finally { jobs.remove("steer:${entry.id}"); publish() }
        }
    }
}
