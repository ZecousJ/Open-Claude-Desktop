package com.claudex.mobile

import org.json.JSONObject

internal data class PermissionChoiceContext(val generation: Long, val offered: List<String>, val sandbox: String?,
    val plan: Boolean?, val edits: Boolean?, val bypassAllowed: Boolean?, val cloudCode: Boolean)

internal object CodePermissionSelection {
    fun context(generation: Long, offered: List<String>, settings: JSONObject?, cloudCode: Boolean) = PermissionChoiceContext(
        generation, offered.toList(), settings?.opt("codeSandbox") as? String, settings?.opt("codePlanMode") as? Boolean,
        settings?.opt("autoAcceptEdits") as? Boolean, settings?.opt("allowBypassPermissions") as? Boolean, cloudCode)
    fun canSelect(mode: String, context: PermissionChoiceContext, signedIn: Boolean, running: Boolean, working: Boolean): Boolean {
        val configured = context.sandbox in setOf("read-only", "workspace-write", "danger-full-access") && context.plan != null && context.edits != null &&
            (context.plan != true || context.sandbox == "read-only" && context.edits == false)
        return signedIn && context.cloudCode && configured && !running && !working && mode in context.offered &&
            (mode != "bypass" || context.bypassAllowed != false)
    }
    fun requireChoice(mode: String, expected: PermissionChoiceContext, current: PermissionChoiceContext,
        signedIn: Boolean, running: Boolean, working: Boolean, confirmed: Boolean) {
        require(expected == current && canSelect(mode, current, signedIn, running, working)) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        require(mode != "bypass" || confirmed) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
    }
}
