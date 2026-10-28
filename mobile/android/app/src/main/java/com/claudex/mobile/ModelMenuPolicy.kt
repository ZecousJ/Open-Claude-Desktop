package com.claudex.mobile

import com.claudex.core.ModelOption
import org.json.JSONObject

/** Mirrors src/code-model-choices.ts at web revision 44db82bc. */
internal object ModelMenuPolicy {
    val efforts = listOf("low", "medium", "high", "xhigh", "max")
    data class Vendor(val id: String, val name: String)
    fun vendor(id: String): Vendor {
        val name = id.substringAfterLast('/').lowercase()
        return when {
            Regex("^(gpt|chatgpt|codex|o\\d)").containsMatchIn(name) -> Vendor("openai", "OpenAI")
            name.startsWith("claude") -> Vendor("anthropic", "Anthropic")
            name.startsWith("grok") || name.startsWith("composer") -> Vendor("xai", "xAI")
            name.startsWith("gemini") -> Vendor("gemini", "Google")
            name.startsWith("qwen") -> Vendor("qwen", "Qwen")
            name.startsWith("deepseek") -> Vendor("deepseek", "DeepSeek")
            else -> Vendor("other", "Other")
        }
    }
    fun models(providers: List<JSONObject>, catalog: JSONObject?): List<ModelOption> {
        val items = catalog?.optJSONArray("items")?.objects().orEmpty().associateBy { it.optString("id") }
        return providers.flatMap { provider ->
            (listOf(provider.optString("model")) + provider.optJSONArray("models")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty())
                .filter { it.isNotBlank() && !it.startsWith("gpt-image-", true) }.distinct().map { id ->
                    val item = items[id]
                    val offered = item?.optJSONArray("efforts")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()
                    ModelOption(id, item?.optString("displayName")?.takeIf { it.isNotBlank() } ?: id,
                        item?.optString("description").orEmpty(), provider.getString("id"),
                        efforts.filter { it in offered }.ifEmpty { efforts },
                        catalogued = items.isNotEmpty(), inMore = item == null || item.optBoolean("hidden"),
                        sort = item?.optInt("sort", Int.MAX_VALUE) ?: Int.MAX_VALUE,
                        defaultEffort = item?.optString("defaultEffort")?.takeIf { it in efforts } ?: "high")
                }
        }.sortedBy { it.sort }
    }
    data class Choices(val quick: List<ModelOption>, val more: List<ModelOption>)
    fun choices(models: List<ModelOption>, current: ModelOption?): Choices {
        val listed = if (models.any { it.catalogued }) models.filterNot { it.inMore } else models.take(4)
        val quick = if (current != null && current in models && current !in listed) listOf(current) + listed else listed
        return Choices(quick, models.filterNot { it in quick })
    }
}
