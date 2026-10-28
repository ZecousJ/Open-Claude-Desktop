import Foundation

/// Web/desktop contracts: shared/research.ts and client-policy.ts. The phone has no web search or research switch;
/// this only says where the web composer shows them.
public enum ComposerTools {
    /// Match the web composer: research belongs to Chat, search to Chat/Cowork.
    public static func visible(mode: ChatMode, research: Bool) -> Bool {
        research ? mode == .chat : mode != .code
    }
}
public struct AccountAPIKey: Identifiable, Sendable, Equatable {
    public let id: Int
    public let name: String
    public let key: String
    public let groupID: Int?
    public let groupName: String
    public let status: String
    public let createdAt: String?
    public let lastUsedAt: String?
    public var masked: String { key.utf16.count <= 12 ? String(repeating: "•", count: max(8, key.count)) : String(key.prefix(5)) + "…" + String(key.suffix(4)) }
}
public enum APIKeyContract {
    public static func isDevice(_ name: String) -> Bool { ["claudex-web:", "claudex-device:", "claudex-desktop:"].contains { name.hasPrefix($0) } }
    public static func validatedName(_ name: String) throws -> String {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf16.count <= 100, !isDevice(value) else { throw ServiceError.server(CoreText.string(.keyNameInvalid), nil) }
        return value
    }
    private static func timestamp(_ raw: String?) -> TimeInterval {
        guard let raw else { return 0 }
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: raw) { return date.timeIntervalSince1970 }
        parser.formatOptions = [.withInternetDateTime]; return parser.date(from: raw)?.timeIntervalSince1970 ?? 0
    }
    public static func normalize(_ items: [JSONValue], groups: [Int: String]) -> [AccountAPIKey] {
        items.compactMap { item in
            guard let id = item["id"].integer, id > 0, id <= 9_007_199_254_740_991,
                  let name = item["name"].string, !isDevice(name), let key = item["key"].string else { return nil }
            let groupID = item["group_id"].integer
            let status = item["status"].string ?? "active"
            return AccountAPIKey(id: id, name: String(name.prefix(200)), key: key, groupID: groupID,
                groupName: item["group"]["name"].string.flatMap { $0.isEmpty ? nil : $0 } ?? groupID.flatMap { groups[$0] } ?? "",
                status: status == "quota_exhausted" ? "exhausted" : ["inactive", "expired"].contains(status) ? status : "active",
                createdAt: item["created_at"].string, lastUsedAt: item["last_used_at"].string)
        }.sorted { timestamp($0.createdAt) > timestamp($1.createdAt) }
    }
}
public struct UsageRecord: Identifiable, Sendable, Equatable {
    public let raw: JSONValue
    public var id: Int { raw["id"].integer! }
    public var model: String { raw["model"].string ?? "" }
    public var createdAt: String? { raw["created_at"].string }
    public var inputTokens: Double? { raw["input_tokens"].number }
    public var outputTokens: Double? { raw["output_tokens"].number }
    public var cacheTokens: Double? {
        let write = raw["cache_creation_tokens"].number, read = raw["cache_read_tokens"].number
        return write == nil && read == nil ? nil : (write ?? 0) + (read ?? 0)
    }
    public var cost: Double? { raw["actual_cost"].number }
    public var standardCost: Double? { raw["total_cost"].number }
}
public struct UsageRecordPage: Sendable, Equatable {
    public let items: [UsageRecord]
    public let total: Int?
    public let page: Int
    public let pages: Int
    public init(_ value: JSONValue) throws {
        guard value.object != nil, let rows = value["items"].array else { throw ServiceError.invalidResponse }
        items = rows.prefix(100).compactMap { row in
            guard let id = row["id"].integer, id > 0, id <= 9_007_199_254_740_991 else { return nil }
            return UsageRecord(raw: row)
        }
        total = value["total"].integer; page = max(1, value["page"].integer ?? 1); pages = max(1, value["pages"].integer ?? 1)
    }
}
public struct UsageRecordQuery: Sendable {
    public var page: Int = 1
    public var pageSize: Int = 20
    public var start: String? = nil
    public var end: String? = nil
    public var model: String? = nil
    public init(page: Int = 1, pageSize: Int = 20, start: String? = nil, end: String? = nil, model: String? = nil) { self.page = page; self.pageSize = pageSize; self.start = start; self.end = end; self.model = model }
    public func parameters(timezone: String) throws -> [String: String] {
        guard page > 0, page <= 9_007_199_254_740_991, (1...100).contains(pageSize), TimeZone(identifier: timezone) != nil else { throw ServiceError.invalidResponse }
        var query = ["page": String(page), "page_size": String(pageSize), "timezone": timezone]
        for (key, value) in [("start_date", start), ("end_date", end)] {
            if let value {
                guard value.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
                let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(secondsFromGMT: 0); f.dateFormat = "yyyy-MM-dd"; f.isLenient = false
                guard let date = f.date(from: value), f.string(from: date) == value else { throw ServiceError.invalidResponse }
                query[key] = value
            }
        }
        if let start, let end, start > end { throw ServiceError.invalidResponse }
        if let model { guard model.utf16.count <= 200 else { throw ServiceError.invalidResponse }; if !model.isEmpty { query["model"] = model } }
        return query
    }
}
/// Narrow allowlist: these browser-owned routes are not runner RPCs.
public enum AccountToolsRoute {
    public static func allows(_ path: String, query: [String: String], method: String, body: JSONValue?) -> Bool {
        if path == "api/v1/usage", method == "GET", body == nil {
            guard Set(query.keys).isSubset(of: ["page", "page_size", "timezone", "start_date", "end_date", "model"]),
                  let page = Int(query["page"] ?? ""), let size = Int(query["page_size"] ?? ""), let timezone = query["timezone"] else { return false }
            return (try? UsageRecordQuery(page: page, pageSize: size, start: query["start_date"], end: query["end_date"], model: query["model"]).parameters(timezone: timezone)) != nil
        }
        if path == "api/v1/keys" {
            if method == "GET", body == nil { return Set(query.keys) == Set(["page", "page_size"]) && (1...50).contains(Int(query["page"] ?? "") ?? 0) && query["page_size"] == "100" }
            if method == "POST", query.isEmpty, let fields = body?.object {
                return Set(fields.keys) == Set(["name", "group_id"]) && (try? APIKeyContract.validatedName(body?["name"].string ?? "")) != nil && (body?["group_id"].integer ?? 0) > 0 && (body?["group_id"].number ?? .infinity) <= 9_007_199_254_740_991
            }
        }
        if path.hasPrefix("api/v1/keys/"), method == "DELETE", query.isEmpty, body == nil {
            let component = String(path.dropFirst("api/v1/keys/".count))
            return component.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil && (Int(component) ?? 0) > 0 && (Double(component) ?? .infinity) <= 9_007_199_254_740_991
        }
        return false
    }
}
public extension RemoteClaudexService {
    func setConversationTool(_ id: String, enabled: Bool, research: Bool, providerID: String, model: String) async throws -> Conversation {
        guard !id.isEmpty, !providerID.isEmpty, !model.isEmpty, model.utf16.count <= 200 else { throw ServiceError.invalidResponse }
        return try await rpc.call(research ? "setConversationResearch" : "setConversationWebSearch", args: research ? [.string(id), .bool(enabled)] : [.string(id), .bool(enabled), .string(providerID), .string(model)], as: Conversation.self)
    }
    func setImageModel(_ model: String) async throws -> APIGroups {
        guard !model.isEmpty, model.utf16.count <= 200, model.range(of: "^[A-Za-z0-9_.:/-]+$", options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
        return try await rpc.call("setImageModel", args: [.string(model)], as: APIGroups.self)
    }
    func apiKeys() async throws -> [AccountAPIKey] { try await apiKeysBound(generation: rpc.session.sessionGeneration()) }
    private func apiKeysBound(generation: Int?) async throws -> [AccountAPIKey] {
        let direct = DirectServiceClient(rpc: rpc)
        let available = try await direct.requestBound("api/v1/groups/available", generation: generation)
        let groups = Dictionary((available.array ?? []).compactMap { group -> (Int, String)? in
            guard let id = group["id"].integer, let name = group["name"].string else { return nil }; return (id, name)
        }, uniquingKeysWith: { _, last in last })
        var items: [JSONValue] = [], page = 1, pages = 1
        repeat {
            let read = try await direct.requestBound("api/v1/keys", query: ["page": String(page), "page_size": "100"], generation: generation)
            guard let rows = read["items"].array else { throw ServiceError.invalidResponse }
            items.append(contentsOf: rows.prefix(100)); pages = max(1, read["pages"].integer ?? 1); page += 1
        } while page <= min(50, pages)
        // Don't claim a complete list when the service exceeds the bounded read.
        guard pages <= 50 else { throw ServiceError.server(CoreText.string(.keysOverLimit), nil) }
        try await rpc.verifyGeneration(generation)
        return APIKeyContract.normalize(items, groups: groups)
    }
    func createAPIKey(name: String, groupID: Int) async throws -> AccountAPIKey {
        let name = try APIKeyContract.validatedName(name)
        guard groupID > 0, groupID <= 9_007_199_254_740_991 else { throw ServiceError.invalidResponse }
        let generation = await rpc.session.sessionGeneration(), direct = DirectServiceClient(rpc: rpc)
        let available = try await direct.requestBound("api/v1/groups/available", generation: generation)
        guard available.array?.contains(where: { $0["id"].integer == groupID }) == true else { throw ServiceError.server(CoreText.string(.groupUnavailable), nil) }
        let created = try await direct.requestBound("api/v1/keys", method: "POST", body: .object(["name": .string(name), "group_id": .number(Double(groupID))]), generation: generation)
        guard let made = try await apiKeysBound(generation: generation).first(where: { $0.id == created["id"].integer }) else { throw ServiceError.server(CoreText.string(.keyCreatedNotRead), nil) }
        return made
    }
    func deleteAPIKey(_ id: Int) async throws {
        guard id > 0, id <= 9_007_199_254_740_991 else { throw ServiceError.invalidResponse }
        let generation = await rpc.session.sessionGeneration()
        guard try await apiKeysBound(generation: generation).contains(where: { $0.id == id }) else { throw ServiceError.server(CoreText.string(.keyGone), nil) }
        _ = try await DirectServiceClient(rpc: rpc).requestBound("api/v1/keys/\(id)", method: "DELETE", generation: generation)
    }
    func usageRecords(_ query: UsageRecordQuery, timezone: String = TimeZone.current.identifier) async throws -> UsageRecordPage {
        let params = try query.parameters(timezone: timezone)
        return try UsageRecordPage(await DirectServiceClient(rpc: rpc).request("api/v1/usage", query: params))
    }
}
