package com.claudex.mobile

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChatScreenChromeTest {
    @Test fun commandsFileChangesAndPermissionsAreAnsweredOnThePhone() {
        assertTrue(ApprovalKinds.answerable("item/permissions/requestApproval"))
        assertTrue(ApprovalKinds.answerable("item/commandExecution/requestApproval"))
        assertTrue(ApprovalKinds.answerable("item/fileChange/requestApproval"))
        assertFalse(ApprovalKinds.answerable("item/tool/requestUserInput"))
        assertFalse(ApprovalKinds.answerable("mcpServer/elicitation/request"))
        assertTrue(ApprovalKinds.isQuestion("tool/requestUserInput"))
    }

    @Test fun aToolQuestionWithoutFormFieldsIsAPlainAllowOrDecline() {
        val method = "mcpServer/elicitation/request"
        assertTrue(ApprovalKinds.answerable(method, org.json.JSONObject("""{"message":"Run it?","requestedSchema":{"type":"object","properties":{}}}""")))
        val accept = ApprovalKinds.response(method, org.json.JSONObject(), true)
        assertEquals("accept", accept.getString("action")); assertTrue(accept.isNull("content"))
        assertEquals("decline", ApprovalKinds.response(method, org.json.JSONObject(), false).getString("action"))
    }

    @Test fun aFormAndAPageToOpenAreAnsweredOnThePhone() {
        val method = "mcpServer/elicitation/request"
        assertTrue(ApprovalKinds.answerable(method, org.json.JSONObject("""{"requestedSchema":{"properties":{"name":{"type":"string"}}}}""")))
        assertTrue(ApprovalKinds.answerable(method, org.json.JSONObject("""{"mode":"url","url":"https://example.com/sign-in"}""")))
        assertFalse(ApprovalKinds.answerable(method, org.json.JSONObject("""{"mode":"url","url":"file:///etc/passwd"}""")))
        assertFalse(ApprovalKinds.answerable(method, org.json.JSONObject("""{"mode":"url","url":"javascript:alert(1)"}""")))
        assertFalse(ApprovalKinds.answerable(method, org.json.JSONObject("""{"mode":"url","message":"Sign in"}""")))
        assertNull(ElicitationForm.openablePage("http://"))
        assertEquals("HTTP://example.com/a", ElicitationForm.openablePage("HTTP://example.com/a"))
    }

    @Test fun alwaysAllowForTheSessionIsSentAsCodexTakesIt() {
        val command = "item/commandExecution/requestApproval"
        val none = org.json.JSONObject()
        assertEquals("acceptForSession", ApprovalKinds.response(command, none, ApprovalAnswer.Session).getString("decision"))
        assertEquals("accept", ApprovalKinds.response(command, none, ApprovalAnswer.Once).getString("decision"))
        assertEquals("acceptForSession", ApprovalKinds.response("item/fileChange/requestApproval", none, ApprovalAnswer.Session).getString("decision"))
        assertEquals("decline", ApprovalKinds.response(command, none, ApprovalAnswer.Deny).getString("decision"))
        val method = "item/permissions/requestApproval"
        val permissions = org.json.JSONObject("""{"permissions":{"network":{"enabled":true}}}""")
        val session = ApprovalKinds.response(method, permissions, ApprovalAnswer.Session)
        assertEquals("session", session.getString("scope"))
        assertTrue(session.getJSONObject("permissions").getJSONObject("network").getBoolean("enabled"))
        assertEquals("turn", ApprovalKinds.response(method, permissions, ApprovalAnswer.Once).getString("scope"))
        val denied = ApprovalKinds.response(method, permissions, ApprovalAnswer.Deny)
        assertEquals(0, denied.getJSONObject("permissions").length()); assertEquals("turn", denied.getString("scope"))
    }

    @Test fun theSessionChoiceFollowsTheAdministratorsPolicy() {
        val command = "item/commandExecution/requestApproval"
        assertTrue(ApprovalKinds.sessionOffered(command, null))
        assertTrue(ApprovalKinds.sessionOffered(command, true))
        assertFalse(ApprovalKinds.sessionOffered(command, false))
        assertTrue(ApprovalKinds.sessionOffered("item/permissions/requestApproval", null))
        // A tool's own request or a question has no session grant of this kind.
        assertFalse(ApprovalKinds.sessionOffered("mcpServer/elicitation/request", null))
        assertFalse(ApprovalKinds.sessionOffered("item/tool/requestUserInput", null))
    }

    private fun connectorRequest(persist: String = """["session","always"]""", meta: String = "") = org.json.JSONObject(
        """{"serverName":"linear","mode":"form","message":"Allow the linear MCP server to run tool \"create_issue\"?",
           "requestedSchema":{"type":"object","properties":{}},
           "_meta":{"codex_approval_kind":"mcp_tool_call","persist":$persist,"tool_params":{"title":"Fix login","priority":2}$meta}}""")

    @Test fun aConnectorToolApprovalIsReadFromTheRequest() {
        val method = "mcpServer/elicitation/request"
        val real = ConnectorToolApproval.parse(method, connectorRequest())!!
        assertEquals("linear", real.server); assertEquals("create_issue", real.tool); assertEquals("create_issue", real.toolName)
        assertEquals("linear", real.connectorName)
        assertEquals(listOf(ConnectorToolApproval.Row("priority", "2"), ConnectorToolApproval.Row("title", "Fix login")), real.rows)
        assertTrue(real.canSession); assertTrue(real.canAlways); assertEquals("always", real.alwaysScope)
        val app = ConnectorToolApproval.parse(method, connectorRequest(persist = "\"session\"", meta = """,
            "tool_title":"Create issue","connector_name":"Linear","tool_params_display":[{"name":"title","value":"Fix login","display_name":"Title"},{"name":"priority","value":2}]"""))!!
        assertEquals("Create issue", app.toolName); assertEquals("Linear", app.connectorName)
        assertEquals(listOf(ConnectorToolApproval.Row("Title", "Fix login"), ConnectorToolApproval.Row("priority", "2")), app.rows)
        assertEquals("session", app.alwaysScope)
        // Only Codex's tool call elicitation counts.
        assertNull(ConnectorToolApproval.parse(method, org.json.JSONObject("""{"serverName":"x","_meta":{"persist":"always"}}""")))
        assertNull(ConnectorToolApproval.parse("item/commandExecution/requestApproval", connectorRequest()))
        assertNull(ConnectorToolApproval.parse(method, org.json.JSONObject("""{"mode":"url","_meta":{"codex_approval_kind":"mcp_tool_call"}}""")))
    }

    @Test fun aConnectorToolsButtonsAnswerWithThePersistScopeOffered() {
        val method = "mcpServer/elicitation/request"
        val both = connectorRequest()
        val once = ApprovalKinds.response(method, both, ApprovalAnswer.Once)
        assertEquals("accept", once.getString("action")); assertTrue(once.isNull("content")); assertTrue(once.isNull("_meta"))
        assertEquals("always", ApprovalKinds.response(method, both, ApprovalAnswer.Always).getJSONObject("_meta").getString("persist"))
        val deny = ApprovalKinds.response(method, both, ApprovalAnswer.Deny)
        assertEquals("decline", deny.getString("action")); assertTrue(deny.isNull("_meta"))
        // Only the session's choice offered: Always allow keeps it for the session. Nothing offered: a plain accept.
        assertEquals("session", ApprovalKinds.response(method, connectorRequest(persist = """["session"]"""), ApprovalAnswer.Always).getJSONObject("_meta").getString("persist"))
        assertTrue(ApprovalKinds.response(method, connectorRequest(persist = "[]"), ApprovalAnswer.Always).isNull("_meta"))
    }

    @Test fun theRealCodexRequestIsReadAsItIsSent() {
        // Captured from codex-cli 0.144.1 (tests/mcp-tool-approval.e2e.test.ts): no tool name, title or connector in _meta.
        val request = org.json.JSONObject("""{"threadId":"t","serverName":"probe","mode":"form","message":"Allow the probe MCP server to run tool \"probe_echo\"?",
            "requestedSchema":{"type":"object","properties":{}},
            "_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"],"tool_description":"Echo a marker back","tool_params":{"text":"hi"},
            "tool_params_display":[{"name":"text","value":"hi","display_name":"text"}]}}""")
        val tool = ConnectorToolApproval.parse("mcpServer/elicitation/request", request)!!
        assertEquals("probe_echo", tool.tool); assertEquals("probe", tool.connectorName)
        assertEquals(listOf(ConnectorToolApproval.Row("text", "hi")), tool.rows); assertEquals("always", tool.alwaysScope)
    }

    @Test fun permissionRequestsAreGrantedAsRequestedOrDeniedEmpty() {
        val method = "item/permissions/requestApproval"
        val params = org.json.JSONObject("""{"permissions":{"network":{"enabled":true},"fileSystem":{"read":["/tmp/a"],"write":null}}}""")
        val allow = ApprovalKinds.response(method, params, true)
        assertEquals("turn", allow.getString("scope"))
        val granted = allow.getJSONObject("permissions")
        assertTrue(granted.getJSONObject("network").getBoolean("enabled"))
        assertEquals("/tmp/a", granted.getJSONObject("fileSystem").getJSONArray("read").getString(0))
        assertTrue(granted.getJSONObject("fileSystem").isNull("write"))
        assertEquals(0, ApprovalKinds.response(method, params, false).getJSONObject("permissions").length())
        assertEquals(listOf("network", "read"), ApprovalKinds.permissionRows(params.getJSONObject("permissions")).map { it.kind })
        assertEquals(R.string.claudex_permission_title_generic, ApprovalKinds.permissionTitleRes(ApprovalKinds.permissionRows(params.getJSONObject("permissions"))))
    }

    @Test fun shortSingleLineCommandsGoInTheHeader() {
        assertEquals("npm test", ApprovalKinds.headerContent("  npm test "))
        assertNull(ApprovalKinds.headerContent("echo a\necho b"))
        assertNull(ApprovalKinds.headerContent("x".repeat(49)))
        assertNull(ApprovalKinds.headerContent(""))
    }

    @Test fun overlayAssetsShipWithTheOnlyAllowedExtraPath() {
        val dir = File("src/main/assets/transcript-official")
        assertTrue(File(dir, "overlay.css").readText().contains("--ox-bubble"))
        assertTrue(File(dir, "overlay.js").readText().contains("nativeShare"))
        assertTrue(File(dir, "JetBrainsMono.ttf").length() > 100_000)
        assertEquals("/transcript-official/JetBrainsMono.ttf", TranscriptOverlay.FONT_PATH)
    }
}
