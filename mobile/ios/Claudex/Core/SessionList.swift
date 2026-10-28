import Foundation

/// The session list's filters, in the official order: All, Working, Needs input, Ready for review, Completed,
/// Archived. Each session is in one bucket, decided in the order the live session list decides it (`ZM`): archived,
/// then waiting on an approval, then running, then a pull request waiting for a reviewer, then finished. Android's
/// `SessionList` is the same rule.
public enum SessionFilter: String, CaseIterable, Identifiable, Sendable {
    case all, working, needsInput, readyForReview, completed, archived
    public var id: String { rawValue }
}

public enum SessionList {
    /// A turn is still running.
    public static func working(_ conversation: Conversation) -> Bool { conversation.turns.last?.isRunning == true }

    /// `waiting` holds the conversations with an open approval, `review` the ones whose pull request waits for a reviewer.
    public static func matches(_ filter: SessionFilter, _ conversation: Conversation, waiting: Set<String>, review: Set<String>) -> Bool {
        if filter == .archived { return conversation.archived }
        if conversation.archived { return false }
        let needsInput = waiting.contains(conversation.id)
        let running = !needsInput && working(conversation)
        let reviewing = !needsInput && !running && review.contains(conversation.id)
        switch filter {
        case .all: return true
        case .working: return running
        case .needsInput: return needsInput
        case .readyForReview: return reviewing
        case .completed: return !needsInput && !reviewing && conversation.turns.last?.status == "completed"
        case .archived: return false
        }
    }

    /// Cowork tasks make no pull requests, so their menu has no Ready for review.
    public static let coworkFilters: [SessionFilter] = SessionFilter.allCases.filter { $0 != .readyForReview }
}

/// A pull request on github.com, named as the service asks about it.
public struct PullRef: Hashable, Sendable {
    public let repository: String
    public let number: Int
    public init(repository: String, number: Int) { self.repository = repository; self.number = number }
    public var key: String { "\(repository.lowercased())#\(number)" }
}

/// One answer of `POST /api/v1/claudex/web/github/pull/states`.
public struct PullVerdict: Equatable, Sendable {
    public let key: String
    public let awaitsReview: Bool
    public init(key: String, awaitsReview: Bool) { self.key = key; self.awaitsReview = awaitsReview }
}

/// Ready for review: a finished Code session whose pull request is open, not a draft and not yet answered by a
/// reviewer (the live list counts such a request as `awaitsReview`). The session's own request is the last one
/// its reply tagged `<pr-created>` (shared/pull-request.ts `sessionPullRequest`); a plain link in a reply is not.
public enum SessionReviewPolicy {
    public static let path = "api/v1/claudex/web/github/pull/states"
    /// The service answers at most this many requests at a time.
    public static let maxAsked = 40
    public static let maxAge: TimeInterval = 60
    private static let tagged = try! NSRegularExpression(pattern: #"<pr-created>\s*(https?://[^\s<]+?)\s*</pr-created>"#, options: [.caseInsensitive])
    private static let address = try! NSRegularExpression(pattern: #"^https://github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)"#)

    public static func parse(_ url: String) -> PullRef? {
        let text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let whole = NSRange(text.startIndex..., in: text)
        guard let match = address.firstMatch(in: text, range: whole),
              let owner = Range(match.range(at: 1), in: text), let name = Range(match.range(at: 2), in: text),
              let digits = Range(match.range(at: 3), in: text), let number = Int(text[digits]), (1...999_999_999).contains(number)
        else { return nil }
        return PullRef(repository: "\(text[owner])/\(text[name])", number: number)
    }

    public static func pullRequest(_ conversation: Conversation) -> PullRef? {
        for turn in conversation.turns.reversed() {
            for item in turn.items.reversed() where item.type == "agentMessage" {
                guard let text = item.text, !text.isEmpty else { continue }
                let whole = NSRange(text.startIndex..., in: text)
                for match in tagged.matches(in: text, range: whole).reversed() {
                    if let range = Range(match.range(at: 1), in: text), let ref = parse(String(text[range])) { return ref }
                }
            }
        }
        return nil
    }

    /// The sessions worth asking about: Code sessions that are not archived and not running, newest first, with their request.
    public static func candidates(_ conversations: [Conversation]) -> [(id: String, ref: PullRef)] {
        var found: [(id: String, ref: PullRef)] = []
        for conversation in conversations.filter({ $0.mode == .code && !$0.archived && !SessionList.working($0) }).sorted(by: { $0.updatedAt > $1.updatedAt }) {
            if found.count >= maxAsked { break }
            if let ref = pullRequest(conversation) { found.append((conversation.id, ref)) }
        }
        return found
    }

    public static func request(_ refs: [PullRef]) -> JSONValue {
        .object(["pulls": .array(refs.map { .object(["repo": .string($0.repository), "number": .number(Double($0.number))]) })])
    }

    public static func verdicts(_ data: JSONValue) -> [PullVerdict] {
        (data["states"].array ?? []).compactMap { state in
            guard let repository = state["repository"].string, !repository.isEmpty, let number = state["number"].integer, number >= 1 else { return nil }
            return PullVerdict(key: PullRef(repository: repository, number: number).key, awaitsReview: state["awaits_review"].bool == true)
        }
    }
}

/// The sessions waiting for a reviewer, kept for the list. A verdict is asked again when it is older than a
/// minute or `force` is set (pull to refresh); a failed question (`nil`) keeps the last answer, since GitHub may
/// simply not be connected or reachable.
public actor SessionReview {
    private let ask: @Sendable ([PullRef]) async -> [PullVerdict]?
    private let now: @Sendable () -> Date
    private var verdicts: [String: (awaits: Bool, at: Date)] = [:]

    public init(now: @escaping @Sendable () -> Date = { Date() }, ask: @escaping @Sendable ([PullRef]) async -> [PullVerdict]?) {
        self.ask = ask; self.now = now
    }

    /// The ids of the conversations whose pull request waits for a reviewer.
    public func load(_ conversations: [Conversation], force: Bool = false) async -> Set<String> {
        let candidates = SessionReviewPolicy.candidates(conversations)
        var seenKeys = Set<String>()
        let stale = candidates.map(\.ref).filter { ref in
            guard seenKeys.insert(ref.key).inserted else { return false }
            guard !force, let known = verdicts[ref.key] else { return true }
            return known.at.addingTimeInterval(SessionReviewPolicy.maxAge) <= now()
        }
        if !stale.isEmpty, let answered = await ask(stale) {
            let at = now(); let seen = Set(answered.map(\.key))
            for verdict in answered { verdicts[verdict.key] = (verdict.awaitsReview, at) }
            // A request GitHub no longer answers for (gone, private) is no longer waiting.
            for ref in stale where !seen.contains(ref.key) { verdicts[ref.key] = (false, at) }
        }
        return Set(candidates.compactMap { verdicts[$0.ref.key]?.awaits == true ? $0.id : nil })
    }

    public func clear() { verdicts = [:] }
}
