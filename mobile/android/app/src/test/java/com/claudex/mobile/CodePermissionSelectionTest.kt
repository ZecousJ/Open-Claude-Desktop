package com.claudex.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Pure decision checks only: never invokes saveSettings or changes a real permission mode. */
class CodePermissionSelectionTest {
    private fun context(disabled: Boolean = false) = CodePermissionSelection.context(1L, listOf("auto", "bypass"), JSONObject().put("codeSandbox", "workspace-write").put("codePlanMode", false).put("autoAcceptEdits", false).put("allowBypassPermissions", !disabled), true)
    @Test fun bypassRequiresExplicitConfirmation() {
        val c = context()
        try { CodePermissionSelection.requireChoice("bypass", c, c, true, false, false, false); fail() } catch (_: IllegalArgumentException) { }
        CodePermissionSelection.requireChoice("bypass", c, c, true, false, false, true)
    }
    @Test fun disabledBypassRunningTasksAndMissingCapabilitiesNeverGrantSelection() {
        assertFalse(CodePermissionSelection.canSelect("bypass", context(true), true, false, false))
        assertFalse(CodePermissionSelection.canSelect("auto", context(), true, true, false))
        assertFalse(CodePermissionSelection.canSelect("auto", context(), true, false, true))
        assertFalse(CodePermissionSelection.canSelect("auto", context().copy(cloudCode = false), true, false, false))
        assertFalse(CodePermissionSelection.canSelect("auto", context().copy(sandbox = null), true, false, false))
        assertFalse(CodePermissionSelection.canSelect("auto", context(), false, false, false))
    }
    @Test fun staleConfirmationCannotApplyAfterAccountOrOptionsChange() {
        val c = context()
        for (changed in listOf(c.copy(generation = 2), c.copy(offered = listOf("auto")), c.copy(bypassAllowed = false))) {
            try { CodePermissionSelection.requireChoice("bypass", c, changed, true, false, false, true); fail() } catch (_: IllegalArgumentException) { }
        }
    }
}
