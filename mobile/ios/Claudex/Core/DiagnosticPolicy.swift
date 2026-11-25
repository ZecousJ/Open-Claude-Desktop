import CryptoKit
import Foundation

public struct DescribedTurnError: Equatable, Sendable {
    public let code: String
    public let message: String
}

public struct FailedTurn: Equatable, Sendable {
    public let id: String
    public let error: String?
    public let model: String
    public init(id: String, error: String?, model: String) { self.id = id; self.error = error; self.model = model }
}

public struct DiagnosticClient: Equatable, Sendable {
    public let appVersion: String
    public let platform: String
    public let arch: String
    public let osVersion: String
    public init(appVersion: String, platform: String, arch: String, osVersion: String) {
        self.appVersion = appVersion; self.platform = platform; self.arch = arch; self.osVersion = osVersion
    }
}

/// A failed turn becomes a category. The original text is not kept, and a report is sent only when
/// the person consented and the service is collecting diagnostics.
public enum DiagnosticPolicy {
    private static let clientTemplates: Set<String> = [
        "The Claudex service is unreachable.",
        "No model is assigned to this account yet.",
    ]

    public static func serviceCollectsDiagnostics(_ body: JSONValue) -> Bool { flag(body, "diagnostics") }
    public static func serviceCollectsFeedback(_ body: JSONValue) -> Bool { flag(body, "feedback") }
    private static func flag(_ body: JSONValue, _ name: String) -> Bool {
        let data = body["data"].object != nil ? body["data"] : body
        if case .bool(let enabled) = data["features"][name] { return enabled }
        return false
    }

    /// A stored row may only be a category, or one of the two fixed client sentences.
    public static func keepsStoredMessage(code: String, message: String) -> Bool {
        if code == "TURN_CLIENT" { return clientTemplates.contains(message) }
        let categories: Set<String> = ["timeout", "rate_limited", "auth", "model_unavailable", "server_error", "network", "context_length", "unknown"]
        return categories.contains(message) && code == "TURN_\(message.uppercased())"
    }

    /// A crash report is the exception name and up to three `File.ext:line` frames. No message and no path.
    public static func keepsCrash(code: String, message: String) -> Bool {
        guard code.range(of: "^[A-Za-z][A-Za-z0-9_]{0,40}$", options: .regularExpression) != nil else { return false }
        if message == code { return true }
        guard message.hasPrefix("\(code) at ") else { return false }
        let frames = message.dropFirst("\(code) at ".count).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        return (1...3).contains(frames.count) && frames.allSatisfy { $0.range(of: "^[A-Za-z0-9_.]+:[0-9]{1,6}$", options: .regularExpression) != nil }
    }

    public static func redactMessage(_ text: String) -> String {
        var value = redactSecrets(String(text.prefix(2000)))
        value = replace("[\\u{0000}-\\u{001f}\\u{007f}]+", in: value, with: " ")
        value = replace("([\"'`])[^\"'`]*[\\\\/][^\"'`]*\\1", in: value, with: "$1[path]$1")
        value = replace("\\b[a-z][a-z0-9+.-]*://\\S+", in: value, with: "[url]", caseInsensitive: true)
        value = replace("\\b[A-Za-z]:\\\\[^\\s\"'<>|]*", in: value, with: "[path]")
        value = replace("\\\\\\\\[^\\s\"'<>|]+", in: value, with: "[path]")
        value = replace("(^|[\\s\"'(=:])~?/[^\\s\"'<>)]+", in: value, with: "$1[path]")
        value = replace("\\b[\\w.-]+(?:[\\\\/][\\w.-]+)+\\.[A-Za-z0-9]{1,8}\\b", in: value, with: "[path]")
        value = replace("\\s+", in: value, with: " ")
        return String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
    }

    public static func describeTurnError(_ error: String) -> DescribedTurnError? {
        let text = error.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if clientTemplates.contains(text) { return DescribedTurnError(code: "TURN_CLIENT", message: redactMessage(text)) }
        let name = category(text.lowercased())
        return DescribedTurnError(code: "TURN_\(name.uppercased())", message: name)
    }

    private static func redactSecrets(_ text: String) -> String {
        var value = text
        value = replace("\\bsk-[A-Za-z0-9_-]{6,}", in: value, with: "[key]")
        value = replace("\\bBearer\\s+\\S+", in: value, with: "Bearer [token]", caseInsensitive: true)
        value = replace("\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*", in: value, with: "[token]")
        value = replace("\\b((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password)\\s*[:=]\\s*)[\"']?[^\\s\"',;]+", in: value, with: "$1[secret]", caseInsensitive: true)
        value = replace("[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){0,8}\\.[A-Za-z]{2,24}\\b", in: value, with: "[email]")
        return value
    }

    private static func category(_ text: String) -> String {
        if matches("context (length|window)|maximum context|too many tokens", text) { return "context_length" }
        if matches("timed? ?out|timeout", text) { return "timeout" }
        if matches("\\b429\\b|rate.?limit|too many requests", text) { return "rate_limited" }
        if matches("\\b401\\b|\\b403\\b|unauthori[sz]ed|forbidden|invalid api key", text) { return "auth" }
        if matches("\\bmodel\\b", text) && matches("not (found|supported|available)|does not exist|unknown", text) { return "model_unavailable" }
        if matches("\\b5\\d\\d\\b|server error|internal error|bad gateway|overloaded|service unavailable", text) { return "server_error" }
        if matches("unreachable|econn|enotfound|network|fetch failed|socket|disconnect|stream (closed|ended)|connection", text) { return "network" }
        return "unknown"
    }

    private static func matches(_ pattern: String, _ text: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func replace(_ pattern: String, in text: String, with template: String, caseInsensitive: Bool = false) -> String {
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
}

public final class DiagnosticQueue: @unchecked Sendable {
    private var reports: [(id: String, turnID: String, occurredAt: Date, code: String, message: String, model: String, client: DiagnosticClient, kind: String)] = []
    private var seen = Set<String>()
    private var retryAt = Date.distantPast
    private var feedback: [(id: String, rating: String, model: String, appVersion: String, platform: String)] = []
    private var feedbackRetryAt = Date.distantPast
    private let newID: () -> String
    private let now: () -> Date
    public init(newID: @escaping () -> String = { UUID().uuidString }, now: @escaping () -> Date = Date.init) {
        self.newID = newID; self.now = now
    }
    public var pendingIDs: [String] { reports.map(\.id) }
    public var pendingFeedbackIDs: [String] { feedback.map(\.id) }
    public func clear() { reports.removeAll(); feedback.removeAll() }

    public func observe(_ failures: [FailedTurn], consent: Bool, client: DiagnosticClient) {
        if !consent {
            clear()
            seen.formUnion(failures.map(\.id))
            trimSeen()
            return
        }
        for turn in failures {
            if seen.contains(turn.id) { continue }
            seen.insert(turn.id)
            guard let described = DiagnosticPolicy.describeTurnError(turn.error ?? "") else { continue }
            reports.append((newID(), turn.id, now(), described.code, described.message, String(turn.model.prefix(200)), client, "turn_error"))
            if reports.count > 500 { reports.removeFirst() }
        }
        trimSeen()
    }

    public func payload(consent: Bool, serviceEnabled: Bool) -> JSONValue? {
        if !consent { clear(); return nil }
        guard serviceEnabled, !reports.isEmpty, now() >= retryAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let rows = reports.prefix(50).map { report in
            JSONValue.object([
                "id": .string(report.id),
                "occurred_at": .string(formatter.string(from: report.occurredAt)),
                "kind": .string(report.kind),
                "code": .string(String(report.code.prefix(64))),
                "message": .string(String(report.message.prefix(300))),
                "request_id": .string(""),
                "model": .string(report.model),
                "app_version": .string(String(report.client.appVersion.prefix(32))),
                "codex_version": .string(""),
                "platform": .string(String(report.client.platform.prefix(16))),
                "arch": .string(String(report.client.arch.prefix(16))),
                "os_version": .string(String(report.client.osVersion.prefix(64))),
                "context": .object(["surface": .string(report.kind == "crash" ? "app" : "chat")]),
            ])
        }
        return .object(["consent": .bool(true), "reports": .array(rows)])
    }

    public func postpone() { retryAt = now().addingTimeInterval(60) }
    public func acknowledge(_ ids: Set<String>) {
        retryAt = .distantPast
        reports.removeAll { ids.contains($0.id) }
    }

    /// A thumbs rating, without the conversation. Withdrawing a rating does not create a report.
    public func recordFeedback(_ rating: String, model: String, client: DiagnosticClient) {
        guard rating == "up" || rating == "down" else { return }
        feedback.append((newID(), rating, String(model.prefix(200)), String(client.appVersion.prefix(32)), String(client.platform.prefix(16))))
        if feedback.count > 200 { feedback.removeFirst() }
    }

    public func feedbackPayload(consent: Bool, serviceEnabled: Bool) -> JSONValue? {
        if !consent { feedback.removeAll(); return nil }
        guard let next = feedback.first, serviceEnabled, now() >= feedbackRetryAt else { return nil }
        return .object([
            "consent": .bool(true),
            "id": .string(next.id),
            "rating": .string(next.rating),
            "categories": .array([]),
            "comment": .string(""),
            "model": .string(next.model),
            "request_id": .string(""),
            "conversation_excerpt": .null,
            "app_version": .string(next.appVersion),
            "platform": .string(next.platform),
        ])
    }

    public func postponeFeedback() { feedbackRetryAt = now().addingTimeInterval(60) }
    /// An uncaught exception, reduced to its type and source frames. The exception text is not kept.
    public func recordCrash(_ name: String, frames: [String], client: DiagnosticClient) {
        let code = name.range(of: "^[A-Za-z][A-Za-z0-9_]{0,40}$", options: .regularExpression) != nil ? name : "Error"
        var kept: [String] = []
        for frame in frames where frame.range(of: "^[A-Za-z0-9_.]+:[0-9]{1,6}$", options: .regularExpression) != nil {
            if !kept.contains(frame) { kept.append(frame) }
            if kept.count == 3 { break }
        }
        let message = kept.isEmpty ? code : "\(code) at \(kept.joined(separator: ", "))"
        reports.append((newID(), "crash", now(), code, message, "", client, "crash"))
        if reports.count > 500 { reports.removeFirst() }
    }

    public func acknowledgeFeedback(_ id: String) {
        feedbackRetryAt = .distantPast
        feedback.removeAll { $0.id == id }
    }

    /// Drops unsent reports and ratings. Turns already seen stay seen.
    public func dropPending() { reports.removeAll(); feedback.removeAll() }

    /// Forgets this account's queue in memory. The file for that account is left for the next sign-in.
    public func forget() { dropPending(); seen.removeAll(); retryAt = .distantPast; feedbackRetryAt = .distantPast }

    /// The on-disk queue. It has no prompt, reply, path or original error text.
    public func document() -> JSONValue {
        trimSeen()
        let diagnostics = reports.map { report in
            JSONValue.object([
                "id": .string(report.id),
                "turn_id": .string(report.turnID),
                "occurred_at": .number(report.occurredAt.timeIntervalSince1970),
                "code": .string(report.code),
                "message": .string(report.message),
                "model": .string(report.model),
                "app_version": .string(report.client.appVersion),
                "platform": .string(report.client.platform),
                "arch": .string(report.client.arch),
                "os_version": .string(report.client.osVersion),
                "kind": .string(report.kind),
            ])
        }
        let ratings = feedback.map { item in
            JSONValue.object([
                "id": .string(item.id),
                "rating": .string(item.rating),
                "model": .string(item.model),
                "app_version": .string(item.appVersion),
                "platform": .string(item.platform),
            ])
        }
        return .object([
            "version": .number(1),
            "diagnostics": .array(diagnostics),
            "feedback": .array(ratings),
            "seen": .array(seen.map { .string($0) }),
            "retry_at": .number(retryAt == .distantPast ? 0 : retryAt.timeIntervalSince1970),
            "feedback_retry_at": .number(feedbackRetryAt == .distantPast ? 0 : feedbackRetryAt.timeIntervalSince1970),
        ])
    }

    /// Replaces this queue with a document this app wrote. A damaged document is refused whole.
    public func restore(_ document: JSONValue) -> Bool {
        guard document["version"].integer == 1, let diagnostics = document["diagnostics"].array, let ratings = document["feedback"].array, let seenIDs = document["seen"].array else { return false }
        guard diagnostics.count <= 500, ratings.count <= 200, seenIDs.count <= 2000 else { return false }
        var nextReports: [(id: String, turnID: String, occurredAt: Date, code: String, message: String, model: String, client: DiagnosticClient, kind: String)] = []
        for row in diagnostics {
            guard let object = row.object, !object.keys.contains(where: { ["conversation_excerpt", "error", "prompt"].contains($0) }) else { return false }
            guard let id = row["id"].string, Self.isUUID(id), let turnID = row["turn_id"].string, Self.plain(turnID, 128) else { return false }
            let kind = row["kind"].string ?? "turn_error"
            guard let code = row["code"].string, let message = row["message"].string else { return false }
            let kept = kind == "turn_error" ? DiagnosticPolicy.keepsStoredMessage(code: code, message: message) : kind == "crash" && DiagnosticPolicy.keepsCrash(code: code, message: message)
            guard kept else { return false }
            let model = row["model"].string ?? ""
            let appVersion = row["app_version"].string ?? ""
            let platform = row["platform"].string ?? ""
            let arch = row["arch"].string ?? ""
            let osVersion = row["os_version"].string ?? ""
            guard Self.bounded(model, 200), Self.bounded(appVersion, 32), Self.bounded(platform, 16), Self.bounded(arch, 16), Self.bounded(osVersion, 64) else { return false }
            guard let occurredAt = row["occurred_at"].number, occurredAt >= 0 else { return false }
            nextReports.append((id, turnID, Date(timeIntervalSince1970: occurredAt), code, message, model, DiagnosticClient(appVersion: appVersion, platform: platform, arch: arch, osVersion: osVersion), kind))
        }
        var nextFeedback: [(id: String, rating: String, model: String, appVersion: String, platform: String)] = []
        for row in ratings {
            guard let object = row.object, !object.keys.contains(where: { ["conversation_excerpt", "comment", "prompt"].contains($0) }) else { return false }
            guard let id = row["id"].string, Self.isUUID(id), let rating = row["rating"].string, rating == "up" || rating == "down" else { return false }
            let model = row["model"].string ?? ""
            let appVersion = row["app_version"].string ?? ""
            let platform = row["platform"].string ?? ""
            guard Self.bounded(model, 200), Self.bounded(appVersion, 32), Self.bounded(platform, 16) else { return false }
            nextFeedback.append((id, rating, model, appVersion, platform))
        }
        var nextSeen = Set<String>()
        for row in seenIDs {
            guard let id = row.string, Self.plain(id, 128) else { return false }
            nextSeen.insert(id)
        }
        reports = nextReports
        feedback = nextFeedback
        seen = nextSeen
        retryAt = (document["retry_at"].number ?? 0) > 0 ? Date(timeIntervalSince1970: document["retry_at"].number ?? 0) : .distantPast
        feedbackRetryAt = (document["feedback_retry_at"].number ?? 0) > 0 ? Date(timeIntervalSince1970: document["feedback_retry_at"].number ?? 0) : .distantPast
        return true
    }

    private func trimSeen() {
        if seen.count > 2000 { seen = Set(Array(seen).prefix(2000)) }
    }

    private static func isUUID(_ value: String) -> Bool { UUID(uuidString: value) != nil }
    private static func plain(_ value: String, _ limit: Int) -> Bool {
        value.count >= 1 && value.count <= limit && value.unicodeScalars.allSatisfy { $0.value >= 32 }
    }
    private static func bounded(_ value: String, _ limit: Int) -> Bool {
        value.count <= limit && value.unicodeScalars.allSatisfy { $0.value >= 32 }
    }
}

/// One account's queue file. The file name is a hash, so the account is not written on disk.
public enum DiagnosticQueueFile {
    private static let lock = NSLock()

    public static func location(directory: URL, account: String) -> URL {
        let digest = SHA256.hash(data: Data(account.utf8))
        let name = digest.prefix(16).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("diagnostics", isDirectory: true).appendingPathComponent("\(name).json")
    }

    public static func load(_ file: URL, queue: DiagnosticQueue) {
        lock.lock(); defer { lock.unlock() }
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        guard let data = try? Data(contentsOf: file), let value = try? JSONDecoder().decode(JSONValue.self, from: data), queue.restore(value) else {
            try? FileManager.default.removeItem(at: file)
            return
        }
    }

    public static func store(_ file: URL, queue: DiagnosticQueue, consent: Bool) {
        lock.lock(); defer { lock.unlock() }
        if !consent { queue.dropPending() }
        let document = queue.document()
        let empty = (document["diagnostics"].array?.isEmpty ?? true) && (document["feedback"].array?.isEmpty ?? true) && (document["seen"].array?.isEmpty ?? true)
        if empty {
            try? FileManager.default.removeItem(at: file)
            return
        }
        let folder = file.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(document) else { return }
        try? data.write(to: file, options: .atomic)
    }
}
