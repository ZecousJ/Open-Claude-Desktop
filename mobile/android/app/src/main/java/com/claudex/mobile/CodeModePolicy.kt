package com.claudex.mobile
import com.claudex.core.Conversation
import com.claudex.core.Mode
import org.json.JSONArray
import org.json.JSONObject

internal object CodeModePolicy {
    private val known = setOf("manual", "auto", "acceptEdits", "plan", "bypass")
    fun offered(values: JSONArray?): List<String> = (0 until (values?.length() ?: 0)).mapNotNull { values?.opt(it) as? String }.filter { it in known }.distinct()
    fun patch(mode: String, offered: List<String>): JSONObject {
        require(mode in offered && mode in known) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        return JSONObject().put("codeSandbox", when (mode) { "bypass" -> "danger-full-access"; "manual", "plan" -> "read-only"; else -> "workspace-write" })
            .put("autoAcceptEdits", mode == "acceptEdits").put("codePlanMode", mode == "plan")
    }
    fun current(settings: JSONObject?): String? = when {
        settings == null -> null
        settings.optString("codeSandbox") == "danger-full-access" -> "bypass"
        settings.optBoolean("codePlanMode") -> "plan"
        settings.optBoolean("autoAcceptEdits") -> "acceptEdits"
        settings.optString("codeSandbox") == "read-only" -> "manual"
        else -> "auto"
    }
    fun tasks(conversations: List<Conversation>) = conversations.filter { it.mode == Mode.CODE }.sortedByDescending { it.updatedAt }
}
