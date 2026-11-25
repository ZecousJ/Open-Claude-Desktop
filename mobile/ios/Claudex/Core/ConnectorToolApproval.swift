import Foundation

/// A connector tool's approval, as Codex asks it: an MCP elicitation (`mcpServer/elicitation/request`)
/// whose `_meta` carries `codex_approval_kind: "mcp_tool_call"`, the call's parameters and `persist`,
/// the choices that outlive the request ("session" and/or "always"). The answer is `action: accept`
/// with `_meta: { persist }`. The same reading as `shared/mcp-tool-approval.ts` (checked against the real
/// codex-cli 0.144.1 app-server, tests/mcp-tool-approval.e2e.test.ts); the tool's name is only in the
/// message (`Allow the <server> MCP server to run tool "<tool>"?`), a title and connector name only for apps.
public struct ConnectorToolApproval: Equatable, Sendable {
    public struct Row: Equatable, Sendable {
        public let label: String
        public let value: String
    }
    /// The configured server's name (`serverName`).
    public let server: String
    /// The tool's own name, when the request names it.
    public let tool: String?
    public let title: String?
    public let connector: String?
    /// The call's parameters as readable lines (never raw JSON).
    public let rows: [Row]
    public let canSession: Bool
    public let canAlways: Bool

    public init?(method: String, params: JSONValue) {
        guard method == "mcpServer/elicitation/request", params["mode"].string != "url",
              let meta = params["_meta"].object, meta["codex_approval_kind"]?.string == "mcp_tool_call" else { return nil }
        server = Self.text(params["serverName"], limit: 100) ?? ""
        let message = params["message"].string ?? ""
        let named = message.range(of: "to run tool \"([^\"]{1,200})\"", options: .regularExpression).flatMap { range -> String? in
            let hit = String(message[range])
            return hit.split(separator: "\"", omittingEmptySubsequences: false).dropFirst().first.map(String.init)
        }
        tool = Self.text(meta["tool_name"] ?? .null, limit: 200) ?? named
        title = Self.text(meta["tool_title"] ?? .null, limit: 200) ?? tool
        let name = Self.text(meta["connector_name"] ?? .null, limit: 100)
        connector = name == server ? nil : name
        rows = Self.rows(meta)
        let persist = meta["persist"] ?? .null
        let values = persist.array?.compactMap(\.string) ?? persist.string.map { [$0] } ?? []
        canSession = values.contains("session")
        canAlways = values.contains("always")
    }

    /// What the sentence calls the tool.
    public var toolName: String? { title ?? tool }
    /// The connector the sentence names: its own name, else the server's.
    public var connectorName: String? { connector ?? (server.isEmpty ? nil : server) }
    /// "Always allow" keeps the persistent choice when offered, else the session's.
    public var alwaysScope: String? { canAlways ? "always" : canSession ? "session" : nil }

    /// The JSON-RPC result of a button.
    public func response(_ answer: ApprovalAnswer) -> JSONValue {
        if answer == .deny { return .object(["action": .string("decline"), "content": .null, "_meta": .null]) }
        let scope: String? = switch answer {
        case .always: alwaysScope
        case .session: canSession ? "session" : nil
        default: nil
        }
        return .object(["action": .string("accept"), "content": .null,
                        "_meta": scope.map { .object(["persist": .string($0)]) } ?? .null])
    }

    private static func text(_ value: JSONValue, limit: Int) -> String? {
        guard let raw = value.string?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        return String(raw.prefix(limit))
    }

    private static func shown(_ value: JSONValue) -> String {
        let text: String
        switch value {
        case .null: text = ""
        case .string(let v): text = v
        case .bool(let v): text = v ? "true" : "false"
        case .number(let v): text = ElicitationForm.format(v)
        default:
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            text = (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        }
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.count > 400 ? String(flat.prefix(400)) + "…" : flat
    }

    /// `tool_params_display` when Codex sends it, else the raw `tool_params` (sorted: JSON objects are unordered here).
    private static func rows(_ meta: [String: JSONValue]) -> [Row] {
        var out: [Row] = []
        if let list = meta["tool_params_display"]?.array {
            for entry in list.prefix(40) {
                guard let label = text(entry["display_name"], limit: 80) ?? text(entry["name"], limit: 80) else { continue }
                out.append(Row(label: label, value: shown(entry["value"])))
            }
            if !out.isEmpty { return out }
        }
        if let params = meta["tool_params"]?.object {
            for key in params.keys.sorted().prefix(40) { out.append(Row(label: String(key.prefix(80)), value: shown(params[key] ?? .null))) }
        }
        return out
    }
}
