import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Verified non-RPC service routes, restricted to the configured origin.
public struct DirectServiceClient: Sendable {
    public let rpc: RPCClient
    public init(rpc: RPCClient) { self.rpc = rpc }
    public func request(_ path: String, query: [String: String] = [:], method: String = "GET", body: JSONValue? = nil) async throws -> JSONValue {
        let generation = await rpc.session.sessionGeneration()
        return try await requestBound(path, query: query, method: method, body: body, generation: generation)
    }
    func requestBound(_ path: String, query: [String: String] = [:], method: String = "GET", body: JSONValue? = nil, generation: Int?) async throws -> JSONValue {
        let allowed = ["api/v1/claudex/status", "api/v1/claudex/knowledge", "api/v1/claudex/bootstrap", "api/v1/claudex/diagnostics", "api/v1/claudex/feedback", "api/v1/claudex/account", "api/v1/claudex/spend-limit", "api/v1/claudex/memory/cowork", "api/v1/redeem", "api/v1/claudex/web/github", "api/v1/claudex/web/github/connect", "api/v1/claudex/web/github/repos", "api/v1/claudex/web/github/branches", "api/v1/groups/available", "api/v1/groups/rates", SessionReviewPolicy.path]
        guard (allowed.contains(path) || BillingPolicy.allowsPayment(path: path, method: method, query: query, body: body) || AccountToolsRoute.allows(path, query: query, method: method, body: body)), ["GET", "POST", "DELETE", "PUT"].contains(method) else { throw ServiceError.invalidResponse }
        if method == "PUT" && path != "api/v1/claudex/spend-limit" && path != "api/v1/claudex/memory/cowork" { throw ServiceError.invalidResponse }
        if path == "api/v1/claudex/memory/cowork" {
            guard query.isEmpty, CoworkMemoryPolicy.allows(method: method, body: body) else { throw ServiceError.invalidResponse }
        }
        if path == "api/v1/claudex/spend-limit" {
            if method == "GET" { if body != nil || !query.isEmpty { throw ServiceError.invalidResponse } }
            else if method == "PUT" {
                guard let fields = body?.object, fields.count == 1, fields["limit_usd"] != nil else { throw ServiceError.invalidResponse }
                let limit = body?["limit_usd"]
                if case .number(let amount) = limit { if !(amount >= 0 && amount <= 100_000) { throw ServiceError.invalidResponse } }
                else if limit != .null { throw ServiceError.invalidResponse }
            } else { throw ServiceError.invalidResponse }
        }
        if path == "api/v1/redeem" {
            guard method == "POST", query.isEmpty, let fields = body?.object, fields.count == 1, fields["code"] != nil,
                  let code = body?["code"].string, BillingPolicy.acceptsCode(code) else { throw ServiceError.invalidResponse }
        }
        if path == "api/v1/claudex/bootstrap" && method != "GET" { throw ServiceError.invalidResponse }
        if path == "api/v1/claudex/diagnostics" && (method != "POST" || body?["consent"].bool != true) { throw ServiceError.invalidResponse }
        if path == "api/v1/claudex/feedback" && (method != "POST" || body?["consent"].bool != true || body?["conversation_excerpt"] != .null) { throw ServiceError.invalidResponse }
        if path == "api/v1/claudex/account" && (method != "DELETE" || body != nil || !query.isEmpty) { throw ServiceError.invalidResponse }
        guard !path.hasPrefix("api/v1/groups/") || (method == "GET" && body == nil) else { throw ServiceError.invalidResponse }
        var parts = URLComponents(url: rpc.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: parts.url!); request.httpMethod = method
        request.setValue(rpc.tabID, forHTTPHeaderField: "X-Claudex-Web-Tab")
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, status) = try await rpc.authorizedRequest(request, generation: generation)
        guard status != 401 else { throw ServiceError.signedOut }
        let value = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(status), value["code"].number == 0 else {
            throw ServiceError.server(value["message"].string ?? value["error"]["message"].string ?? CoreText.string(.serverUnexpected), value["reason"].string ?? value["error"]["code"].string)
        }
        return value["data"]
    }
}
/// Hosted Cowork account files (`/api/v1/claudex/memory/cowork`): Markdown paths, one write or delete at a time, and the epoch the edit started from.
enum CoworkMemoryPolicy {
    static func validKey(_ key: String) -> Bool {
        guard !key.isEmpty, key.count <= 1024, !key.hasPrefix("/"), key != ".", key != "..", key.lowercased().hasSuffix(".md") else { return false }
        if key.contains("\\") || key.contains("*") || key.contains("?") || key.contains("[") || key.contains("]") || key.contains("\u{0000}") { return false }
        return !key.split(separator: "/", omittingEmptySubsequences: false).contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }
    static func token(_ value: JSONValue?) -> Bool {
        guard let text = value?.string, !text.isEmpty, text.count <= 19, text.allSatisfy(\.isNumber), let number = Int(text), number >= 0, String(number) == text else { return false }
        return true
    }
    static func allows(method: String, body: JSONValue?) -> Bool {
        if method == "GET" { return body == nil }
        guard let fields = body?.object, token(fields["expected_epoch"]) else { return false }
        if method == "DELETE" { return fields.count == 1 }
        guard method == "PUT" else { return false }
        if fields["expected_revision"] != nil && !token(fields["expected_revision"]) { return false }
        let known = Set(fields.keys).subtracting(["expected_epoch", "expected_revision", "entries", "delete_keys"])
        guard known.isEmpty else { return false }
        var written: Set<String> = []
        if let entries = fields["entries"]?.object {
            for (key, value) in entries {
                guard validKey(key), let text = value.string, text.count <= 262_144 else { return false }
                written.insert(key)
            }
        } else if fields["entries"] != nil { return false }
        var deleted: Set<String> = []
        if let keys = fields["delete_keys"]?.array {
            for key in keys {
                guard let text = key.string, validKey(text) else { return false }
                deleted.insert(text)
            }
        } else if fields["delete_keys"] != nil { return false }
        return (!written.isEmpty || !deleted.isEmpty) && written.isDisjoint(with: deleted)
    }
}

public struct RepositoryReference: Codable, Equatable, Sendable {
    public let url: String
    public let ref: String?
    public init(url: String, ref: String?) { self.url = url; self.ref = ref }
}
