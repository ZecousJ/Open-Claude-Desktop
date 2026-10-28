package com.claudex.mobile

import com.claudex.core.*
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** An explicit allowlist, never a JS-to-RPC method proxy. Payloads are re-resolved against current native state. */
internal enum class ConversationActionType(val wire: String) {
    COPY("copyText"), EDIT("editPrompt"), RETRY("retryResponse"), VERSION("selectVersion"),
    FEEDBACK("replyFeedback"), CONTINUE("continueResponse"), QUOTE("quoteReply"),
    ATTACHMENT("openAttachment"), ARTIFACT("openArtifact"), DOWNLOAD("downloadArtifact"), DOWNLOADS("downloadArtifacts"),
    LINK("openLink"), LOAD_IMAGE("loadRemoteImage"), WORKFLOW("openWorkflow"), AGENT("openAgent"), PLAN("openPlan"), CHANGES("openChanges")
}
internal data class ConversationAction(val sessionId: String, val requestId: String, val type: ConversationActionType, val payloadJson: String) {
    val payload get() = JSONObject(payloadJson)
}
internal data class ConversationLease(val id: String, val conversationId: String, val generation: Long)
internal object ConversationBridgePolicy {
    const val VERSION = 1
    const val ORIGIN = "https://appassets.androidplatform.net"
    const val ENTRY = "$ORIGIN/conversation/index.html"
    fun acceptsFrame(origin: String, mainFrame: Boolean, currentUrl: String?): Boolean = mainFrame && origin in setOf(ORIGIN, "$ORIGIN/") && currentUrl == ENTRY
    const val MAX_MESSAGE_CHARS = 2_100_000
    const val MAX_TEXT_CHARS = 1_000_000
    private val requestId = Regex("[A-Za-z0-9._:-]{1,128}")
    fun parse(j: JSONObject): ConversationAction {
        require(j.opt("version") == VERSION) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        val session = j.getString("sessionId"); require(session.length in 1..128)
        val id = j.getString("requestId"); require(requestId.matches(id)) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        val type = ConversationActionType.entries.find { it.wire == j.getString("type") } ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
        val p = j.getJSONObject("payload")
        return ConversationAction(session, id, type, p.toString())
    }
    fun requestId(j: JSONObject): String? = (j.opt("requestId") as? String)?.takeIf(requestId::matches)
    fun id(p: JSONObject, key: String): String = p.getString(key).also { require(it.isNotEmpty() && it.length <= 1000) { UserText.get(R.string.generic_error_something_went_wrong_try_again) } }
    fun text(p: JSONObject, key: String = "text"): String = p.getString(key).also { require(it.isNotBlank() && it.length <= MAX_TEXT_CHARS) { UserText.get(R.string.generic_error_something_went_wrong_try_again) } }
    fun turn(c: Conversation, p: JSONObject): Turn = c.turns.find { it.id == id(p, "turnId") } ?: error(UserText.get(R.string.claudex_msg_reply_changed))
    fun requireIdle(c: Conversation, busy: Boolean) {
        require(!busy && !c.slim && c.turns.none { it.status == TurnStatus.IN_PROGRESS }) { UserText.get(R.string.claudex_msg_wait_reply) }
    }
    fun requireContinuable(c: Conversation, busy: Boolean) {
        requireIdle(c, busy)
        val latest = c.turns.lastOrNull() ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
        require(JSONObject(latest.rawJson ?: "{}").optString("stopReason") == "length") { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
    }
    fun requireEditable(c: Conversation, t: Turn, busy: Boolean) {
        requireIdle(c, busy); require(c.mode == Mode.CHAT && !t.compaction) { UserText.get(R.string.claudex_msg_branch_unsupported) }
    }
    private fun strings(value: Any?): Sequence<String> = when (value) {
        is String -> sequenceOf(value)
        is JSONObject -> value.keys().asSequence().flatMap { strings(value.opt(it)) }
        is JSONArray -> (0 until value.length()).asSequence().flatMap { strings(value.opt(it)) }
        else -> emptySequence()
    }
    fun requireCurrentText(c: Conversation, text: String) {
        val normalized = text.replace("\r\n", "\n").trim()
        require(normalized.isNotEmpty() && normalized.length <= MAX_TEXT_CHARS)
        val messages = c.turns.flatMap { it.items }.filter { it.type == "agentMessage" }.joinToString("\n") { it.text }
        require(messages.contains(normalized) || c.turns.any { turn -> turn.items.filter { it.type == "agentMessage" }.joinToString("\n\n") { it.text }.contains(normalized) } || strings(WireCodec.conversation(c)).any { it.replace("\r\n", "\n").contains(normalized) }) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
    }
    fun requireQuotedText(c: Conversation, text: String) {
        require(text.isNotBlank() && text.length <= MAX_TEXT_CHARS)
        fun normalized(value: String) = value.replace(Regex("[\\s\u00a0]+"), " ").trim()
        fun plain(source: String): String = Markdown.blocks(source).joinToString("\n") { block ->
            val content = if (block.kind == "table") block.rows.flatten().joinToString(" ") else block.text
            if (block.kind in setOf("code", "math")) content else {
                var visible = content
                repeat(3) { visible = Markdown.spans(visible).joinToString("") { it.text } }
                visible.replace(Regex("~~([^~]+)~~"), "$1").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
            }
        }
        val selected = normalized(text)
        require(c.turns.flatMap { it.items }.filter { it.type == "agentMessage" }.any { normalized(it.text).contains(selected) || normalized(plain(it.text)).contains(selected) }) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
    }
    private fun normalizedLink(value: String): String {
        require(value.length <= 8192 && value.none { it <= ' ' || it == '\\' })
        val uri = URI(value).normalize()
        val scheme = uri.scheme?.lowercase()
        require(scheme in setOf("https", "http") && !uri.rawAuthority.isNullOrBlank() && uri.userInfo == null && '@' !in uri.rawAuthority) { UserText.get(R.string.claudex_msg_link_unsupported) }
        val authority = uri.rawAuthority
        val host = uri.host ?: authority.substringBeforeLast(':', authority).let(java.net.IDN::toASCII)
        require(host.isNotBlank())
        val rawPort = if (uri.host != null) uri.port else authority.substringAfterLast(':', "").toIntOrNull() ?: -1
        require(rawPort in -1..65535)
        val port = rawPort.takeUnless { (scheme == "https" && it == 443) || (scheme == "http" && it == 80) } ?: -1
        val path = uri.rawPath.takeUnless { it.isNullOrEmpty() } ?: "/"
        val ascii = URI(scheme + "://" + host.lowercase() + (if (port >= 0) ":$port" else "") + path + (uri.rawQuery?.let { "?$it" } ?: "") + (uri.rawFragment?.let { "#$it" } ?: "")).toASCIIString()
        return Regex("%[a-fA-F0-9]{2}").replace(ascii) { it.value.uppercase() }
    }
    fun requireCurrentLink(c: Conversation, value: String): String {
        val normalized = normalizedLink(value)
        val urls = Regex("https?://[^\\s<>\\\"']+", RegexOption.IGNORE_CASE)
        fun candidate(raw: String): String {
            var value = raw.trimEnd('.', ',', ';', '!', '?')
            while (value.endsWith(')') && value.count { it == ')' } > value.count { it == '(' }) value = value.dropLast(1)
            while (value.endsWith(']') && value.count { it == ']' } > value.count { it == '[' }) value = value.dropLast(1)
            return value
        }
        require(strings(WireCodec.conversation(c)).any { source ->
            runCatching { normalizedLink(source) == normalized }.getOrDefault(false) || urls.findAll(source).any { m -> runCatching { normalizedLink(candidate(m.value)) == normalized }.getOrDefault(false) }
        }) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        return value
    }
    fun requireRemoteImageUrl(c: Conversation, value: String): String {
        val url = requireCurrentLink(c, value)
        val host = URI(url).host.lowercase().trimEnd('.')
        require(host.contains('.') && !host.contains(':') && !Regex("[0-9.]+").matches(host) &&
            listOf("localhost", "local", "internal", "invalid", "test").none { host == it || host.endsWith(".$it") }) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        // The native authenticated endpoint also validates DNS and every redirect hop (electron/remote-image.ts).
        return url
    }
    fun fenceArtifact(c: Conversation, artifactId: String): Artifact? {
        val fence = Regex("```([\\w+.-]*)[^\\n]*\\n([\\s\\S]*?)```")
        for (item in c.turns.flatMap { it.items }) {
            val summaryPrefix = "fence-summary:${item.id}:"
            val textPrefix = "fence:${item.id}:"
            val raw = item.rawJson?.let(::JSONObject)
            val summary = artifactId.startsWith(summaryPrefix)
            val prefix = if (summary) summaryPrefix else textPrefix
            if (!artifactId.startsWith(prefix)) continue
            val source = if (summary) raw?.optJSONArray("summary")?.let { values -> (0 until values.length()).joinToString("\n\n") { values.getString(it) } } ?: return null
                else if (item.type in setOf("agentMessage", "plan")) raw?.opt("text") as? String ?: item.text else return null
            val index = artifactId.removePrefix(prefix).toIntOrNull() ?: return null
            if (index < 0) return null
            val match = fence.findAll(source).drop(index).firstOrNull() ?: return null
            val language = match.groupValues[1].ifBlank { "text" }
            val content = match.groupValues[2]
            return Artifact(artifactId, "${c.title} · ${index + 1}", language, content, c.id, identity = JSONArray(listOf(c.id, content)).toString())
        }
        return null
    }
    fun downloadIdentities(c: Conversation, payload: JSONObject): List<JSONObject> {
        require(id(payload, "conversationId") == c.id)
        val files = payload.getJSONArray("files")
        require(files.length() in 1..32) { UserText.get(R.string.claudex_msg_download_limit) }
        val identities = (0 until files.length()).map { files.getJSONObject(it) }
        val keys = identities.map { identity ->
            require(id(identity, "conversationId") == c.id) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
            val file = generatedFile(c, identity)
            if (file != null) { GeneratedFilePolicy.validate(file); "file:${file.id}:${file.digest}" }
            else { val artifact = fenceArtifact(c, id(identity, "artifactId")) ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again)); "fence:${artifact.id}" }
        }
        require(keys.toSet().size == keys.size) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        return identities
    }
    fun generatedFile(c: Conversation, p: JSONObject): GeneratedFile? {
        val artifactId = id(p, "artifactId")
        val path = p.opt("sourcePath") as? String
        val digest = p.opt("sourceDigest") as? String
        return c.turns.asReversed().flatMap { it.items.asReversed() }.flatMap { it.generatedFiles.asReversed() }.find {
            artifactId == "generated:${it.id}:${it.digest ?: "undefined"}" && (path == null || path == it.path) && (digest == null || digest == it.digest)
        }
    }
}

internal interface ConversationNativeActions {
    suspend fun confirm(title: String, message: String): Boolean
    fun copy(text: String)
    suspend fun download(name: String, mime: String, bytes: ByteArray): String?
    fun navigate(route: String)
    fun openLink(url: String)
    /** The reply action row's Share: the system share sheet with the reply's text. */
    fun share(text: String) {}
}

/** An old account/view completion cannot unlock a newer operation using the same conversation ID. */
internal class ConversationActionLocks {
    private val owners = mutableMapOf<String, String>()
    val ids: Set<String> get() = owners.keys.toSet()
    fun start(id: String): String? {
        if (id in owners) return null
        return newId().also { owners[id] = it }
    }
    fun finish(id: String, token: String) { if (owners[id] == token) owners.remove(id) }
    fun clear() { owners.clear() }
}

/** A canceled OS picker owns its slot until its original result returns. */
internal class NativePickerReservation<T: Any> {
    var pending: T? = null; private set
    fun reserve(value: T) { check(pending == null) { UserText.get(R.string.claudex_msg_save_in_progress) }; pending = value }
    fun takeResult(): T? = pending.also { pending = null }
    fun abortBeforeLaunch(value: T) { if (pending === value) pending = null }
}

/** Only a declined native confirmation before any mutation is a silent user cancellation. */
internal class ConversationUserDeclinedException : CancellationException("已取消")
internal fun conversationCancellationReason(error: CancellationException): String? =
    if (error is ConversationUserDeclinedException) "userDeclined" else null
internal suspend fun ConversationNativeActions.confirmOrDecline(title: String, message: String) {
    val accepted = confirm(title, message)
    // Concurrent scope/session disposal must retain lifecycle cancellation semantics.
    currentCoroutineContext().ensureActive()
    if (!accepted) throw ConversationUserDeclinedException()
}
