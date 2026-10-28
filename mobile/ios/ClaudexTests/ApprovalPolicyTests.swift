import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

final class ApprovalPolicyTests: XCTestCase {
    func testCommandsFileChangesAndPermissionsAreAnsweredOnThePhone() {
        XCTAssertTrue(ApprovalPolicy.answerable(method: "item/commandExecution/requestApproval", params: .null))
        XCTAssertTrue(ApprovalPolicy.answerable(method: "item/fileChange/requestApproval", params: .null))
        XCTAssertTrue(ApprovalPolicy.answerable(method: "item/permissions/requestApproval", params: .null))
        XCTAssertFalse(ApprovalPolicy.answerable(method: "item/permissions/requestApproval", params: .null, extended: false))
        XCTAssertFalse(ApprovalPolicy.answerable(method: "item/tool/requestUserInput", params: .null))
    }

    func testAToolQuestionWithoutFormFieldsIsAPlainAllowOrDecline() {
        let method = "mcpServer/elicitation/request"
        XCTAssertTrue(ApprovalPolicy.answerable(method: method, params: .object(["message": .string("Run it?"), "requestedSchema": .object(["properties": .object([:])])])))
        let accept = ApprovalPolicy.response(method: method, params: .null, allow: true)
        XCTAssertEqual(accept["action"].string, "accept")
        XCTAssertEqual(accept["content"], .null)
        XCTAssertEqual(ApprovalPolicy.response(method: method, params: .null, allow: false)["action"].string, "decline")
    }

    func testAFormAndAPageToOpenAreAnsweredOnThePhone() {
        let method = "mcpServer/elicitation/request"
        XCTAssertTrue(ApprovalPolicy.answerable(method: method, params: .object(["requestedSchema": .object(["properties": .object(["name": .object(["type": .string("string")])])])])))
        XCTAssertTrue(ApprovalPolicy.answerable(method: method, params: .object(["mode": .string("url"), "url": .string("https://example.com/sign-in")])))
        XCTAssertFalse(ApprovalPolicy.answerable(method: method, params: .object(["mode": .string("url"), "url": .string("file:///etc/passwd")])))
        XCTAssertFalse(ApprovalPolicy.answerable(method: method, params: .object(["mode": .string("url"), "url": .string("javascript:alert(1)")])))
        XCTAssertFalse(ApprovalPolicy.answerable(method: method, params: .object(["mode": .string("url")])))
        XCTAssertNil(ElicitationForm.openablePage("http://"))
        XCTAssertEqual(ElicitationForm.openablePage("HTTP://example.com/a")?.host, "example.com")
    }

    func testAlwaysAllowForTheSessionIsSentAsCodexTakesIt() {
        let command = "item/commandExecution/requestApproval"
        XCTAssertEqual(ApprovalPolicy.response(method: command, params: .null, answer: .session)["decision"].string, "acceptForSession")
        XCTAssertEqual(ApprovalPolicy.response(method: command, params: .null, answer: .once)["decision"].string, "accept")
        XCTAssertEqual(ApprovalPolicy.response(method: "item/fileChange/requestApproval", params: .null, answer: .session)["decision"].string, "acceptForSession")
        XCTAssertEqual(ApprovalPolicy.response(method: command, params: .null, answer: .deny)["decision"].string, "decline")
        let permissions: JSONValue = .object(["permissions": .object(["network": .object(["enabled": .bool(true)])])])
        let method = "item/permissions/requestApproval"
        let session = ApprovalPolicy.response(method: method, params: permissions, answer: .session)
        XCTAssertEqual(session["scope"].string, "session")
        XCTAssertEqual(session["permissions"]["network"]["enabled"].bool, true)
        XCTAssertEqual(ApprovalPolicy.response(method: method, params: permissions, answer: .once)["scope"].string, "turn")
        let denied = ApprovalPolicy.response(method: method, params: permissions, answer: .deny)
        XCTAssertEqual(denied["permissions"], .object([:]))
        XCTAssertEqual(denied["scope"].string, "turn")
    }

    func testTheSessionChoiceFollowsTheAdministratorsPolicy() {
        let command = "item/commandExecution/requestApproval"
        XCTAssertTrue(ApprovalPolicy.sessionOffered(method: command, policy: nil))
        XCTAssertTrue(ApprovalPolicy.sessionOffered(method: command, policy: .object(["approvalsAlwaysAllow": .bool(true)])))
        XCTAssertFalse(ApprovalPolicy.sessionOffered(method: command, policy: .object(["approvalsAlwaysAllow": .bool(false)])))
        XCTAssertTrue(ApprovalPolicy.sessionOffered(method: "item/permissions/requestApproval", policy: .object([:])))
        // A tool's own request or a question has no session grant of this kind.
        XCTAssertFalse(ApprovalPolicy.sessionOffered(method: "mcpServer/elicitation/request", policy: nil))
        XCTAssertFalse(ApprovalPolicy.sessionOffered(method: "item/tool/requestUserInput", policy: nil))
    }

    private func connectorRequest(persist: JSONValue = .array([.string("session"), .string("always")]), meta: [String: JSONValue] = [:]) -> JSONValue {
        var fields: [String: JSONValue] = [
            "codex_approval_kind": .string("mcp_tool_call"), "persist": persist,
            "tool_params": .object(["title": .string("Fix login"), "priority": .number(2)]),
        ]
        for (key, value) in meta { fields[key] = value }
        return .object(["serverName": .string("linear"), "mode": .string("form"),
                        "message": .string("Allow the linear MCP server to run tool \"create_issue\"?"),
                        "requestedSchema": .object(["type": .string("object"), "properties": .object([:])]), "_meta": .object(fields)])
    }

    func testAConnectorToolApprovalIsReadFromTheRequest() throws {
        let method = "mcpServer/elicitation/request"
        let real = try XCTUnwrap(ConnectorToolApproval(method: method, params: connectorRequest()))
        XCTAssertEqual(real.server, "linear")
        XCTAssertEqual(real.tool, "create_issue")
        XCTAssertEqual(real.toolName, "create_issue")
        XCTAssertEqual(real.connectorName, "linear")
        XCTAssertEqual(real.rows, [.init(label: "priority", value: "2"), .init(label: "title", value: "Fix login")])
        XCTAssertTrue(real.canSession)
        XCTAssertTrue(real.canAlways)
        XCTAssertEqual(real.alwaysScope, "always")
        let display: JSONValue = .array([
            .object(["name": .string("title"), "value": .string("Fix login"), "display_name": .string("Title")]),
            .object(["name": .string("priority"), "value": .number(2)]),
        ])
        let app = try XCTUnwrap(ConnectorToolApproval(method: method, params: connectorRequest(persist: .string("session"), meta: [
            "tool_title": .string("Create issue"), "connector_name": .string("Linear"), "tool_params_display": display,
        ])))
        XCTAssertEqual(app.toolName, "Create issue")
        XCTAssertEqual(app.connectorName, "Linear")
        XCTAssertEqual(app.rows, [.init(label: "Title", value: "Fix login"), .init(label: "priority", value: "2")])
        XCTAssertEqual(app.alwaysScope, "session")
        // Only Codex's tool call elicitation counts.
        XCTAssertNil(ConnectorToolApproval(method: method, params: .object(["serverName": .string("x"), "_meta": .object(["persist": .string("always")])])))
        XCTAssertNil(ConnectorToolApproval(method: "item/commandExecution/requestApproval", params: connectorRequest()))
        XCTAssertNil(ConnectorToolApproval(method: method, params: .object(["mode": .string("url"), "_meta": .object(["codex_approval_kind": .string("mcp_tool_call")])])))
    }

    func testAConnectorToolsButtonsAnswerWithThePersistScopeOffered() throws {
        let method = "mcpServer/elicitation/request"
        let both = connectorRequest()
        XCTAssertEqual(ApprovalPolicy.response(method: method, params: both, answer: .once), .object(["action": .string("accept"), "content": .null, "_meta": .null]))
        XCTAssertEqual(ApprovalPolicy.response(method: method, params: both, answer: .always),
                       .object(["action": .string("accept"), "content": .null, "_meta": .object(["persist": .string("always")])]))
        XCTAssertEqual(ApprovalPolicy.response(method: method, params: both, answer: .deny), .object(["action": .string("decline"), "content": .null, "_meta": .null]))
        // Only the session's choice offered: Always allow keeps it for the session. Nothing offered: a plain accept.
        XCTAssertEqual(ApprovalPolicy.response(method: method, params: connectorRequest(persist: .array([.string("session")])), answer: .always)["_meta"],
                       .object(["persist": .string("session")]))
        XCTAssertEqual(ApprovalPolicy.response(method: method, params: connectorRequest(persist: .array([])), answer: .always)["_meta"], .null)
    }

    func testTheRealCodexRequestIsReadAsItIsSent() throws {
        // Captured from codex-cli 0.144.1 (tests/mcp-tool-approval.e2e.test.ts): no tool name, title or connector in _meta.
        let request: JSONValue = .object([
            "threadId": .string("t"), "serverName": .string("probe"), "mode": .string("form"),
            "message": .string("Allow the probe MCP server to run tool \"probe_echo\"?"),
            "requestedSchema": .object(["type": .string("object"), "properties": .object([:])]),
            "_meta": .object(["codex_approval_kind": .string("mcp_tool_call"), "persist": .array([.string("session"), .string("always")]),
                              "tool_description": .string("Echo a marker back"),
                              "tool_params": .object(["text": .string("hi")]),
                              "tool_params_display": .array([.object(["name": .string("text"), "value": .string("hi"), "display_name": .string("text")])])]),
        ])
        let tool = try XCTUnwrap(ConnectorToolApproval(method: "mcpServer/elicitation/request", params: request))
        XCTAssertEqual(tool.tool, "probe_echo")
        XCTAssertEqual(tool.connectorName, "probe")
        XCTAssertEqual(tool.rows, [.init(label: "text", value: "hi")])
        XCTAssertEqual(tool.alwaysScope, "always")
    }

    func testPermissionRequestsAreGrantedAsRequestedOrDeniedEmpty() {
        let params: JSONValue = .object(["permissions": .object([
            "network": .object(["enabled": .bool(true)]),
            "fileSystem": .object(["read": .array([.string("/tmp/a")]), "write": .null]),
        ])])
        let allow = ApprovalPolicy.response(method: "item/permissions/requestApproval", params: params, allow: true)
        XCTAssertEqual(allow["scope"].string, "turn")
        XCTAssertEqual(allow["permissions"]["network"]["enabled"].bool, true)
        XCTAssertEqual(allow["permissions"]["fileSystem"]["read"].array?.first?.string, "/tmp/a")
        XCTAssertEqual(allow["permissions"]["fileSystem"]["write"], .null)
        XCTAssertEqual(ApprovalPolicy.response(method: "item/permissions/requestApproval", params: params, allow: false)["permissions"], .object([:]))
        let rows = ApprovalPolicy.permissionRows(params["permissions"])
        XCTAssertEqual(rows.map(\.kind), [.network, .read])
        XCTAssertEqual(ApprovalPolicy.permissionTitle(rows), .generic)
        XCTAssertEqual(ApprovalPolicy.permissionTitle(Array(rows.prefix(1))), .network)
    }

    func testShortSingleLineCommandsGoInTheHeader() {
        XCTAssertEqual(ApprovalPolicy.headerContent("  npm test "), "npm test")
        XCTAssertNil(ApprovalPolicy.headerContent("echo a\necho b"))
        XCTAssertNil(ApprovalPolicy.headerContent(String(repeating: "x", count: 49)))
        XCTAssertNil(ApprovalPolicy.headerContent(""))
    }

    func testQuestionsAreAnsweredOnePerIdAndDismissAnswersNone() {
        let params: JSONValue = .object(["questions": .array([
            .object(["id": .string("a"), "question": .string("Pick"), "options": .array([.object(["label": .string("X"), "description": .string("why")])])]),
            .object(["id": .string("b"), "question": .string("Name?"), "isSecret": .bool(true)]),
        ])])
        let questions = ApprovalPolicy.questions(params)
        XCTAssertEqual(questions.map(\.id), ["a", "b"])
        XCTAssertEqual(questions[0].options.first?.detail, "why")
        XCTAssertFalse(questions[0].allowsOther)
        XCTAssertTrue(questions[1].allowsOther)
        let answered = ApprovalPolicy.questionResponse(questions, answers: ["a": "X", "b": "  Ann "])
        XCTAssertEqual(answered["answers"]["a"]["answers"].array?.first?.string, "X")
        XCTAssertEqual(answered["answers"]["b"]["answers"].array?.first?.string, "Ann")
        let dismissed = ApprovalPolicy.questionResponse(questions, answers: ["a": "X"], dismissed: true)
        XCTAssertEqual(dismissed["answers"]["a"]["answers"].array?.count, 0)
        XCTAssertEqual(dismissed["answers"]["b"]["answers"].array?.count, 0)
    }
}
