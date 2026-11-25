import Foundation

public struct ReplyVersion: Identifiable, Equatable, Sendable {
    public let turnID: String
    public let versionID: String
    public let createdAt: Double
    public let visited: Double
    public var id: String { turnID }
}
public enum ConversationVersions {
    public static func selectedIndex(_ versions: [ReplyVersion], turn: Turn, prompt: Bool) -> Int? {
        let identity = prompt ? turn.promptVersionId ?? turn.responseGroupId ?? turn.id : turn.id
        return versions.firstIndex { $0.versionID == identity }
    }
    /// Mirrors shared/branches.ts including most-recently visited continuation and prompt deduplication.
    public static func versions(_ conversation: Conversation, turn: Turn, prompt: Bool = false) -> [ReplyVersion] {
        let responseGroup = turn.responseGroupId ?? turn.id
        let group = prompt ? turn.promptGroupId ?? responseGroup : responseGroup
        var branches = (conversation.savedBranches ?? []).compactMap { branch -> ([Turn], Double)? in
            guard let turns = try? branch["turns"].decode([Turn].self) else { return nil }
            return (turns, branch["visited"].number ?? 0)
        }
        branches.append((conversation.turns, conversation.branchVisit ?? 0))
        var versions: [String: ReplyVersion] = [:]
        for (turns, visited) in branches {
            guard let candidate = turns.first(where: {
                let response = $0.responseGroupId ?? $0.id
                return (prompt ? $0.promptGroupId ?? response : response) == group
            }) else { continue }
            let key = prompt ? candidate.promptVersionId ?? candidate.responseGroupId ?? candidate.id : candidate.id
            let previous = versions[key]
            if previous == nil || visited >= previous!.visited {
                versions[key] = ReplyVersion(turnID: candidate.id, versionID: key, createdAt: prompt ? min(previous?.createdAt ?? candidate.createdAt, candidate.createdAt) : candidate.createdAt, visited: visited)
            }
        }
        return versions.values.sorted { $0.createdAt == $1.createdAt ? $0.turnID < $1.turnID : $0.createdAt < $1.createdAt }
    }
}
public enum ReplyRating: String, Codable, Sendable { case up, down }
public extension RemoteClaudexService {
    func editPrompt(conversationID: String, turnID: String, text: String, providerID: String, model: String) async throws -> Conversation {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 1_000_000 else { throw ServiceError.invalidResponse }
        return try await rpc.call("editPrompt", args: [.string(conversationID), .string(turnID), .string(text), .string(providerID), .string(model)], as: Conversation.self)
    }
    func retryResponse(conversationID: String, turnID: String, providerID: String, model: String) async throws -> Conversation {
        try await rpc.call("retryResponse", args: [.string(conversationID), .string(turnID), .string(providerID), .string(model)], as: Conversation.self)
    }
    func selectVersion(conversationID: String, turnID: String, versionTurnID: String, prompt: Bool) async throws -> Conversation {
        try await rpc.call(prompt ? "selectPromptVersion" : "selectReplyVersion", args: [.string(conversationID), .string(turnID), .string(versionTurnID)], as: Conversation.self)
    }
    func setReplyFeedback(conversationID: String, turnID: String, rating: ReplyRating?) async throws -> [String: ReplyRating] {
        try await rpc.call("setReplyFeedback", args: [.string(conversationID), .string(turnID), rating.map { .string($0.rawValue) } ?? .null], as: [String: ReplyRating].self)
    }
    func deleteProject(_ id: String) async throws {
        let _: JSONValue = try await rpc.call("deleteProject", args: [.string(id)], as: JSONValue.self)
    }
    func deleteConversation(_ id: String) async throws {
        let _: JSONValue = try await rpc.call("deleteConversation", args: [.string(id)], as: JSONValue.self)
    }
}

public enum DeletionProjection {
    /// Session-local tombstones stop a completed pre-delete refresh/event from resurrecting records.
    public static func apply(_ state: Snapshot, conversations: Set<String>, projects: Set<String>) -> Snapshot {
        var next = state
        next.conversations.removeAll { conversations.contains($0.id) }
        next.projects.removeAll { projects.contains($0.id) }
        for index in next.conversations.indices where projects.contains(next.conversations[index].projectId ?? "") { next.conversations[index].projectId = nil }
        next.replyFeedback = next.replyFeedback?.filter { key, _ in
            guard let data = key.data(using: .utf8), let identity = try? JSONDecoder().decode([String].self, from: data) else { return true }
            return !conversations.contains(identity.first ?? "")
        }
        return next
    }
}

public enum ReplyFeedbackProjection {
    /// A response contains all ratings, but unrelated identities may have changed since it was captured.
    public static func merging(_ response: [String: ReplyRating], into current: [String: ReplyRating], conversationID: String, turnID: String) -> [String: ReplyRating] {
        let key = ArtifactIndex.identity([conversationID, turnID])
        var next = current; next[key] = response[key]; return next
    }
}

public struct StreamMutationTracker: Sendable {
    public private(set) var revision: UInt64 = 0
    private var turns: [String: [String: UInt64]] = [:]
    private var metadata: [String: [String: UInt64]] = [:]
    private var fullMetadata: [String: UInt64] = [:]
    public init() {}
    public mutating func reset() { revision = 0; turns = [:]; metadata = [:]; fullMetadata = [:] }
    /// Called only after StreamReducer accepted a frame, never for replayed/rejected frames.
    public mutating func record(_ frame: JSONValue, snapshot: Snapshot?) {
        revision &+= 1
        if frame["t"].string == "snapshot" {
            for conversation in snapshot?.conversations ?? [] { record(conversation) }
        } else if frame["event"]["type"].string == "conversation", let id = frame["event"]["conversation"]["id"].string,
                  let conversation = snapshot?.conversations.first(where: { $0.id == id }) { record(conversation) }
        else if frame["event"]["type"].string == "conversation-turn", let id = frame["event"]["conversationId"].string,
                let turnID = frame["event"]["turn"]["id"].string {
            turns[id, default: [:]][turnID] = revision
            for key in (frame["event"]["conversation"].object ?? [:]).keys where !["id", "turns", "slim"].contains(key) { metadata[id, default: [:]][key] = revision }
        }
    }
    private mutating func record(_ conversation: Conversation) {
        fullMetadata[conversation.id] = revision
        for turn in conversation.turns { turns[conversation.id, default: [:]][turn.id] = revision }
    }
    public func reconcile(_ response: Conversation, current: Conversation?, since start: UInt64) -> Conversation {
        guard let current, current.id == response.id else { return response }
        let changed = Set((turns[response.id] ?? [:]).filter { $0.value > start }.map(\.key))
        let changedMetadata = Set((metadata[response.id] ?? [:]).filter { $0.value > start }.map(\.key))
        let fullMetadataChanged = (fullMetadata[response.id] ?? 0) > start
        guard !changed.isEmpty || !changedMetadata.isEmpty || fullMetadataChanged else { return response }
        // Branch visits are monotonic in shared/branches.ts. A later authoritative branch must win.
        if let currentVisit = current.branchVisit, let responseVisit = response.branchVisit, currentVisit > responseVisit { return current }
        var next = response, preserved = false
        // Branch membership belongs to the mutation response, unless a later
        // branch visit already won above. Other accepted event metadata is newer
        // than the response's initial snapshot, including unknown extension keys.
        if let encodedCurrent = try? JSONValue.encode(current), let currentWire = encodedCurrent.object,
           let encodedResponse = try? JSONValue.encode(response), var responseWire = encodedResponse.object {
            let branchOwned: Set<String> = ["id", "turns", "activeBranchId", "branchVisit", "savedBranches"]
            let keys = fullMetadataChanged ? Set(currentWire.keys).union(responseWire.keys) : changedMetadata
            for key in keys.subtracting(branchOwned) { responseWire[key] = currentWire[key] }
            if let merged = try? JSONValue.object(responseWire).decode(Conversation.self) { next = merged }
        }
        // The RPC owns branch membership; newer matching streamed turns replace its initial payload.
        for index in next.turns.indices {
            let id = next.turns[index].id
            if changed.contains(id), let streamed = current.turns.first(where: { $0.id == id }) {
                next.turns[index] = streamed; preserved = true
            }
        }
        if preserved {
            next.updatedAt = max(response.updatedAt, current.updatedAt)
            if current.slim == true { next.slim = true } // Never mislabel truncated tool output as complete.
        }
        return next
    }
}


/// HTTP refreshes have no atomic event cursor. A response cannot erase any
/// conversation that received an accepted stream event after its request began.
public struct SnapshotRefreshTracker: Sendable {
    public private(set) var revision: UInt64 = 0
    private var touched: [String: UInt64] = [:]
    private var snapshotRevision: UInt64 = 0
    private var fields: [String: UInt64] = [:]
    public init() {}
    public mutating func recordConversation(_ id: String) { revision &+= 1; touched[id] = revision }
    public mutating func recordField(_ field: String) { revision &+= 1; fields[field] = revision }
    public mutating func reset() { self = Self() }
    public mutating func record(_ frame: JSONValue, snapshot: Snapshot?) {
        revision &+= 1
        if frame["t"].string == "snapshot" { snapshotRevision = revision }
        switch frame["event"]["type"].string {
        case "settings": fields["settings"] = revision
        case "engine": fields["engine"] = revision
        case "approval", "approval-resolved": fields["approvals"] = revision
        default: break
        }
        if frame["t"].string == "snapshot" {
            for c in snapshot?.conversations ?? [] { touched[c.id] = revision }
        } else if let id = frame["event"]["conversationId"].string ?? frame["event"]["conversation"]["id"].string { touched[id] = revision }
    }
    public func reconcile(_ incoming: Snapshot, current: Snapshot?, since start: UInt64) -> Snapshot {
        guard let current else { return incoming }
        if snapshotRevision > start { return current }
        var next = incoming
        if (fields["settings"] ?? 0) > start { next.settings = current.settings }
        if (fields["engine"] ?? 0) > start { next.engine = current.engine }
        if (fields["approvals"] ?? 0) > start { next.approvals = current.approvals }
        if (fields["replyFeedback"] ?? 0) > start { next.replyFeedback = current.replyFeedback }
        for conversation in current.conversations {
            let changedDuringRequest = (touched[conversation.id] ?? 0) > start
            if let index = next.conversations.firstIndex(where: { $0.id == conversation.id }) {
                if changedDuringRequest || conversation.updatedAt > next.conversations[index].updatedAt { next.conversations[index] = conversation }
            } else if changedDuringRequest { next.conversations.append(conversation) }
        }
        return next
    }
}
