import Foundation

/// Narrow display contract shared with shared/mobile/conversation-contract.ts.
/// No authentication, arbitrary RPC, file path reads or script execution cross this boundary.
public enum SharedConversationActionType: String, CaseIterable, Sendable {
    case copyText, editPrompt, retryResponse, selectVersion, replyFeedback, continueResponse, quoteReply
    case openAttachment, openArtifact, downloadArtifact, downloadArtifacts, openLink, loadRemoteImage, openWorkflow, openAgent, openPlan, openChanges
}
public struct SharedConversationAction: Equatable, Sendable {
    public let sessionID: String
    public let requestID: String
    public let type: SharedConversationActionType
    public let payload: JSONValue
}
public enum SharedConversationEvent: Equatable, Sendable {
    case ready
    case applied(sessionID: String, revision: Int)
    case rejected(sessionID: String, revision: Int, error: String)
    case cancel(sessionID: String, requestID: String)
    case action(SharedConversationAction)
}
public enum SharedConversationProtocolError: Error, Equatable { case malformed, staleSession, duplicateRequest, busy, exhausted }
public enum SharedConversationProtocol {
    public static let maximumMessageBytes = 1_100_000
    public static let maximumTextBytes = 1_000_000
    public static func identifier(_ value: JSONValue) -> String? {
        guard let value = value.string, !value.isEmpty, value.utf8.count <= 256,
              value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return value
    }
    public static func decode(_ data: Data) throws -> SharedConversationEvent {
        guard data.count <= maximumMessageBytes else { throw SharedConversationProtocolError.malformed }
        return try decode(JSONDecoder().decode(JSONValue.self, from: data))
    }
    public static func decode(_ raw: JSONValue) throws -> SharedConversationEvent {
        guard raw.object != nil, raw["version"].number == 1, let type = raw["type"].string else { throw SharedConversationProtocolError.malformed }
        if type == "ready" { return .ready }
        guard let session = identifier(raw["sessionId"]) else { throw SharedConversationProtocolError.malformed }
        if type == "stateApplied" || type == "stateRejected" {
            guard let revision = raw["revision"].integer, revision >= 0, revision <= 9_007_199_254_740_991 else { throw SharedConversationProtocolError.malformed }
            if type == "stateApplied" { return .applied(sessionID: session, revision: revision) }
            guard let error = raw["error"].string, error.utf8.count <= 4_096 else { throw SharedConversationProtocolError.malformed }
            return .rejected(sessionID: session, revision: revision, error: error)
        }
        guard let request = identifier(raw["requestId"]) else { throw SharedConversationProtocolError.malformed }
        if type == "cancelRequest" { return .cancel(sessionID: session, requestID: request) }
        guard let kind = SharedConversationActionType(rawValue: type), let fields = raw["payload"].object else { throw SharedConversationProtocolError.malformed }
        let payload = raw["payload"]
        var keys = Set<String>()
        func requireID(_ key: String) throws { guard identifier(payload[key]) != nil else { throw SharedConversationProtocolError.malformed }; keys.insert(key) }
        func requireText(_ key: String, nonempty: Bool = false) throws {
            guard let text = payload[key].string, text.utf8.count <= maximumTextBytes, !nonempty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw SharedConversationProtocolError.malformed }; keys.insert(key)
        }
        switch kind {
        case .copyText: try requireText("text")
        case .openLink, .loadRemoteImage:
            try requireText("url", nonempty: true)
            guard let url = payload["url"].string, safeLink(url) != nil else { throw SharedConversationProtocolError.malformed }
        default: try requireID("conversationId")
        }
        switch kind {
        case .editPrompt: try requireID("turnId"); try requireText("text", nonempty: true)
        case .retryResponse: try requireID("turnId")
        case .selectVersion:
            try requireID("turnId"); try requireID("versionId")
            guard payload["prompt"].bool != nil else { throw SharedConversationProtocolError.malformed }; keys.insert("prompt")
        case .replyFeedback:
            try requireID("turnId")
            guard fields.keys.contains("rating"), payload["rating"] == .null || ["up", "down"].contains(payload["rating"].string ?? "") else { throw SharedConversationProtocolError.malformed }; keys.insert("rating")
        case .quoteReply: try requireText("text", nonempty: true)
        case .openAttachment: try requireID("attachmentId")
        case .openArtifact, .downloadArtifact:
            try requireID("artifactId")
            if fields["sourcePath"] != nil { try requireText("sourcePath"); guard (payload["sourcePath"].string?.utf8.count ?? 0) <= 8_192 else { throw SharedConversationProtocolError.malformed } }
            if fields["sourceDigest"] != nil { try requireID("sourceDigest") }
        case .downloadArtifacts:
            guard let files = payload["files"].array, (1...32).contains(files.count) else { throw SharedConversationProtocolError.malformed }
            keys.insert("files")
            var identities = Set<String>()
            for file in files {
                guard file["conversationId"] == payload["conversationId"],
                      let id = file["artifactId"].string, identities.insert(id).inserted else { throw SharedConversationProtocolError.malformed }
                _ = try decode(.object(["version": .number(1), "sessionId": .string(session), "requestId": .string(request), "type": .string("downloadArtifact"), "payload": file]))
            }
        case .openAgent:
            try requireID("agentId")
            if fields["turnId"] != nil { try requireID("turnId") }
        default: break
        }
        guard Set(fields.keys) == keys else { throw SharedConversationProtocolError.malformed }
        return .action(.init(sessionID: session, requestID: request, type: kind, payload: payload))
    }
    public static func safeLink(_ value: String) -> URL? {
        guard value.utf8.count <= 8_192, !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }), let url = URL(string: value), ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil else { return nil }
        if url.scheme?.lowercased() != "mailto", url.host?.isEmpty != false { return nil }
        return url
    }
    public static func result(for action: SharedConversationAction, ok: Bool, value: JSONValue? = nil, error: String? = nil, cancelled: Bool = false) -> JSONValue {
        var fields: [String: JSONValue] = ["version": .number(1), "sessionId": .string(action.sessionID), "requestId": .string(action.requestID), "ok": .bool(ok)]
        if let value { fields["result"] = value }
        if let error { fields["error"] = .string(String(error.prefix(4_096))) }
        if cancelled { fields["cancelled"] = .bool(true) }
        return .object(fields)
    }
}

/// Coalesces streaming snapshots: one in flight, newest pending, no faster than 80ms.
/// Session rotation drops all render state and action IDs. Request IDs are never
/// evicted within a lease, so replay cannot become valid after an LRU rollover.
public struct SharedConversationLease: Sendable {
    public private(set) var sessionID: String
    public private(set) var ready = false
    public private(set) var revision = 0
    public private(set) var inFlight: Int?
    public private(set) var pending: JSONValue?
    public private(set) var actions: [String: SharedConversationAction] = [:]
    private var seen: Set<String> = []
    private var lastSent = -Double.infinity
    private var rateWindow = -Double.infinity
    private var rateCount = 0
    public init(sessionID: String = UUID().uuidString) { self.sessionID = sessionID }
    public mutating func markReady() { ready = true }
    public mutating func rotate(sessionID: String = UUID().uuidString) { self = Self(sessionID: sessionID) }
    public mutating func enqueue(_ state: JSONValue) { pending = state }
    public mutating func next(now: TimeInterval) -> JSONValue? {
        guard ready, inFlight == nil, now - lastSent >= 0.08, var state = pending?.object else { return nil }
        revision += 1; state["version"] = .number(1); state["sessionId"] = .string(sessionID); state["revision"] = .number(Double(revision))
        pending = nil; inFlight = revision; lastSent = now
        return .object(state)
    }
    @discardableResult public mutating func acknowledge(sessionID: String, revision: Int) -> Bool {
        guard sessionID == self.sessionID, inFlight == revision else { return false }
        inFlight = nil; return true
    }
    public mutating func begin(_ action: SharedConversationAction, now: TimeInterval) throws {
        guard ready, action.sessionID == sessionID else { throw SharedConversationProtocolError.staleSession }
        guard !seen.contains(action.requestID) else { throw SharedConversationProtocolError.duplicateRequest }
        guard seen.count < 4_096 else { throw SharedConversationProtocolError.exhausted }
        if now - rateWindow >= 1 { rateWindow = now; rateCount = 0 }
        guard actions.count < 16, rateCount < 32 else { throw SharedConversationProtocolError.busy }
        seen.insert(action.requestID); rateCount += 1; actions[action.requestID] = action
    }
    public mutating func finish(_ requestID: String) -> SharedConversationAction? { actions.removeValue(forKey: requestID) }
    public func contains(_ requestID: String) -> Bool { actions[requestID] != nil }
}

public enum SharedConversationResolver {
    public static func turn(_ id: String, conversation: Conversation) -> Turn? { conversation.turns.first { $0.id == id } }
    public static func attachment(_ id: String, conversation: Conversation) -> Attachment? { conversation.turns.flatMap(\.attachments).first { $0.id == id } }
    public static func file(_ payload: JSONValue, conversation: Conversation) -> GeneratedFile? {
        let files = conversation.turns.flatMap(\.items).flatMap(\.generatedFiles)
        if let file = files.first(where: { file in
            "generated:\(file.id):\(file.digest ?? "undefined")" == payload["artifactId"].string &&
            (payload["sourcePath"].string == nil || payload["sourcePath"].string == file.path) &&
            (payload["sourceDigest"].string == nil || payload["sourceDigest"].string == file.digest)
        }) { return file }
        guard payload["sourcePath"] == .null, payload["sourceDigest"] == .null,
              let regex = try? NSRegularExpression(pattern: "```([\\w+.-]*)[^\\n]*\\n([\\s\\S]*?)```") else { return nil }
        for item in conversation.turns.flatMap(\.items) {
            let sources = [("fence", item.text ?? ""), ("fence-summary", (item.raw["summary"].array ?? []).compactMap(\.string).joined(separator: "\n\n"))]
            for (prefix, text) in sources {
                for (index, match) in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).enumerated() {
                    let identity = "\(prefix):\(item.id):\(index)"
                    guard payload["artifactId"].string == identity,
                          let languageRange = Range(match.range(at: 1), in: text), let contentRange = Range(match.range(at: 2), in: text) else { continue }
                    let language = String(text[languageRange]), content = String(text[contentRange])
                    return GeneratedFile(id: identity, name: CoreText.string(.snippetName, language.isEmpty ? "txt" : language), path: "", language: language,
                                         state: "ready", content: content, digest: nil, bytes: content.utf8.count, blob: false, mime: "text/plain", error: nil)
                }
            }
        }
        return nil
    }

    public static func containsFile(_ file: GeneratedFile, conversation: Conversation) -> Bool {
        if conversation.turns.flatMap(\.items).flatMap(\.generatedFiles).contains(file) { return true }
        return self.file(.object(["artifactId": .string(file.id)]), conversation: conversation) == file
    }
    public static func containsText(_ text: String, conversation: Conversation) -> Bool {
        guard !text.isEmpty, text.utf8.count <= SharedConversationProtocol.maximumTextBytes else { return false }
        if conversation.turns.contains(where: { $0.items.filter { $0.type == "agentMessage" }.compactMap(\.text).joined(separator: "\n\n") == text }) { return true }
        func contains(_ value: JSONValue) -> Bool {
            switch value {
            case .string(let source): return source.contains(text)
            case .array(let values): return values.contains(where: contains)
            case .object(let fields): return fields.values.contains(where: contains)
            default: return false
            }
        }
        return (try? JSONValue.encode(conversation)).map(contains) ?? false
    }
    /// The shared URL parser serializes links (e.g. inserts an origin slash and
    /// percent-encodes Unicode). Compare normalized safe candidates from current
    /// source, never an arbitrary URL merely because its scheme is allowed.
    public static func containsLink(_ link: String, source: String) -> Bool {
        func normalized(_ value: String) -> String? {
            guard let url = SharedConversationProtocol.safeLink(value), var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
            parts.scheme = parts.scheme?.lowercased(); parts.host = parts.host?.lowercased()
            if parts.scheme == "https" && parts.port == 443 || parts.scheme == "http" && parts.port == 80 { parts.port = nil }
            if parts.scheme != "mailto" && parts.path.isEmpty { parts.path = "/" }
            return parts.url?.absoluteString
        }
        guard let target = normalized(link), let regex = try? NSRegularExpression(pattern: #"(?:https?://|mailto:)[^\s<>\"'`]+"#, options: .caseInsensitive) else { return false }
        for match in regex.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            guard let range = Range(match.range, in: source) else { continue }
            var value = String(source[range]).replacingOccurrences(of: "&amp;", with: "&")
            if normalized(value) == target { return true }
            while value.last == ")" && value.filter({ $0 == ")" }).count > value.filter({ $0 == "(" }).count { value.removeLast() }
            if normalized(value) == target { return true }
            while let last = value.last, ".,;:!".contains(last) { value.removeLast() }
            if normalized(value) == target { return true }
        }
        return false
    }
    public static func containsLink(_ link: String, conversation: Conversation) -> Bool {
        func contains(_ value: JSONValue) -> Bool {
            switch value {
            case .string(let source): return containsLink(link, source: source)
            case .array(let values): return values.contains(where: contains)
            case .object(let fields): return fields.values.contains(where: contains)
            default: return false
            }
        }
        return (try? JSONValue.encode(conversation)).map(contains) ?? false
    }
    /// Quotes originate from DOM selections, whose visible text omits Markdown
    /// delimiters. Restrict this normalization to assistant-message quoting;
    /// clipboard copies and links retain the stricter source-text check above.
    public static func quoteForComposer(_ selected: String, conversation: Conversation) -> String? {
        let text = selected.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.count <= 32_768 else { return nil }
        func visible(_ value: String) -> String {
            value.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
                .replacingOccurrences(of: #"[`*_~#>]"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let candidate = visible(text)
        guard !candidate.isEmpty, conversation.turns.flatMap(\.items).contains(where: {
            $0.type == "agentMessage" && ($0.text?.contains(text) == true || visible($0.text ?? "").contains(candidate))
        }) else { return nil }
        return text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map { "> " + $0 }.joined(separator: "\n") + "\n\n"
    }
    public static func canSelectVersion(_ payload: JSONValue, conversation: Conversation) -> Bool {
        guard conversation.mode == .chat, let id = payload["turnId"].string,
              let turn = Self.turn(id, conversation: conversation), let prompt = payload["prompt"].bool else { return false }
        return ConversationVersions.versions(conversation, turn: turn, prompt: prompt).contains { $0.turnID == payload["versionId"].string }
    }
    public static func canMutate(_ conversation: Conversation, sending: Bool) -> Bool {
        !conversation.isRunning && !sending && conversation.slim != true
    }
}

/// Native batch acknowledgements must arrive once and in order. A user cancel
/// closes the remaining queue while retaining the count of completed saves.
public struct SharedConversationBatchProgress: Sendable {
    public let total: Int
    public private(set) var nextIndex = 0
    public private(set) var saved = 0
    public private(set) var cancelled = false
    public var finished: Bool { cancelled || nextIndex == total }
    public init(total: Int) throws {
        guard (1...32).contains(total) else { throw SharedConversationProtocolError.malformed }
        self.total = total
    }
    @discardableResult public mutating func complete(index: Int, didSave: Bool) -> Bool {
        guard !finished, index == nextIndex else { return false }
        nextIndex += 1
        if didSave { saved += 1 } else { cancelled = true }
        return true
    }
    public var result: JSONValue { .object(["saved": .number(Double(saved)), "cancelled": .bool(cancelled)]) }
}
