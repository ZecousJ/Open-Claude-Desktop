package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject

/** The `@` being typed in a Code draft, and the query after it. */
internal data class MentionMatch(val start: Int, val query: String)

/** A path the session folder offers for that query. */
internal data class MentionFile(val path: String, val folder: Boolean)

/** The `@query` at the caret: the mark starts the text or follows a space, and the query has no space. */
internal fun mentionAt(text: String, caret: Int): MentionMatch? {
    val end = caret.coerceIn(0, text.length)
    val before = text.substring(0, end)
    val match = Regex("""(^|\s)@([^\s@]*)$""").find(before) ?: return null
    val query = match.groupValues[2]
    return MentionMatch(end - query.length - 1, query)
}

/** How a chosen path is written: `@path`, quoted when it has spaces. */
internal fun mentionToken(path: String): String =
    if (path.any { it.isWhitespace() }) "@\"${path.replace("\"", "\\\"")}\"" else "@$path"

/** The draft with the typed query replaced by the path and a trailing space. */
internal fun insertMention(text: String, match: MentionMatch, caret: Int, path: String): Pair<String, Int> {
    val token = mentionToken(path) + " "
    val end = caret.coerceIn(0, text.length)
    val after = text.substring(end).removePrefix(" ")
    return text.substring(0, match.start) + token + after to match.start + token.length
}

/** Files from a `mentionFiles` answer. Rows without a path are left out. */
internal fun mentionFiles(raw: Any?): List<MentionFile> {
    val array = raw as? JSONArray ?: return emptyList()
    val files = ArrayList<MentionFile>(array.length())
    for (index in 0 until array.length()) {
        val row = array.optJSONObject(index) ?: continue
        val path = row.optString("path").trim()
        if (path.isEmpty()) continue
        files += MentionFile(path, row.optString("kind") == "folder")
    }
    return files
}

/** The scope a Code session's mention list asks for. */
internal fun mentionScope(conversationId: String): JSONObject = JSONObject().put("conversationId", conversationId)
