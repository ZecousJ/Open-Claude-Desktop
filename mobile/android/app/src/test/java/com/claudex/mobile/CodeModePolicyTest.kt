package com.claudex.mobile
import com.claudex.core.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class CodeModePolicyTest {
    @Test fun offeredModesRetainOrderAndNeverInventPrivileges() {
        assertEquals(listOf("plan", "bypass", "manual"), CodeModePolicy.offered(JSONArray(listOf("plan", "bypass", "bypass", "unknown", "manual"))))
        assertTrue(CodeModePolicy.offered(null).isEmpty())
        assertThrows(IllegalArgumentException::class.java) { CodeModePolicy.patch("bypass", listOf("manual")) }
        assertEquals("read-only", CodeModePolicy.patch("manual", listOf("manual")).getString("codeSandbox"))
    }
    @Test fun explicitSelectionUsesTheExistingWebSettingsContract() {
        val patch = CodeModePolicy.patch("bypass", listOf("bypass"))
        assertEquals("danger-full-access", patch.getString("codeSandbox"))
        assertFalse(patch.getBoolean("codePlanMode")); assertFalse(patch.getBoolean("autoAcceptEdits"))
        assertEquals("bypass", CodeModePolicy.current(patch))
    }
    @Test fun latestCodeTasksComeFirst() {
        fun c(id: String, mode: Mode, updated: Long) = Conversation(id, id, mode, "synthetic", "synthetic", updatedAt = updated)
        assertEquals(listOf("new", "old"), CodeModePolicy.tasks(listOf(c("old", Mode.CODE, 1), c("chat", Mode.CHAT, 99), c("new", Mode.CODE, 2))).map { it.id })
    }
}
