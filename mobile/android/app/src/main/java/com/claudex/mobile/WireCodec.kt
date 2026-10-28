package com.claudex.mobile

import com.claudex.core.*
import org.json.JSONArray
import org.json.JSONObject

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
internal fun JSONObject.stringOrNull(key: String): String? = optString(key).takeIf { it.isNotBlank() && it != "null" }
object WireCodec {
    var rawSettings: JSONObject? = null; private set
    var rawHost: JSONObject? = null; private set
    fun clear() { rawSettings = null; rawHost = null; rawProjects.clear() }
    private val rawProjects = mutableMapOf<String, JSONObject>()
    fun attachment(j: JSONObject) = Attachment(j.getString("id"), j.getString("name"), j.optString("path"), j.optString("kind", "document"), j.optLong("size"), j.optString("mime", "application/octet-stream"), j.toString())
    fun attachment(a: Attachment) = raw(a.rawJson).put("id", a.id).put("name", a.name).put("path", a.path).put("kind", a.kind).put("size", a.size).put("mime", a.mime)
    private fun displayText(item: JSONObject): String = (if (item.optString("type") == "commandExecution") item.stringOrNull("aggregatedOutput") else null) ?: item.stringOrNull("text") ?: item.optJSONArray("content")?.objects()?.joinToString("\n") { it.optString("text") } ?: item.optJSONArray("summary")?.let { arr -> (0 until arr.length()).joinToString("\n") { arr.optString(it) } } ?: item.optString("aggregatedOutput")
    fun turn(j: JSONObject): Turn = Turn(j.getString("id"), j.optString("prompt"), j.optJSONArray("attachments")?.objects()?.map(::attachment).orEmpty(), j.optJSONArray("items")?.objects()?.map { item ->
        val text = displayText(item)
        Item(item.getString("id"), item.getString("type"), text, item.optJSONArray("changes")?.objects()?.map { Change(it.optString("path"), it.optString("diff")) }.orEmpty(), item.optJSONArray("generatedFiles")?.objects()?.map(::generatedFile).orEmpty(), item.toString())
    }.orEmpty(), when (j.optString("status")) { "inProgress" -> TurnStatus.IN_PROGRESS; "failed" -> TurnStatus.FAILED; "interrupted" -> TurnStatus.INTERRUPTED; else -> TurnStatus.COMPLETED }, j.stringOrNull("error"), j.optLong("createdAt"), j.stringOrNull("responseGroupId"), j.stringOrNull("promptGroupId"), j.stringOrNull("promptVersionId"), j.optString("compaction") == "manual", metadata(j, setOf("items", "attachments")))
    fun conversation(j: JSONObject) = Conversation(j.getString("id"), j.optString("title", UserText.get(R.string.chat_new_chat)), Mode.entries.find { it.wire == j.optString("mode") } ?: Mode.CHAT, j.optString("providerId"), j.optString("model"), j.optBoolean("pinned"), j.optBoolean("archived"), j.optLong("createdAt"), j.optLong("updatedAt"), j.optJSONArray("turns")?.objects()?.map(::turn).orEmpty(), j.stringOrNull("projectId"), j.optBoolean("slim", false), branches(j), j.stringOrNull("activeBranchId"), j.optLong("branchVisit"), metadata(j, setOf("turns", "savedBranches")), unread = j.optBoolean("unread"))
    fun branches(j: JSONObject): List<ConversationBranch> = j.optJSONArray("savedBranches")?.objects()?.map { ConversationBranch(it.getString("id"), it.optJSONArray("turns")?.objects()?.map(::turn).orEmpty(), it.optLong("visited"), metadata(it, setOf("turns"))) }.orEmpty()
    fun generatedFile(j: JSONObject) = GeneratedFile(j.getString("id"), j.optString("name", "download"), j.optString("state", "unavailable"), j.stringOrNull("digest"), if (j.has("bytes") && !j.isNull("bytes")) j.optLong("bytes") else null, j.optString("mime", "application/octet-stream"), j.optBoolean("blob"), if (j.has("content")) j.optString("content") else null, j.optString("language"), j.stringOrNull("error"), j.optString("path"), j.toString())

    // Typed arrays carry their own immutable wire snapshots. Avoid retaining/re-encoding the complete history inside metadata on every streamed turn event.
    private fun metadata(value: JSONObject, excluded: Set<String>): String = JSONObject().apply { value.keys().asSequence().filter { it !in excluded }.forEach { put(it, value.get(it)) } }.toString()
    private fun raw(value: String?) = value?.let(::JSONObject) ?: JSONObject()
    private fun JSONObject.nullable(key: String, value: Any?): JSONObject = apply { if (value == null) remove(key) else put(key, value) }
    fun generatedFile(f: GeneratedFile): JSONObject = raw(f.rawJson).put("id", f.id).put("name", f.name).put("state", f.state)
        .nullable("digest", f.digest).nullable("bytes", f.bytes).put("mime", f.mime).put("blob", f.blob)
        .nullable("content", f.content).put("language", f.language).nullable("error", f.error).put("path", f.path)
    fun item(i: Item): JSONObject = raw(i.rawJson).apply {
        put("id", i.id); put("type", i.type)
        // text is a native summary for non-message items. Never replace structured reasoning/tool output with it.
        if (i.rawJson == null || (i.type in setOf("agentMessage", "userMessage") && i.text != displayText(this))) put("text", i.text)
        if (i.changes.isNotEmpty() || has("changes")) put("changes", JSONArray(i.changes.map { c ->
            val old = optJSONArray("changes")?.objects()?.find { it.optString("path") == c.path }
            raw(old?.toString()).put("path", c.path).put("diff", c.diff)
        }))
        if (i.generatedFiles.isNotEmpty() || has("generatedFiles")) put("generatedFiles", JSONArray(i.generatedFiles.map(::generatedFile)))
    }
    fun turn(t: Turn): JSONObject = raw(t.rawJson).put("id", t.id).put("prompt", t.prompt)
        .put("attachments", JSONArray(t.attachments.map(::attachment))).put("items", JSONArray(t.items.map(::item)))
        .put("status", when (t.status) { TurnStatus.IN_PROGRESS -> "inProgress"; TurnStatus.FAILED -> "failed"; TurnStatus.INTERRUPTED -> "interrupted"; else -> "completed" })
        .nullable("error", t.error).put("createdAt", t.createdAt).nullable("responseGroupId", t.responseGroupId)
        .nullable("promptGroupId", t.promptGroupId).nullable("promptVersionId", t.promptVersionId).apply {
            if (t.compaction) put("compaction", "manual") else if (optString("compaction") == "manual") remove("compaction")
        }
    internal fun conversationMetadata(c: Conversation): JSONObject = raw(c.rawJson).put("id", c.id).put("title", c.title).put("mode", c.mode.wire)
        .put("providerId", c.providerId).put("model", c.model).put("pinned", c.pinned).put("archived", c.archived)
        .put("createdAt", c.createdAt).put("updatedAt", c.updatedAt).put("unread", c.unread)
        .nullable("projectId", c.projectId).put("slim", c.slim).nullable("activeBranchId", c.activeBranchId).put("branchVisit", c.branchVisit)
    fun conversation(c: Conversation): JSONObject = conversationMetadata(c).put("turns", JSONArray(c.turns.map(::turn)))
        .put("savedBranches", JSONArray(c.savedBranches.map { raw(it.rawJson).put("id", it.id).put("visited", it.visited).put("turns", JSONArray(it.turns.map(::turn))) }))
    /** Full canonical metadata merge; transport identity/content completeness may never be replaced by a turn delta. */
    fun mergeConversationPatch(c: Conversation, patch: JSONObject?): Conversation {
        if (patch == null) return c
        val merged = conversationMetadata(c)
        patch.keys().asSequence().filter { it !in setOf("id", "turns", "slim") }.forEach { merged.put(it, patch.get(it)) }
        return conversation(merged).copy(turns = c.turns, savedBranches = if (patch.has("savedBranches")) branches(patch) else c.savedBranches)
    }
    /** Keep metadata that changed while an RPC was in flight, without losing new fields in the RPC result. */
    fun preserveObservedMetadata(before: Conversation?, current: Conversation?, returned: Conversation, merged: Conversation): Conversation {
        if (current == null || current == before || merged === current) return merged
        val prior = raw(before?.rawJson); val now = raw(current.rawJson); val result = raw(returned.rawJson)
        (prior.keys().asSequence().toSet() + now.keys().asSequence().toSet()).filter { it !in setOf("turns", "savedBranches") }.forEach { key ->
            if (prior.opt(key)?.toString() != now.opt(key)?.toString()) {
                if (now.has(key)) result.put(key, now.get(key)) else result.remove(key)
            }
        }
        return merged.copy(rawJson = result.toString(),
            unread = if (current.unread != before?.unread) current.unread else merged.unread,
            mode = if (current.mode != before?.mode) current.mode else merged.mode,
            model = if (current.model != before?.model) current.model else merged.model,
            providerId = if (current.providerId != before?.providerId) current.providerId else merged.providerId,
            projectId = if (current.projectId != before?.projectId) current.projectId else merged.projectId,
            createdAt = if (current.createdAt != before?.createdAt) current.createdAt else merged.createdAt)
    }
    fun feedback(j: JSONObject): Map<String, String> = j.keys().asSequence().mapNotNull { key -> j.optString(key).takeIf { it in listOf("up", "down") }?.let { key to it } }.toMap()
    /** conversationTurns returns a turns document, not a Conversation. */
    fun fullTurns(value: JSONObject): List<Turn> {
        val turns = value.getJSONArray("turns")
        return (0 until turns.length()).map { turn(turns.getJSONObject(it)) }
    }
    fun project(j: JSONObject): Project { rawProjects[j.getString("id")] = JSONObject(j.toString()); return Project(j.getString("id"), j.optString("name"), j.optString("description"), j.optString("instructions"), j.optLong("createdAt")) }
    fun project(p: Project) = (rawProjects[p.id]?.let { JSONObject(it.toString()) } ?: JSONObject()).put("id", p.id).put("name", p.name).put("description", p.description).put("instructions", p.instructions).put("createdAt", p.createdAt)
    fun approval(j: JSONObject) = Approval(j.get("id").toString(), j.get("id") is Number, j.optString("conversationId"), j.optString("method"), j.optJSONObject("params")?.toString() ?: "{}")
    fun snapshot(j: JSONObject, catalog: JSONObject?): Snapshot {
        val settings = j.optJSONObject("settings") ?: JSONObject()
        rawSettings = JSONObject(settings.toString()); rawHost = j.optJSONObject("host")
        val providers = settings.optJSONArray("providers")?.objects().orEmpty()
        val active = settings.optString("activeProviderId")
        val provider = providers.find { it.optString("id") == active } ?: providers.firstOrNull()
        val models = ModelMenuPolicy.models(providers, catalog)
        val library = j.optJSONObject("artifactLibrary")
        val pinned = library?.optJSONArray("pinned")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()
        val saved = library?.optJSONArray("copies")?.objects()?.map { Artifact(it.getString("libraryId"), it.optString("name"), it.optString("language"), it.optString("content"), it.stringOrNull("originConversationId"), JSONArray(listOf("library", it.getString("libraryId"))).toString() in pinned, JSONArray(listOf("library", it.getString("libraryId"))).toString()) }.orEmpty()
        val generated = mutableListOf<Artifact>()
        j.optJSONArray("conversations")?.objects().orEmpty().forEach { c ->
            c.optJSONArray("turns")?.objects().orEmpty().forEach { t -> t.optJSONArray("items")?.objects().orEmpty().forEach { item ->
                item.optJSONArray("generatedFiles")?.objects().orEmpty().filter { it.optString("state") == "ready" && (it.optBoolean("blob") || it.has("content")) }.forEach { f ->
                    val content = f.optString("content"); val identity = JSONArray(listOf(c.getString("id"), f.stringOrNull("path") ?: if (f.has("content")) content else f.getString("id"))).toString()
                    generated += Artifact(java.util.UUID.nameUUIDFromBytes(identity.toByteArray()).toString(), f.optString("name"), f.optString("language"), content, c.getString("id"), identity in pinned, identity, generatedFile(f))
                }

            } }
        }
        val hidden = j.optJSONArray("artifactShares")?.objects()?.filter { !it.optBoolean("showInList", true) }?.map { it.optString("identity") }.orEmpty()
        val artifacts = (saved + generated.asReversed().distinctBy { it.identity }).filter { it.identity !in hidden }
        return Snapshot(j.optJSONArray("conversations")?.objects()?.map(::conversation).orEmpty(), j.optJSONArray("projects")?.objects()?.map(::project).orEmpty(), artifacts, models, provider?.stringOrNull("model") ?: catalog?.stringOrNull("defaultModel"), j.optJSONObject("engine")?.optString("state") ?: "stopped", j.optJSONObject("host")?.optJSONObject("capabilities")?.optBoolean("cloudCode") ?: false, j.optJSONObject("host")?.optJSONObject("capabilities")?.optBoolean("cloudCowork") ?: false, j.stringOrNull("modelUnavailable"), j.optJSONArray("approvals")?.objects()?.map(::approval).orEmpty(), feedback(j.optJSONObject("replyFeedback") ?: JSONObject()), instructions = settings.opt("instructions") as? String ?: "")
    }
}

object EventMessages {
    fun hello(tabId: String, lastSequence: Long?): JSONObject = JSONObject().put("t", "hello").put("v", 1).put("tabId", tabId).also { if (lastSequence != null) it.put("lastSeq", lastSequence) }
    fun presence(visible: Boolean, focused: Boolean): JSONObject = JSONObject().put("t", "presence").put("visible", visible).put("focused", focused)
    fun sequence(frame: JSONObject): Long { val raw = frame.get("seq"); require(raw is Number); val value = raw.toDouble(); require(value.isFinite() && value >= 0 && value % 1.0 == 0.0 && value <= 9_007_199_254_740_991.0) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }; return value.toLong() }
}
