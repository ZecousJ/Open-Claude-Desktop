import Foundation

public enum StreamEffect: Equatable, Sendable { case none, changed, resync, signedOut(String) }
/// Cursor advances only after an event is safely applied. Replayed events are idempotent.
public struct StreamReducer: Sendable {
    public private(set) var lastSequence: Int?
    public private(set) var snapshot: Snapshot?
    public private(set) var needsResync = false
    public init(snapshot: Snapshot? = nil) { self.snapshot = snapshot }
    public mutating func reset() { lastSequence = nil; snapshot = nil; needsResync = false }
    public mutating func replace(_ snapshot: Snapshot) { self.snapshot = snapshot; needsResync = false }
    /// Recovery covers a gap with a fresh state read instead of reopening the
    /// socket with an unreplayable cursor. Never move behind accepted events.
    public mutating func recover(_ snapshot: Snapshot, covering sequence: Int?) {
        replace(snapshot)
        if let sequence { lastSequence = max(lastSequence ?? 0, sequence) }
    }
    public mutating func apply(_ frame: JSONValue) throws -> StreamEffect {
        switch frame["t"].string {
        case "ready":
            guard frame["v"].number == 1, frame["resumed"].bool != nil, let seq = sequence(frame) else { throw ServiceError.invalidResponse }
            if frame["resumed"].bool != true {
                lastSequence = seq; needsResync = true; return .resync
            }
            needsResync = false
            return .none
        case "snapshot":
            guard let seq = sequence(frame) else { throw ServiceError.invalidResponse }
            if let lastSequence, seq < lastSequence { return .none }
            snapshot = try frame["snapshot"].decode(Snapshot.self); lastSequence = seq; needsResync = false
            return .changed
        case "event":
            guard let seq = sequence(frame), seq >= 1, let eventType = frame["event"]["type"].string, !eventType.isEmpty else { throw ServiceError.invalidResponse }
            if eventType == "signed-out" { let message = frame["event"]["message"].string ?? CoreText.string(.sessionInvalid); reset(); return .signedOut(message) }
            if let lastSequence, seq <= lastSequence { return .none }
            if let lastSequence, seq != lastSequence + 1 { needsResync = true; return .resync }
            let event = frame["event"]
            if event["type"].string == "signed-out" {
                reset(); return .signedOut(event["message"].string ?? CoreText.string(.sessionInvalid))
            }
            if needsResync { return .resync }
            let effect = try applyEvent(event)
            lastSequence = seq
            if effect == .resync { needsResync = true }
            return effect
        case "error": throw ServiceError.server(frame["message"].string ?? CoreText.string(.somethingWentWrongTryAgain), frame["code"].string)
        case "pong", "open-url": return .none // External URLs never open without a user gesture.
        default: return .none // Forward-compatible frame types.
        }
    }
    private func sequence(_ frame: JSONValue) -> Int? {
        guard let v = frame["seq"].number, v >= 0, v <= 9_007_199_254_740_991, v.rounded() == v else { return nil }
        return Int(v)
    }
    private mutating func applyEvent(_ event: JSONValue) throws -> StreamEffect {
        guard var state = snapshot else { return .resync }
        switch event["type"].string {
        case "conversation":
            let conversation = try event["conversation"].decode(Conversation.self)
            if let index = state.conversations.firstIndex(where: { $0.id == conversation.id }) { if state.conversations[index].updatedAt <= conversation.updatedAt { state.conversations[index] = conversation } }
            else { state.conversations.insert(conversation, at: 0) }
        case "conversation-turn":
            guard let index = state.conversations.firstIndex(where: { $0.id == event["conversationId"].string }) else { return .none }
            if let updated = event["conversation"]["updatedAt"].number, updated < state.conversations[index].updatedAt { return .none }
            let turn = try event["turn"].decode(Turn.self)
            if let turnIndex = state.conversations[index].turns.firstIndex(where: { $0.id == turn.id }) { state.conversations[index].turns[turnIndex] = turn }
            else { state.conversations[index].turns.append(turn) }
            // Apply all server metadata patches without erasing unchanged fields.
            var full = try JSONValue.encode(state.conversations[index]).object ?? [:]
            for (key, value) in event["conversation"].object ?? [:] where key != "id" && key != "turns" && key != "slim" { full[key] = value }
            state.conversations[index] = try JSONValue.object(full).decode(Conversation.self)
        case "settings": state.settings = try event["settings"].decode(Settings.self)
        case "engine": state.engine = event["engine"]
        case "approval":
            let incoming = event["approval"]
            state.approvals.removeAll { $0["id"] == incoming["id"] }; state.approvals.append(incoming)
        case "approval-resolved": state.approvals.removeAll { $0["id"] == event["id"] }
        case "resync", "service-changed", "projects", "artifact-library": return .resync
        default: return .none
        }
        snapshot = state; return .changed
    }
}
/// Like the web's event stream, a dropped connection is tried again for as long
/// as the account is signed in; only a refused session stops it.
public struct ReconnectPolicy: Sendable {
    public static func delay(attempt: Int) -> TimeInterval { min(30, pow(2, Double(max(0, min(attempt, 5))))) }
    public static func shouldRetry(closeCode: Int) -> Bool { ![4003, 4008, 4400].contains(closeCode) }
    public static func shouldRetry(closeCode: Int, attempt: Int) -> Bool { shouldRetry(closeCode: closeCode) }
}
public enum WireFrames {
    public static func hello(tabID: String, lastSequence: Int?) -> JSONValue {
        var fields: [String: JSONValue] = ["t": .string("hello"), "v": .number(1), "tabId": .string(tabID)]
        if let lastSequence { fields["lastSeq"] = .number(Double(lastSequence)) }; return .object(fields)
    }
    public static func presence(active: Bool) -> JSONValue { .object(["t": .string("presence"), "visible": .bool(active), "focused": .bool(active)]) }
}
