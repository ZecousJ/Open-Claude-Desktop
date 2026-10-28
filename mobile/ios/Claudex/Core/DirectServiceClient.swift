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
        let allowed = ["api/v1/claudex/status", "api/v1/claudex/web/github", "api/v1/claudex/web/github/connect", "api/v1/claudex/web/github/repos", "api/v1/claudex/web/github/branches", "api/v1/groups/available", "api/v1/groups/rates", SessionReviewPolicy.path]
        guard (allowed.contains(path) || AccountToolsRoute.allows(path, query: query, method: method, body: body)), ["GET", "POST", "DELETE"].contains(method) else { throw ServiceError.invalidResponse }
        guard !path.hasPrefix("api/v1/groups/") || (method == "GET" && body == nil) else { throw ServiceError.invalidResponse }
        var parts = URLComponents(url: rpc.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: parts.url!); request.httpMethod = method
        request.setValue(rpc.tabID, forHTTPHeaderField: "X-Claudex-Web-Tab")
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, status) = try await rpc.authorizedRequest(request, generation: generation)
        guard status != 401 else { throw ServiceError.signedOut }
        let value = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(status), value["code"].number == 0 else { throw ServiceError.server(value["message"].string ?? CoreText.string(.serverUnexpected), value["reason"].string) }
        return value["data"]
    }
}
public struct RepositoryReference: Codable, Equatable, Sendable {
    public let url: String
    public let ref: String?
    public init(url: String, ref: String?) { self.url = url; self.ref = ref }
}
