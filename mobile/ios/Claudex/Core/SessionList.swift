import Foundation

/// The session list's filters, in the official order (Android `bnx.l`): All, Working, Needs input, Ready for
/// review, Completed, Archived. Each session is in one bucket, decided in the order the live session list
/// decides it (`ZM`): archived, then waiting on an approval, then running, then a pull request waiting for a
/// reviewer, then finished. Android's `SessionList` is the same rule.
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

    /// The status a row shows when the list is grouped by status. A failed Cowork task needs input; anything else unfinished is idle.
    public static func statusOf(_ conversation: Conversation, waiting: Set<String>, review: Set<String>) -> SessionFilter? {
        if waiting.contains(conversation.id) || (conversation.mode == .cowork && conversation.turns.last?.status == "failed") { return .needsInput }
        if working(conversation) { return .working }
        if review.contains(conversation.id) { return .readyForReview }
        if conversation.turns.last?.status == "completed" { return .completed }
        return nil
    }

    /// The working directory kept on the session. Blank when it has none.
    public static func folderPath(_ conversation: Conversation) -> String {
        conversation.extensionFields["cwd"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/\\")) ?? ""
    }

    /// The last path segment shown as the folder heading.
    public static func folderName(_ path: String) -> String {
        path.split { $0 == "/" || $0 == "\\" }.last.map(String.init) ?? ""
    }

    /// Official group-by. Rows stay in the order they were given. None is one untitled section.
    public static func sections(_ rows: [Conversation], group: SessionGroup, waiting: Set<String>, review: Set<String>, now: Date = Date()) -> [SessionSection] {
        if group == .none { return [SessionSection(id: "all", titleKey: nil, literal: nil, rows: rows)] }
        if group == .date {
            return RecencyBucket.group(rows, now: now, date: \.date).map { SessionSection(id: "\($0.bucket.rawValue)", titleKey: $0.bucket.stringKey, literal: nil, rows: $0.items) }
        }
        if group == .status {
            let order: [SessionFilter] = [.working, .needsInput, .readyForReview, .completed]
            var buckets: [String: [Conversation]] = [:]
            for row in rows {
                let key = statusOf(row, waiting: waiting, review: review)?.rawValue ?? "idle"
                buckets[key, default: []].append(row)
            }
            let titled = order.compactMap { filter -> SessionSection? in
                guard let rows = buckets[filter.rawValue] else { return nil }
                return SessionSection(id: filter.rawValue, titleKey: filter.stringKey, literal: nil, rows: rows)
            }
            let idle = buckets["idle"].map { SessionSection(id: "idle", titleKey: "session_group_idle", literal: nil, rows: $0) }
            return titled + (idle.map { [$0] } ?? [])
        }
        var order: [String] = []
        var buckets: [String: [Conversation]] = [:]
        for row in rows {
            let path = folderPath(row)
            if buckets[path] == nil { order.append(path) }
            buckets[path, default: []].append(row)
        }
        return order.map { path in
            let items = buckets[path] ?? []
            let name = folderName(path)
            if name.isEmpty { return SessionSection(id: "no-folder", titleKey: "ccr_paired_no_folder", literal: nil, rows: items) }
            return SessionSection(id: path, titleKey: nil, literal: name, rows: items)
        }
    }
}

/// Group by on the session and task lists. Date, Status, Folder, then None.
public enum SessionGroup: String, CaseIterable, Identifiable, Sendable {
    case date, status, folder, none
    public var id: String { rawValue }
    public var stringKey: String {
        switch self {
        case .date: "session_group_date"
        case .status: "session_group_status"
        case .folder: "session_group_folder"
        case .none: "session_group_none"
        }
    }
}

/// One headed block of an already filtered session list.
public struct SessionSection: Identifiable, Sendable {
    public let id: String
    public let titleKey: String?
    public let literal: String?
    public let rows: [Conversation]
}

extension SessionFilter {
    var stringKey: String {
        switch self {
        case .all: "session_filter_all"
        case .working: "session_filter_working"
        case .needsInput: "session_filter_needs_input"
        case .readyForReview: "session_filter_ready_for_review"
        case .completed: "session_filter_completed"
        case .archived: "session_filter_archived"
        }
    }
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
