package com.claudex.core

import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

enum class Mode(val wire: String) { CHAT("chat"), COWORK("cowork"), CODE("code") }

/**
 * Lines the shared core raises that a person may read. The app answers each from its string resources
 * ([CoreText.resolver], set in UserText); without a resolver (unit tests, other hosts) the English text stands.
 */
enum class CoreMessage(val english: String) {
    FILE_UNAVAILABLE("This file isn't available."),
    FILE_TOO_LARGE("This file is too large to download."),
    FILE_CHECK_FAILED("The file didn't download correctly. Try again."),
    IMAGE_ALT("Image"),
}
object CoreText {
    @Volatile var resolver: ((CoreMessage) -> String?)? = null
    fun of(message: CoreMessage): String = resolver?.invoke(message) ?: message.english
}
enum class TurnStatus { IN_PROGRESS, COMPLETED, FAILED, INTERRUPTED }
/** Immutable wire snapshots preserve future/rich fields without mutable JSON leaking into StateFlow equality. */
data class Attachment(val id: String, val name: String, val path: String, val kind: String, val size: Long, val mime: String = "application/octet-stream", val rawJson: String? = null)
data class Change(val path: String, val diff: String)
data class Item(val id: String, val type: String, val text: String = "", val changes: List<Change> = emptyList(), val generatedFiles: List<GeneratedFile> = emptyList(), val rawJson: String? = null)
data class Turn(val id: String, val prompt: String, val attachments: List<Attachment> = emptyList(), val items: List<Item> = emptyList(), val status: TurnStatus = TurnStatus.COMPLETED, val error: String? = null, val createdAt: Long = System.currentTimeMillis(), val responseGroupId: String? = null, val promptGroupId: String? = null, val promptVersionId: String? = null, val compaction: Boolean = false, val rawJson: String? = null)
data class Conversation(val id: String, val title: String, val mode: Mode = Mode.CHAT, val providerId: String, val model: String, val pinned: Boolean = false, val archived: Boolean = false, val createdAt: Long = System.currentTimeMillis(), val updatedAt: Long = createdAt, val turns: List<Turn> = emptyList(), val projectId: String? = null, val slim: Boolean = false, val savedBranches: List<ConversationBranch> = emptyList(), val activeBranchId: String? = null, val branchVisit: Long = 0, val rawJson: String? = null, val unread: Boolean = false)
data class Project(val id: String, val name: String, val description: String, val instructions: String, val createdAt: Long = System.currentTimeMillis())
data class Artifact(val id: String, val name: String, val language: String, val content: String, val originConversationId: String? = null, val pinned: Boolean = false, val identity: String = "", val generatedFile: GeneratedFile? = null)
data class ModelOption(val id: String, val name: String, val description: String, val providerId: String, val efforts: List<String> = emptyList(), val catalogued: Boolean = false, val inMore: Boolean = false, val sort: Int = 0, val defaultEffort: String = "high")
data class Approval(val id: String, val numericId: Boolean, val conversationId: String, val method: String, val params: String)
data class Snapshot(val conversations: List<Conversation> = emptyList(), val projects: List<Project> = emptyList(), val artifacts: List<Artifact> = emptyList(), val models: List<ModelOption> = emptyList(), val selectedModel: String? = null, val engine: String = "stopped", val cloudCode: Boolean = false, val cloudCowork: Boolean = false, val modelUnavailable: String? = null, val approvals: List<Approval> = emptyList(), val replyFeedback: Map<String, String> = emptyMap(), val instructions: String = "", val accountName: String = "")
data class SendInput(val conversationId: String?, val text: String, val mode: Mode, val model: ModelOption, val attachments: List<Attachment>, val projectId: String? = null, val repository: RepositoryChoice? = null, val webSearch: Boolean = false, val research: Boolean = false)
data class RepositoryChoice(val name: String, val cloneUrl: String, val branch: String)
data class Session(val accessToken: String, val refreshToken: String, val expiresAt: Long, val accountLabel: String)
sealed interface Connection { data object Offline: Connection; data object Connecting: Connection; data object Connected: Connection; data class Reconnecting(val attempt: Int): Connection; data class Error(val message: String): Connection }
sealed interface ContentLoadState {
    data object Loading : ContentLoadState
    data class Failed(val message: String) : ContentLoadState
}
class ApiException(val code: String, override val message: String, val httpStatus: Int? = null): Exception(message)

/** Why a file cannot be added; the app words it (strings_messages.xml), so the core carries no copy. */
class AttachmentRejection(val reason: Reason) : IllegalArgumentException(reason.name) {
    enum class Reason { NAME, SIZE, COUNT }
}

object AttachmentPolicy {
    const val MAX_BYTES = 30L * 1024 * 1024
    const val INLINE_BYTES = 256 * 1024
    const val CHUNK_BYTES = 1024 * 1024
    const val MAX_COUNT = 10
    fun validate(name: String, size: Long, count: Int) {
        if (!(name.isNotBlank() && name.length <= 240)) throw AttachmentRejection(AttachmentRejection.Reason.NAME)
        if (size !in 1..MAX_BYTES) throw AttachmentRejection(AttachmentRejection.Reason.SIZE)
        if (count >= MAX_COUNT) throw AttachmentRejection(AttachmentRejection.Reason.COUNT)
    }
    fun chunks(size: Long): Int = ((size + CHUNK_BYTES - 1) / CHUNK_BYTES).toInt()
}

/** Last-seen sequence advances only after an event was accepted. Snapshot resync is explicit. */
class EventCursor {
    var lastSequence: Long? = null; private set
    enum class Decision { APPLY, DUPLICATE, RESYNC }
    fun receive(sequence: Long): Decision {
        val previous = lastSequence
        return when {
            previous != null && sequence <= previous -> Decision.DUPLICATE
            previous != null && sequence != previous + 1 -> Decision.RESYNC
            else -> { lastSequence = sequence; Decision.APPLY }
        }
    }
    fun reset(sequence: Long?) { lastSequence = sequence }
    fun ready(resumed: Boolean): Boolean = lastSequence != null && !resumed
}

/** Protects sign-out and account switches against a response arriving from an earlier session. */
class SessionEpoch {
    var value = 0L; private set
    fun invalidate() { value++ }
    fun accepts(epoch: Long) = epoch == value
}
object RetryPolicy {
    fun delayMs(attempt: Int): Long = (1_000L shl attempt.coerceIn(0, 5)).coerceAtMost(30_000L)
    fun retryRead(code: Int) = code == 408 || code == 429 || code in 500..599
    // Mutations are never automatically replayed: send() has no confirmed idempotency contract.
}
object NativeAuthSecurity {
    fun validateOrigin(value: String): URI {
        val uri = URI(value)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path.orEmpty() in listOf("", "/")) { "The service address must be a valid HTTPS origin" }
        return uri
    }
    fun randomSecret(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }.let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
    fun challenge(verifier: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
    fun validateCallback(expectedState: String, receivedState: String): Boolean = MessageDigest.isEqual(expectedState.toByteArray(), receivedState.toByteArray())
}
fun newId(): String = UUID.randomUUID().toString()

interface CredentialStore {
    fun save(session: Session)
    fun load(): Session?
    fun clear()
}

data class GeneratedFile(val id: String, val name: String, val state: String, val digest: String? = null, val bytes: Long? = null, val mime: String = "application/octet-stream", val blob: Boolean = false, val content: String? = null, val language: String = "", val error: String? = null, val path: String = "", val rawJson: String? = null)
data class ConversationBranch(val id: String, val turns: List<Turn>, val visited: Long = 0, val rawJson: String? = null)
data class TurnVersion(val turnId: String, val branchId: String, val createdAt: Long, val visited: Long, val versionKey: String = turnId)

/** Matches shared/branches.ts, including newest continuation selection for prompt versions. */
object TurnVersions {
    fun responseGroup(t: Turn) = t.responseGroupId ?: t.id
    fun versions(c: Conversation, turn: Turn, prompt: Boolean = false): List<TurnVersion> {
        val group = if (prompt) turn.promptGroupId ?: responseGroup(turn) else responseGroup(turn)
        val versions = linkedMapOf<String, TurnVersion>()
        for (branch in c.savedBranches + ConversationBranch(c.activeBranchId ?: "original", c.turns, c.branchVisit)) {
            val candidate = branch.turns.find { (if (prompt) it.promptGroupId ?: responseGroup(it) else responseGroup(it)) == group } ?: continue
            val key = if (prompt) candidate.promptVersionId ?: responseGroup(candidate) else candidate.id
            val prior = versions[key]
            if (prior == null || branch.visited >= prior.visited) versions[key] = TurnVersion(candidate.id, branch.id, if (prompt) minOf(prior?.createdAt ?: candidate.createdAt, candidate.createdAt) else candidate.createdAt, branch.visited, key)
        }
        return versions.values.sortedWith(compareBy<TurnVersion> { it.createdAt }.thenBy { it.turnId })
    }
}

object GeneratedFilePolicy {
    const val MAX_BYTES = 30 * 1024 * 1024
    fun validate(file: GeneratedFile) {
        require(file.state == "ready") { file.error ?: CoreText.of(CoreMessage.FILE_UNAVAILABLE) }
        require(file.bytes == null || file.bytes in 0..MAX_BYTES.toLong()) { CoreText.of(CoreMessage.FILE_TOO_LARGE) }
        if (file.blob) require(file.digest?.matches(Regex("[0-9a-f]{64}")) == true) { CoreText.of(CoreMessage.FILE_CHECK_FAILED) }
    }
    fun decode(file: GeneratedFile, encoded: String): ByteArray {
        validate(file)
        require(encoded.length <= ((MAX_BYTES + 2) / 3) * 4) { CoreText.of(CoreMessage.FILE_TOO_LARGE) }
        val bytes = Base64.getDecoder().decode(encoded)
        require(bytes.size <= MAX_BYTES) { CoreText.of(CoreMessage.FILE_TOO_LARGE) }
        require(file.bytes == null || file.bytes == bytes.size.toLong()) { CoreText.of(CoreMessage.FILE_CHECK_FAILED) }
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        require(digest == file.digest) { CoreText.of(CoreMessage.FILE_CHECK_FAILED) }
        return bytes
    }
    fun exportName(name: String) = name.substringAfterLast('/').substringAfterLast('\\').filter { it >= ' ' && it != '\u007f' && Character.getType(it) != Character.FORMAT.toInt() }.take(180).takeUnless { it.isBlank() || it == "." || it == ".." } ?: "download"
}

fun feedbackKey(id: String, turnId: String): String {
    fun quote(value: String) = "\"" + value.flatMap { c -> when(c) { '\\' -> "\\\\"; '"' -> "\\\""; '\n' -> "\\n"; '\r' -> "\\r"; '\t' -> "\\t"; else -> if (c < ' ') "\\u%04x".format(c.code) else c.toString() }.toList() }.joinToString("") + "\""
    return "[${quote(id)},${quote(turnId)}]"
}

/** Reconciles an RPC's initial document with events/snapshots observed while it was in flight. */
object ConversationMutationReconciler {
    fun merge(before: Conversation?, current: Conversation?, returned: Conversation): Conversation {
        if (current == null || current == before) return returned
        val activeChanged = current.activeBranchId != before?.activeBranchId
        if (activeChanged && current.activeBranchId != returned.activeBranchId && current.branchVisit >= returned.branchVisit) return current
        if (current.branchVisit > returned.branchVisit) return current
        val returnedIds = returned.turns.map { it.id }
        if (current.activeBranchId == returned.activeBranchId && current.turns.size > returned.turns.size && current.turns.take(returnedIds.size).map { it.id } == returnedIds) return current
        val preservesCurrent = returned.turns.any { turn -> current.turns.find { it.id == turn.id }?.let { it != before?.turns?.find { original -> original.id == turn.id } } == true }
        return returned.copy(slim = returned.slim || (current.slim && preservesCurrent), turns = returned.turns.map { turn ->
            val latest = current.turns.find { it.id == turn.id }
            if (latest != null && latest != before?.turns?.find { it.id == turn.id }) latest else turn
        }, title = if (current.title != before?.title) current.title else returned.title,
            pinned = if (current.pinned != before?.pinned) current.pinned else returned.pinned,
            archived = if (current.archived != before?.archived) current.archived else returned.archived,
            updatedAt = maxOf(current.updatedAt, returned.updatedAt))
    }
}
