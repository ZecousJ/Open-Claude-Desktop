package com.claudex.mobile

import org.json.JSONObject

/**
 * The phone has no web search or research switch (owner rule, 2026-10-05; fidelity/mobile-official/strings-feature-map.md §7.1):
 * a new chat is sent with both off, whatever the server's default says, so no search refusal can block a send.
 */
internal data class ComposerFeatures(val webSearch: Boolean = false, val research: Boolean = false)

internal object ComposerFeaturePolicy {
    fun incognito(raw: String?) = runCatching { JSONObject(raw ?: "{}").optBoolean("incognito") }.getOrDefault(false)
    fun newSendPayload(payload: JSONObject, conversationId: String?, features: ComposerFeatures): JSONObject = payload.apply {
        if (conversationId == null) { put("webSearch", features.webSearch || features.research); put("research", features.research) }
    }
}
