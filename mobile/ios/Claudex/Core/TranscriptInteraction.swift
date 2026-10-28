import Foundation

/// Gestures the restyled transcript reports to native code.
///
/// They come from a script in an isolated WebKit content world, never from the page's own scripts, and carry no
/// authority: native code resolves every turn against its own state and only ever reads, copies or shares text that
/// turn already holds.
public enum TranscriptUIEvent: Equatable, Sendable {
    public enum Role: String, Sendable { case user, assistant }
    public struct Place: Equatable, Sendable {
        /// Position of the turn among the rendered turns.
        public let index: Int
        /// The rendered prompt text, used to find the turn when the rendered list differs.
        public let prompt: String
    }
    case messageMenu(role: Role, place: Place, point: Point, canRetry: Bool, canEdit: Bool)
    case steps(Place)
    case share(Place)

    public struct Point: Equatable, Sendable {
        public let x: Double
        public let y: Double
    }

    public static let maximumPromptBytes = 80_000

    public static func decode(_ raw: JSONValue) -> TranscriptUIEvent? {
        guard let type = raw["type"].string, let index = raw["index"].integer, (0..<100_000).contains(index) else { return nil }
        let prompt = raw["prompt"].string ?? ""
        guard prompt.utf8.count <= maximumPromptBytes else { return nil }
        let place = Place(index: index, prompt: prompt)
        switch type {
        case "messageMenu":
            guard let role = raw["role"].string.flatMap(Role.init(rawValue:)),
                  let x = raw["x"].number, let y = raw["y"].number, x.isFinite, y.isFinite else { return nil }
            return .messageMenu(role: role, place: place, point: .init(x: x, y: y),
                                canRetry: raw["retry"].bool == true, canEdit: raw["edit"].bool == true)
        case "steps": return .steps(place)
        case "share": return .share(place)
        default: return nil
        }
    }
}

public enum TranscriptTurns {
    static func normalized(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
    /// The turn a rendered position refers to: the turn whose prompt matches the rendered text,
    /// nearest to the rendered index; otherwise the turn at that index.
    public static func resolve(_ place: TranscriptUIEvent.Place, in conversation: Conversation) -> Turn? {
        let turns = conversation.turns
        let wanted = normalized(place.prompt)
        if !wanted.isEmpty {
            let matches = turns.indices.filter { normalized(turns[$0].prompt) == wanted }
            if let best = matches.min(by: { abs($0 - place.index) < abs($1 - place.index) }) { return turns[best] }
        }
        guard turns.indices.contains(place.index) else { return nil }
        let candidate = turns[place.index]
        // A rendered prompt that matches no turn is a stale render: refuse rather than guess.
        return wanted.isEmpty || normalized(candidate.prompt).isEmpty ? candidate : nil
    }

    /// The reply text the official Copy / Share / Select text use: every assistant message of the turn.
    public static func replyText(_ turn: Turn) -> String {
        turn.items.filter { $0.type == "agentMessage" }.compactMap(\.text)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .joined(separator: "\n\n")
    }
}

/// One row of the collapsed steps sheet.
public struct TranscriptStep: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable { case thinking, command, search, fileChange, tool, image, other }
    public enum State: String, Sendable { case done, running, failed, stopped }
    public let id: String
    public let kind: Kind
    /// Headline argument: the command, query, path or tool name.
    public let subject: String
    /// Request side: arguments, command, query.
    public let request: String
    /// Response side: output, result, reasoning text, diff.
    public let response: String
    public let state: State
    public let truncated: Bool
}

public enum TranscriptSteps {
    /// Upper bound per text block shown in the sheet; longer output is marked truncated.
    public static let maximumText = 60_000

    public static func steps(_ turn: Turn) -> [TranscriptStep] {
        turn.items.compactMap(step)
    }

    static func clip(_ text: String) -> (String, Bool) {
        guard text.count > maximumText else { return (text, false) }
        return (String(text.prefix(maximumText)), true)
    }

    static func pretty(_ value: JSONValue) -> String {
        if let text = value.string { return text }
        if value == .null { return "" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    static func state(_ raw: JSONValue) -> TranscriptStep.State {
        switch raw["status"].string ?? "" {
        case "inProgress", "in_progress", "running": .running
        case "failed", "error", "declined": .failed
        case "interrupted", "cancelled", "canceled", "stopped": .stopped
        default: raw["error"] == .null ? .done : .failed
        }
    }

    static func step(_ item: TranscriptItem) -> TranscriptStep? {
        let raw = item.raw
        switch item.type {
        case "agentMessage", "userMessage", "contextCompaction": return nil
        case "reasoning":
            let parts = (raw["summary"].array ?? []).compactMap(\.string) + (raw["content"].array ?? []).compactMap(\.string)
            let text = parts.isEmpty ? (raw["text"].string ?? "") : parts.joined(separator: "\n\n")
            let (body, cut) = clip(text)
            let headline = (raw["summary"].array?.first?.string ?? "").split(separator: "\n").first.map(String.init) ?? ""
            return .init(id: item.id, kind: .thinking, subject: headline, request: "", response: body, state: state(raw), truncated: cut)
        case "commandExecution":
            let command = raw["command"].string ?? (raw["command"].array ?? []).compactMap(\.string).joined(separator: " ")
            var output = raw["aggregatedOutput"].string ?? raw["output"].string ?? ""
            if let code = raw["exitCode"].integer, code != 0, output.isEmpty { output = "exit \(code)" }
            let (body, cut) = clip(output)
            return .init(id: item.id, kind: .command, subject: command, request: command, response: body, state: state(raw), truncated: cut)
        case "webSearch":
            let query = raw["query"].string ?? raw["action"]["query"].string ?? ""
            return .init(id: item.id, kind: .search, subject: query, request: query, response: "", state: state(raw), truncated: false)
        case "fileChange":
            let changes = raw["changes"].array ?? []
            let paths = changes.compactMap { $0["path"].string }
            let diff = changes.map { ($0["path"].string ?? "") + "\n" + ($0["diff"].string ?? "") }.joined(separator: "\n\n")
            let (body, cut) = clip(diff)
            return .init(id: item.id, kind: .fileChange, subject: paths.count == 1 ? paths[0] : paths.joined(separator: ", "), request: paths.joined(separator: "\n"), response: body, state: state(raw), truncated: cut)
        case "imageGeneration":
            return .init(id: item.id, kind: .image, subject: raw["revisedPrompt"].string ?? raw["prompt"].string ?? "", request: raw["prompt"].string ?? "", response: "", state: state(raw), truncated: false)
        default:
            let name = raw["tool"].string ?? raw["name"].string ?? ""
            let server = raw["server"].string ?? ""
            let request = pretty(raw["arguments"] != .null ? raw["arguments"] : raw["input"])
            let response = raw["error"] != .null ? pretty(raw["error"]["message"] != .null ? raw["error"]["message"] : raw["error"]) : pretty(raw["result"] != .null ? raw["result"] : raw["output"])
            let (body, cut) = clip(response)
            let (args, argsCut) = clip(request)
            return .init(id: item.id, kind: name.isEmpty ? .other : .tool, subject: server.isEmpty || name.isEmpty ? name : name + " · " + server, request: args, response: body, state: state(raw), truncated: cut || argsCut)
        }
    }
}
