import Foundation

/// What the phone answers for the app server's requests, and the exact JSON each answer sends
/// (the same responses as the web card, `shared/approval-response.ts`): Allow once, Always allow for
/// this session (where the administrator allows it) and Deny for commands, file edits and extra
/// permissions; a connector tool's approval (Always allow / Allow once / Decline, see
/// `ConnectorToolApproval`); a tool's form (`ElicitationForm`); and a task's own questions, answered
/// one page at a time.
public enum ApprovalKind: Sendable, Equatable { case command, fileChange, permissions, elicitation, question, other }

/// What a button sends. `session` is the Code card's "Always allow for this session" (Codex
/// `acceptForSession`, permissions `scope: session`); `always` is a connector tool's "Always allow"
/// (the request's own `persist` choice).
public enum ApprovalAnswer: Sendable, Equatable { case once, session, always, deny }

public enum ApprovalPolicy {
    public static func kind(_ method: String) -> ApprovalKind {
        switch method {
        case "item/commandExecution/requestApproval": .command
        case "item/fileChange/requestApproval": .fileChange
        case "item/permissions/requestApproval": .permissions
        case "mcpServer/elicitation/request": .elicitation
        case "item/tool/requestUserInput", "tool/requestUserInput": .question
        default: .other
        }
    }

    /// The phone answers the request with buttons or a form. [extended] is false for a computer's
    /// approvals, whose extra permissions (folders, network) are reviewed on the computer itself.
    public static func answerable(method: String, params: JSONValue, extended: Bool = true) -> Bool {
        switch kind(method) {
        case .command, .fileChange: true
        case .permissions: extended
        case .elicitation:
            // A page to open must be http or https; a form is made of fields the phone has controls for.
            params["mode"].string == "url" ? ElicitationForm.openablePage(params["url"].string) != nil : true
        case .question, .other: false
        }
    }

    /// Whether the card offers "Always allow for this session": Codex has the grant for commands,
    /// file edits and permissions, and the administrator can turn it off (`approvalsAlwaysAllow` of
    /// the client policy; the engine refuses it again). A policy not read yet allows it, as the open
    /// policy does.
    public static func sessionOffered(method: String, policy: JSONValue?) -> Bool {
        switch kind(method) {
        case .command, .fileChange, .permissions: policy?["approvalsAlwaysAllow"].bool != false
        default: false
        }
    }

    /// Short single-line commands go in the header ("Allow Claudex to run `x`?"); long ones only in the input block.
    public static func headerContent(_ command: String) -> String? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && !trimmed.contains("\n") && trimmed.count <= 48 ? trimmed : nil
    }

    /// The JSON-RPC result of Allow once ([allow]) or Deny.
    public static func response(method: String, params: JSONValue, allow: Bool) -> JSONValue {
        response(method: method, params: params, answer: allow ? .once : .deny)
    }

    /// The JSON-RPC result of a button (`approvalResponse` of `shared/approval-response.ts`).
    public static func response(method: String, params: JSONValue, answer: ApprovalAnswer) -> JSONValue {
        switch kind(method) {
        case .permissions:
            if answer == .deny { return .object(["permissions": .object([:]), "scope": .string("turn")]) }
            return .object(["permissions": grantedPermissions(params["permissions"]),
                            "scope": .string(answer == .session ? "session" : "turn")])
        case .elicitation:
            // A connector tool's choice outlives the request through `_meta.persist`.
            if let tool = ConnectorToolApproval(method: method, params: params) { return tool.response(answer) }
            return .object(["action": .string(answer == .deny ? "decline" : "accept"), "content": .null, "_meta": .null])
        default:
            return .object(["decision": .string(answer == .deny ? "decline" : answer == .session ? "acceptForSession" : "accept")])
        }
    }

    /// The requested permission profile as a grant; the app server rejects null members in it.
    public static func grantedPermissions(_ requested: JSONValue) -> JSONValue {
        var granted: [String: JSONValue] = [:]
        if case .object = requested["network"] { granted["network"] = requested["network"] }
        if let fileSystem = requested["fileSystem"].object {
            var out: [String: JSONValue] = ["read": .null, "write": .null]
            for (key, value) in fileSystem where value != .null { out[key] = value }
            granted["fileSystem"] = .object(out)
        }
        return .object(granted)
    }

    public struct PermissionRow: Equatable, Sendable {
        public enum Kind: String, Sendable { case network, read, write, block }
        public enum Special: String, Sendable { case root, minimal, tmpdir, projectRoots }
        public let kind: Kind
        public let value: String
        public let special: Special?
    }

    public static func permissionRows(_ requested: JSONValue) -> [PermissionRow] {
        var rows: [PermissionRow] = []
        if requested["network"]["enabled"].bool == true { rows.append(.init(kind: .network, value: "", special: nil)) }
        let fileSystem = requested["fileSystem"]
        for path in fileSystem["read"].array ?? [] { if let text = path.string { rows.append(.init(kind: .read, value: text, special: nil)) } }
        for path in fileSystem["write"].array ?? [] { if let text = path.string { rows.append(.init(kind: .write, value: text, special: nil)) } }
        for entry in fileSystem["entries"].array ?? [] {
            let kind: PermissionRow.Kind = switch entry["access"].string { case "write": .write; case "deny": .block; default: .read }
            let path = entry["path"]
            if path["type"].string == "special" {
                let value = path["value"]
                let special: PermissionRow.Special? = switch value["kind"].string {
                case "root": .root; case "minimal": .minimal; case "tmpdir": .tmpdir; case "project_roots": .projectRoots; default: nil }
                let text = value["subpath"].string.flatMap { $0.isEmpty ? nil : $0 } ?? (special == nil ? value["path"].string ?? "" : "")
                rows.append(.init(kind: kind, value: text, special: special))
            } else if path["type"].string == "glob_pattern" {
                rows.append(.init(kind: kind, value: path["pattern"].string ?? "", special: nil))
            } else {
                rows.append(.init(kind: kind, value: path["path"].string ?? entry["path"].string ?? "", special: nil))
            }
        }
        return rows
    }

    public enum PermissionTitle: Sendable { case network, files, generic }
    public static func permissionTitle(_ rows: [PermissionRow]) -> PermissionTitle {
        let network = rows.contains { $0.kind == .network }, files = rows.contains { $0.kind != .network }
        return network && !files ? .network : files && !network ? .files : .generic
    }

    // MARK: A task's questions (request_user_input)

    public struct Question: Equatable, Sendable {
        public struct Option: Equatable, Sendable { public let label: String; public let detail: String? }
        public let id: String
        public let question: String
        public let options: [Option]
        public let isOther: Bool
        public let isSecret: Bool
        /// A free answer row is shown when there are no options, or the service allows another answer.
        public var allowsOther: Bool { options.isEmpty || isOther }
    }

    public static func questions(_ params: JSONValue) -> [Question] {
        (params["questions"].array ?? []).compactMap { raw in
            guard let id = raw["id"].string else { return nil }
            let options = (raw["options"].array ?? []).compactMap { option -> Question.Option? in
                guard let label = option["label"].string else { return nil }
                let detail = option["description"].string.flatMap { $0.isEmpty ? nil : $0 }
                return .init(label: label, detail: detail)
            }
            return Question(id: id, question: raw["question"].string ?? "", options: options,
                            isOther: raw["isOther"].bool ?? false, isSecret: raw["isSecret"].bool ?? false)
        }
    }

    /// The answer to all questions; [dismissed] answers none of them (Dismiss).
    public static func questionResponse(_ questions: [Question], answers: [String: String], dismissed: Bool = false) -> JSONValue {
        var out: [String: JSONValue] = [:]
        for question in questions {
            let value = dismissed ? "" : (answers[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            out[question.id] = .object(["answers": .array(value.isEmpty ? [] : [.string(value)])])
        }
        return .object(["answers": .object(out)])
    }
}
