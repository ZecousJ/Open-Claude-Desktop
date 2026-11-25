package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject

/**
 * Knowledge bases (owner, 2026-10-07: ZecousAI's Hiwonder base, for every
 * account, off until a chat turns it on). The agent reaches them through the
 * service; the app lists them (GET /api/v1/claudex/knowledge) and names the
 * bases a conversation uses in `knowledgeBases`.
 */
data class KnowledgeBase(val id: String, val name: String, val description: String, val available: Boolean)

object KnowledgePolicy {
    const val PATH = "/api/v1/claudex/knowledge"
    private val id = Regex("^[a-z0-9][a-z0-9-]{0,63}$")
    fun valid(value: String) = id.matches(value)

    /** The service's answer (envelope or bare), checked; at most eight. */
    fun list(response: JSONObject): List<KnowledgeBase> {
        val data = response.optJSONObject("data") ?: response
        val rows = data.optJSONArray("bases") ?: return emptyList()
        return (0 until minOf(rows.length(), 8)).mapNotNull { index ->
            val row = rows.optJSONObject(index) ?: return@mapNotNull null
            val baseId = row.optString("id"); val name = row.optString("name").trim()
            if (!valid(baseId) || name.isEmpty()) null
            else KnowledgeBase(baseId, name.take(60), row.optString("description").take(200), row.optBoolean("available"))
        }
    }

    /** The bases a conversation's wire metadata names. */
    fun of(rawJson: String?): List<String> = runCatching {
        val array = JSONObject(rawJson ?: "{}").optJSONArray("knowledgeBases") ?: JSONArray()
        (0 until array.length()).map { array.optString(it) }.filter(::valid).distinct()
    }.getOrDefault(emptyList())

    fun toggled(current: List<String>, baseId: String): List<String> =
        if (baseId in current) current - baseId else (current + baseId).take(8)
}
