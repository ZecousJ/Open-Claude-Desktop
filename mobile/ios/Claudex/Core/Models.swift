import Foundation

public enum ChatMode: String, Codable, CaseIterable, Sendable { case chat, cowork, code }
public struct Attachment: Codable, Identifiable, Sendable, Equatable {
    /// Unrecognized wire fields survive decode, native edits, hydration and re-encode.
    public var extensionFields: [String: JSONValue] = [:]
    public let id: String
    public let name: String
    public let path: String
    public let kind: String
    public let size: Int
    public var extraction: JSONValue?
}
public struct TranscriptItem: Codable, Identifiable, Sendable, Equatable {
    public let raw: JSONValue
    public var id: String { raw["id"].string ?? "unknown" }
    public var type: String { raw["type"].string ?? "unknown" }
    public var text: String? { raw["text"].string }
    public var summary: String { raw["progress"].string ?? raw["description"].string ?? raw["tool"].string ?? type }
    public var generatedFiles: [GeneratedFile] { (raw["generatedFiles"].array ?? []).compactMap { try? $0.decode(GeneratedFile.self) } }
    public var changes: [JSONValue] { raw["changes"].array ?? [] }
    public init(from decoder: Decoder) throws { raw = try JSONValue(from: decoder) }
    public func encode(to encoder: Encoder) throws { try raw.encode(to: encoder) }
}
public struct Turn: Codable, Identifiable, Sendable, Equatable {
    /// Unrecognized wire fields survive decode, native edits, hydration and re-encode.
    public var extensionFields: [String: JSONValue] = [:]
    public let id: String
    public let prompt: String
    public let attachments: [Attachment]
    public var items: [TranscriptItem]
    public var status: String
    public let createdAt: Double
    public var error: String?
    public var reconnecting: String?
    public var responseGroupId: String?
    public var promptGroupId: String?
    public var promptVersionId: String?
    public var stopReason: String?
    public var outputTokens: Int?
    public var inputTokens: Int?
    public var isRunning: Bool { status == "inProgress" }
}
public struct Conversation: Codable, Identifiable, Sendable, Equatable {
    /// Unrecognized wire fields survive decode, native edits, hydration and re-encode.
    public var extensionFields: [String: JSONValue] = [:]
    public let id: String
    public var title: String
    public let mode: ChatMode
    public var providerId: String
    public var model: String
    public var pinned: Bool
    public var archived: Bool
    public let createdAt: Double
    public var updatedAt: Double
    public var turns: [Turn]
    public var projectId: String?
    /// True means command fields were truncated in the upstream lightweight snapshot.
    public var slim: Bool?
    public var activeBranchId: String?
    public var branchVisit: Double?
    public var savedBranches: [JSONValue]?
    public var isRunning: Bool { turns.contains(where: \.isRunning) }
    /// Optional server fields stay in the lossless wire extension map.
    public var unread: Bool { extensionFields["unread"]?.bool == true }
    public var incognito: Bool { extensionFields["incognito"]?.bool == true }
    public var date: Date { Date(timeIntervalSince1970: updatedAt / 1000) }
}
/// conversationTurns returns only transcript fields, never a full Conversation.
public struct ConversationTurns: Codable, Sendable, Equatable {
    public let turns: [Turn]
    public let savedBranches: [JSONValue]?
    public init(turns: [Turn], savedBranches: [JSONValue]? = nil) { self.turns = turns; self.savedBranches = savedBranches }
}
public struct Project: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let description: String
    public let instructions: String
    public let createdAt: Double
    public let cwd: String?
    public let environment: JSONValue?
}
public struct ProviderRoute: Codable, Sendable, Equatable {
    public let models: [String]
    public let `protocol`: String
}
public struct Provider: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let model: String
    public let models: [String]
    public var `protocol`: String? = nil
    public var routes: [ProviderRoute]? = nil
    public func protocolForModel(_ model: String) -> String? { routes?.first { $0.models.contains(model) }?.protocol ?? self.protocol }
}
public struct Settings: Codable, Sendable, Equatable {
    public var raw: JSONValue
    public var name: String { raw["name"].string ?? "" }
    public var activeProviderId: String { raw["activeProviderId"].string ?? "" }
    public var providers: [Provider] { (try? raw["providers"].decode([Provider].self)) ?? [] }
    public var effort: String { raw["effort"].string ?? "" }
    public var codeEffort: String { raw["codeEffort"].string ?? "" }
    public init(from decoder: Decoder) throws { raw = try JSONValue(from: decoder) }
    public func encode(to encoder: Encoder) throws { try raw.encode(to: encoder) }
    public func replacingEffort(_ effort: String, mode: ChatMode) -> Settings {
        var fields = raw.object ?? [:]; fields[mode == .code ? "codeEffort" : "effort"] = .string(effort)
        var copy = self; copy.raw = .object(fields); return copy
    }
    public func replacingSelectedModel(providerID: String, modelID: String) throws -> Settings {
        guard let provider = providers.first(where: { $0.id == providerID }), provider.models.contains(modelID),
              var fields = raw.object, var values = fields["providers"]?.array,
              let index = values.firstIndex(where: { $0["id"].string == providerID }), var selected = values[index].object else { throw ServiceError.invalidResponse }
        fields["activeProviderId"] = .string(providerID); selected["model"] = .string(modelID)
        values[index] = .object(selected); fields["providers"] = .array(values)
        var copy = self; copy.raw = .object(fields); return copy
    }
}
/// The model last chosen on this device, per account. The account's provider
/// list is rebuilt from its groups, which puts each provider's default model
/// back, so the choice is remembered here as on Android and the web.
public enum SavedModelChoice {
    public static func key(account: String) -> String? {
        let name = account.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return name.isEmpty ? nil : "selectedModel." + name
    }
    public static func encode(providerID: String, modelID: String) -> String { providerID + "\n" + modelID }
    /// The saved choice while that provider still offers that model.
    public static func restore(_ raw: String?, providers: [Provider]) -> (providerID: String, modelID: String)? {
        guard let parts = raw?.components(separatedBy: "\n"), parts.count == 2,
              providers.first(where: { $0.id == parts[0] })?.models.contains(parts[1]) == true else { return nil }
        return (parts[0], parts[1])
    }
}
public struct ModelCatalog: Codable, Sendable, Equatable {
    public let defaultModel: String?
    public let items: [ModelItem]
}
public struct ModelItem: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let displayName: String
    public let description: String
    public let badges: [String]
    public let sort: Int
    public let hidden: Bool
    public let isDefault: Bool
    public let usageHint: String
    public let efforts: [String]?
    public let defaultEffort: String?
    public let contextWindow: Int?
    public var webSearch: String? = nil
}
public struct Snapshot: Codable, Sendable, Equatable {
    public var settings: Settings
    public var conversations: [Conversation]
    public var projects: [Project]
    public var artifactLibrary: JSONValue
    public var artifactShares: [JSONValue]?
    public var engine: JSONValue
    public var approvals: [JSONValue]
    public var replyFeedback: [String: ReplyRating]?
    public var modelUnavailable: String?
    public var cloudSessions: [JSONValue]?
    public var host: JSONValue?
}
public struct SendInput: Codable, Sendable {
    public var conversationId: String?
    public var text: String
    public var mode: ChatMode
    public var projectId: String?
    public var attachments: [Attachment]
    public var providerId: String
    public var model: String
    public var repository: RepositoryReference?
    public var webSearch: Bool?
    public var research: Bool?
    public init(conversationId: String? = nil, text: String, mode: ChatMode, projectId: String? = nil, attachments: [Attachment], providerId: String, model: String, repository: RepositoryReference? = nil, webSearch: Bool? = nil, research: Bool? = nil) {
        self.conversationId = conversationId; self.text = text; self.mode = mode; self.projectId = projectId
        self.attachments = attachments; self.providerId = providerId; self.model = model; self.repository = repository; self.webSearch = webSearch; self.research = research
    }
}


public extension Attachment {
    init(from decoder: Decoder) throws {
        let wire = try JSONValue(from: decoder)
        guard let fields = wire.object else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected object")) }
        id = try wire["id"].decode(String.self)
        name = try wire["name"].decode(String.self)
        path = try wire["path"].decode(String.self)
        kind = try wire["kind"].decode(String.self)
        size = try wire["size"].decode(Int.self)
        extraction = wire["extraction"] == .null ? nil : try wire["extraction"].decode(JSONValue.self)
        let known: Set<String> = ["id", "name", "path", "kind", "size", "extraction"]
        extensionFields = fields.filter { !known.contains($0.key) }
    }
    func encode(to encoder: Encoder) throws {
        var wire = extensionFields
        wire["id"] = try JSONValue.encode(id)
        wire["name"] = try JSONValue.encode(name)
        wire["path"] = try JSONValue.encode(path)
        wire["kind"] = try JSONValue.encode(kind)
        wire["size"] = try JSONValue.encode(size)
        if let extraction { wire["extraction"] = try JSONValue.encode(extraction) }
        try JSONValue.object(wire).encode(to: encoder)
    }
}

public extension Turn {
    init(from decoder: Decoder) throws {
        let wire = try JSONValue(from: decoder)
        guard let fields = wire.object else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected object")) }
        id = try wire["id"].decode(String.self)
        prompt = try wire["prompt"].decode(String.self)
        attachments = try wire["attachments"].decode([Attachment].self)
        items = try wire["items"].decode([TranscriptItem].self)
        status = try wire["status"].decode(String.self)
        createdAt = try wire["createdAt"].decode(Double.self)
        error = wire["error"] == .null ? nil : try wire["error"].decode(String.self)
        reconnecting = wire["reconnecting"] == .null ? nil : try wire["reconnecting"].decode(String.self)
        responseGroupId = wire["responseGroupId"] == .null ? nil : try wire["responseGroupId"].decode(String.self)
        promptGroupId = wire["promptGroupId"] == .null ? nil : try wire["promptGroupId"].decode(String.self)
        promptVersionId = wire["promptVersionId"] == .null ? nil : try wire["promptVersionId"].decode(String.self)
        stopReason = wire["stopReason"] == .null ? nil : try wire["stopReason"].decode(String.self)
        outputTokens = wire["outputTokens"] == .null ? nil : try wire["outputTokens"].decode(Int.self)
        inputTokens = wire["inputTokens"] == .null ? nil : try wire["inputTokens"].decode(Int.self)
        let known: Set<String> = ["id", "prompt", "attachments", "items", "status", "createdAt", "error", "reconnecting", "responseGroupId", "promptGroupId", "promptVersionId", "stopReason", "outputTokens", "inputTokens"]
        extensionFields = fields.filter { !known.contains($0.key) }
    }
    func encode(to encoder: Encoder) throws {
        var wire = extensionFields
        wire["id"] = try JSONValue.encode(id)
        wire["prompt"] = try JSONValue.encode(prompt)
        wire["attachments"] = try JSONValue.encode(attachments)
        wire["items"] = try JSONValue.encode(items)
        wire["status"] = try JSONValue.encode(status)
        wire["createdAt"] = try JSONValue.encode(createdAt)
        if let error { wire["error"] = try JSONValue.encode(error) }
        if let reconnecting { wire["reconnecting"] = try JSONValue.encode(reconnecting) }
        if let responseGroupId { wire["responseGroupId"] = try JSONValue.encode(responseGroupId) }
        if let promptGroupId { wire["promptGroupId"] = try JSONValue.encode(promptGroupId) }
        if let promptVersionId { wire["promptVersionId"] = try JSONValue.encode(promptVersionId) }
        if let stopReason { wire["stopReason"] = try JSONValue.encode(stopReason) }
        if let outputTokens { wire["outputTokens"] = try JSONValue.encode(outputTokens) }
        if let inputTokens { wire["inputTokens"] = try JSONValue.encode(inputTokens) }
        try JSONValue.object(wire).encode(to: encoder)
    }
}

public extension Conversation {
    init(from decoder: Decoder) throws {
        let wire = try JSONValue(from: decoder)
        guard let fields = wire.object else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected object")) }
        id = try wire["id"].decode(String.self)
        title = try wire["title"].decode(String.self)
        mode = try wire["mode"].decode(ChatMode.self)
        providerId = try wire["providerId"].decode(String.self)
        model = try wire["model"].decode(String.self)
        pinned = try wire["pinned"].decode(Bool.self)
        archived = try wire["archived"].decode(Bool.self)
        createdAt = try wire["createdAt"].decode(Double.self)
        updatedAt = try wire["updatedAt"].decode(Double.self)
        turns = try wire["turns"].decode([Turn].self)
        projectId = wire["projectId"] == .null ? nil : try wire["projectId"].decode(String.self)
        slim = wire["slim"] == .null ? nil : try wire["slim"].decode(Bool.self)
        activeBranchId = wire["activeBranchId"] == .null ? nil : try wire["activeBranchId"].decode(String.self)
        branchVisit = wire["branchVisit"] == .null ? nil : try wire["branchVisit"].decode(Double.self)
        savedBranches = wire["savedBranches"] == .null ? nil : try wire["savedBranches"].decode([JSONValue].self)
        let known: Set<String> = ["id", "title", "mode", "providerId", "model", "pinned", "archived", "createdAt", "updatedAt", "turns", "projectId", "slim", "activeBranchId", "branchVisit", "savedBranches"]
        extensionFields = fields.filter { !known.contains($0.key) }
    }
    func encode(to encoder: Encoder) throws {
        var wire = extensionFields
        wire["id"] = try JSONValue.encode(id)
        wire["title"] = try JSONValue.encode(title)
        wire["mode"] = try JSONValue.encode(mode)
        wire["providerId"] = try JSONValue.encode(providerId)
        wire["model"] = try JSONValue.encode(model)
        wire["pinned"] = try JSONValue.encode(pinned)
        wire["archived"] = try JSONValue.encode(archived)
        wire["createdAt"] = try JSONValue.encode(createdAt)
        wire["updatedAt"] = try JSONValue.encode(updatedAt)
        wire["turns"] = try JSONValue.encode(turns)
        if let projectId { wire["projectId"] = try JSONValue.encode(projectId) }
        if let slim { wire["slim"] = try JSONValue.encode(slim) }
        if let activeBranchId { wire["activeBranchId"] = try JSONValue.encode(activeBranchId) }
        if let branchVisit { wire["branchVisit"] = try JSONValue.encode(branchVisit) }
        if let savedBranches { wire["savedBranches"] = try JSONValue.encode(savedBranches) }
        try JSONValue.object(wire).encode(to: encoder)
    }
}

