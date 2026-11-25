package com.claudex.mobile

import com.claudex.core.Conversation
import com.claudex.core.GeneratedFile
import com.claudex.core.Artifact
import org.json.JSONArray
import org.json.JSONObject

internal data class ConversationDocument(val source: GeneratedFile? = null, val artifact: Artifact? = null, val content: String, val language: String) {
    val id: String get() = source?.id ?: artifact!!.id
    val name: String get() = source?.name ?: artifact!!.name
}
internal data class ConversationMedia(val attachmentPreviews: Map<String, String> = emptyMap(), val generatedFileBytes: Map<String, String> = emptyMap()) {
    fun json() = JSONObject().put("attachmentPreviews", JSONObject(attachmentPreviews)).put("generatedFileBytes", JSONObject(generatedFileBytes))
}
internal data class ConversationPresentation(val conversation: Conversation, val dark: Boolean, val feedback: Map<String, String>, val sending: Boolean, val document: ConversationDocument? = null, val media: ConversationMedia = ConversationMedia())
internal data class ConversationDelivery(val method: String, val body: JSONObject)
/** Compare with the newest admitted state, not an older ACK hidden behind in-flight work. */
internal fun shouldQueueConversationPresentation(next: ConversationPresentation, pending: ConversationPresentation?, inFlight: ConversationPresentation?, applied: ConversationPresentation?): Boolean =
    next != pending && (pending != null || next != (inFlight ?: applied))
internal fun isCurrentConversationAcknowledgement(revision: Long, inFlightRevision: Long?): Boolean =
    revision > 0 && revision == inFlightRevision

/** Produces bounded turn deltas after acknowledged states; branch/reordering/metadata changes force a full render. */
internal fun conversationDelivery(previous: ConversationPresentation?, next: ConversationPresentation, sessionId: String, baseRevision: Long, revision: Long): ConversationDelivery {
    // The app's own text is Chinese; the shared transcript is told so rather than following the system language.
    val body = JSONObject().put("version", 1).put("sessionId", sessionId).put("revision", revision).put("locale", "zh-CN")
        .put("theme", if (next.dark) "dark" else "light").put("replyFeedback", JSONObject(next.feedback)).put("sending", next.sending).put("media", next.media.json())
    next.document?.let { document ->
        return ConversationDelivery("renderDocument", body.put("document", JSONObject().put("id", document.id).put("name", document.name).put("language", document.language).put("content", document.content)))
    }
    if (previous != null && previous.document == null) {
        val old = previous.conversation.turns.associateBy { it.id }
        val fresh = next.conversation.turns
        val freshIds = fresh.map { it.id }.toSet()
        val surviving = old.keys.filter { it in freshIds }
        val incoming = fresh.map { it.id }.filter { it in old }
        val appendedOnlyAtEnd = fresh.dropWhile { it.id in old }.none { it.id in old }
        val sameMetadata = WireCodec.conversationMetadata(previous.conversation).toString() == WireCodec.conversationMetadata(next.conversation).toString() && previous.conversation.savedBranches == next.conversation.savedBranches
        if (sameMetadata && surviving == incoming && appendedOnlyAtEnd) {
            val changes = JSONArray()
            old.keys.filter { it !in freshIds }.forEach { changes.put(JSONObject().put("type", "removeTurn").put("turnId", it)) }
            fresh.forEach { turn ->
                val prior = old[turn.id]
                // Immutable model equality skips serialization of every unchanged historical turn.
                if (prior != turn) {
                    val wire = WireCodec.turn(turn)
                    changes.put(appendTextChange(prior?.let(WireCodec::turn), wire) ?: JSONObject().put("type", "upsertTurn").put("turn", wire))
                }
            }
            if (previous.media == next.media) body.remove("media")
            return ConversationDelivery("update", body.put("baseRevision", baseRevision).put("changes", changes))
        }
    }
    return ConversationDelivery("render", body.put("conversation", WireCodec.conversation(next.conversation)))
}

private fun appendTextChange(before: JSONObject?, after: JSONObject): JSONObject? {
    if (before == null) return null
    val old = JSONObject(before.toString()); val fresh = JSONObject(after.toString())
    val oldItems = (old.remove("items") as? JSONArray)?.objects() ?: return null
    val newItems = (fresh.remove("items") as? JSONArray)?.objects() ?: return null
    if (old.toString() != fresh.toString() || oldItems.size != newItems.size) return null
    var change: JSONObject? = null
    for ((index, item) in newItems.withIndex()) {
        val prior = oldItems[index]
        if (prior.toString() == item.toString()) continue
        if (change != null || item.optString("type") != "agentMessage") return null
        val oldText = prior.remove("text") as? String ?: return null
        val newText = item.remove("text") as? String ?: return null
        if (prior.toString() != item.toString() || !newText.startsWith(oldText) || newText.length == oldText.length) return null
        change = JSONObject().put("type", "appendItemText").put("turnId", after.getString("id")).put("itemId", item.getString("id")).put("text", newText.substring(oldText.length))
    }
    return change
}
