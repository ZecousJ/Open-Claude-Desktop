import Foundation

/// The shared transcript's zoom for the system text size: body text is 17 pt at
/// the default size, so the page scales by the same ratio as the native views.
public enum SharedConversationTextScale {
    public static func zoom(bodyPointSize: Double) -> Double {
        guard bodyPointSize.isFinite, bodyPointSize > 0 else { return 1 }
        return min(max(bodyPointSize / 17, 0.8), 3)
    }
}

public enum NativeDisplayTime {
    /// `wallClock`: the zone of a time given without one ("2026-10-04T10:50", a
    /// service status slot in the status page's own time zone); it is shown there.
    public static func format(_ value: String?, locale: Locale = .current, timeZone: TimeZone = .current, wallClock: TimeZone? = nil) -> String {
        guard let value, !value.isEmpty else { return CoreText.string(.timeUnknown) }
        if value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$", options: .regularExpression) != nil {
            let zone = wallClock ?? timeZone
            let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX"); parser.timeZone = zone
            parser.dateFormat = "yyyy-MM-dd'T'HH:mm"
            guard let date = parser.date(from: value) else { return CoreText.string(.timeUnknown) }
            let display = DateFormatter(); display.locale = locale; display.timeZone = zone
            display.setLocalizedDateFormatFromTemplate("MMMdHm")
            return display.string(from: date)
        }
        // Some status timestamps carry nanoseconds; Date needs no such precision for display.
        let normalized = value.replacingOccurrences(of: "(\\.[0-9]{3})[0-9]+", with: "$1", options: .regularExpression)
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = parser.date(from: normalized)
        if date == nil { parser.formatOptions = [.withInternetDateTime]; date = parser.date(from: value) }
        if date == nil { parser.formatOptions = [.withFullDate]; date = parser.date(from: value) }
        guard let date else { return CoreText.string(.timeUnknown) }
        let display = DateFormatter(); display.locale = locale; display.timeZone = timeZone
        display.setLocalizedDateFormatFromTemplate(value.count == 10 ? "MMMd" : "MMMdHm")
        return display.string(from: date)
    }
}

public struct APIGroups: Codable, Sendable, Equatable {
    public let groups: [APIGroup]
    public let providers: [APIGroupProvider]
    public var images: APIImages? = nil
    public var origin: String? = nil
}
public struct APIImageModel: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
}
public struct APIImages: Codable, Sendable, Equatable {
    public let groupId: Int
    public let models: [APIImageModel]
    public let selected: String
}
public struct APIGroup: Codable, Identifiable, Sendable, Equatable {
    public let id: Int
    public let name: String
    public let models: Int
    public let primary: Bool
    public let platform: String
    public let `protocol`: String
}
public struct APIGroupProvider: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let groups: [APIGroup]
    public let selected: Int?
}
public struct MemoryPreferences: Codable, Sendable, Equatable {
    public let searchChats: Bool
    public let generate: Bool
}
public struct MemoryEdit: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let text: String
    public let createdAt: Double
}
public struct MemoryDocument: Codable, Sendable, Equatable {
    public let content: String
    public let updatedAt: Double
    public let generatedAt: Double?
    public let source: String
    public let revision: Int
    public let edits: [MemoryEdit]
    /// The service's limits for the "remember or forget" edits (absent from an older service).
    public var limits: MemoryEditLimits? = nil
    /// How long one edit may be.
    public var editChars: Int { limits?.editChars ?? 500 }
}
/// How a Manage-memory change went (shared/memory-api.ts MemoryEditOutcome); `removed` names the statements that went.
public struct MemoryEditOutcome: Sendable, Equatable {
    public let kind: String
    public let removed: [String]
    public init(kind: String, removed: [String] = []) { self.kind = kind; self.removed = removed }
    /// The service of this app's version answers an outcome; one from before it did not, so the change is worded by what was asked.
    public init(wire: JSONValue?, asked: Bool) {
        if let kind = wire?["kind"].string, !kind.isEmpty { self.init(kind: kind, removed: (wire?["removed"].array ?? []).compactMap(\.string)) }
        else { self.init(kind: asked ? "added" : "removed") }
    }
    /// Nothing was saved: memory refused the text (a secret, or longer than a memory edit may be).
    public var refused: Bool { kind == "rejected" || kind == "too_long" }
}
/// The scope's memory after a change (nil when it has none) and how the change went.
public struct MemoryEditResult: Sendable, Equatable {
    public let document: MemoryDocument?
    public let outcome: MemoryEditOutcome
}
public struct MemoryEditLimits: Codable, Sendable, Equatable { public let edits: Int; public let editChars: Int }
public struct MemoryStatus: Codable, Sendable, Equatable {
    public let available: Bool
    public let reason: String?
    public let allowed: MemoryPreferences
    public let prefs: MemoryPreferences
    public let global: MemoryDocument?
    public let synthesizing: Bool
    public let lastRun: JSONValue?
    public var canChange: Bool { available && reason != "offline" }
}
public enum MemoryScope: Hashable, Sendable {
    case global, project(String)
    public var wire: JSONValue {
        switch self {
        case .global: .object(["kind": .string("global")])
        case .project(let id): .object(["kind": .string("project"), "projectId": .string(id)])
        }
    }
    public var valid: Bool {
        switch self { case .global: true; case .project(let id): UUID(uuidString: id) != nil }
    }
}
public struct Routine: Codable, Identifiable, Sendable, Equatable {
    public let raw: JSONValue
    public var id: String { raw["id"].string ?? "" }
    public var name: String { raw["name"].string ?? "" }
    public var prompt: String { raw["prompt"].string ?? "" }
    public var mode: String { raw["mode"].string ?? "cowork" }
    public var enabled: Bool { raw["enabled"].bool ?? false }
    public var nextRunAt: Double? { raw["nextRunAt"].number }
    public var running: Bool { ["starting", "running"].contains(raw["lastRunStatus"].string ?? "") }
    public var repeatRule: JSONValue { raw["repeat"] }
    public init(from decoder: Decoder) throws { raw = try JSONValue(from: decoder) }
    public func encode(to encoder: Encoder) throws { try raw.encode(to: encoder) }
    public func settingEnabled(_ value: Bool) -> JSONValue {
        var fields = raw.object ?? [:]; fields["enabled"] = .bool(value); return .object(fields)
    }
}
/// One kept approval of a scheduled task ("Always allowed"): its kind, the tool named and the pattern that was allowed.
public struct RoutineAllowed: Equatable, Sendable {
    public let kind: String
    public let tool: String
    public let pattern: String?
    public init(kind: String, tool: String, pattern: String?) { self.kind = kind; self.tool = tool; self.pattern = pattern }
}
public extension Routine {
    static let permissionModes = ["default", "auto", "bypass"]
    /// The permission mode the task was saved with: "default" (Manual), "auto" or "bypass" (Skip all approvals).
    var savedPermission: String? { raw["permission"].string.flatMap { Routine.permissionModes.contains($0) ? $0 : nil } }
    /// The mode its runs use: a Cowork task saved without one has full access; a Code task without one follows the Code setting (nil).
    var permission: String? { savedPermission ?? (mode == "cowork" ? "bypass" : nil) }
    /// A one-time task's moment (milliseconds since the epoch): the same instant on every device.
    var onceAt: Double? { repeatRule["kind"].string == "once" ? repeatRule["at"].number : nil }
    /// A one-time task that has had its run: it switched itself off at its moment and its run is not going. A run
    /// started by hand before the moment does not complete it (`isCompletedOnce` in shared/routines.ts).
    var completedOnce: Bool {
        guard let at = onceAt, !enabled, let last = raw["lastRunAt"].number else { return false }
        return last >= at && !running
    }
    var allowed: [RoutineAllowed] {
        (raw["alwaysAllowed"].array ?? []).compactMap { entry in
            guard let tool = entry["tool"].string, !tool.isEmpty else { return nil }
            return RoutineAllowed(kind: entry["kind"].string ?? "", tool: tool, pattern: entry["pattern"].string.flatMap { $0.isEmpty ? nil : $0 })
        }
    }
}
public enum RoutineSections {
    /// Active, Inactive and Completed, each in the order given.
    public static func split(_ routines: [Routine]) -> (active: [Routine], inactive: [Routine], completed: [Routine]) {
        let completed = routines.filter(\.completedOnce)
        let rest = routines.filter { !$0.completedOnce }
        return (rest.filter(\.enabled), rest.filter { !$0.enabled }, completed)
    }
}
public struct RoutineRun: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let startedAt: Double
    public let finishedAt: Double?
    public let status: String
    public let trigger: String
    public let error: String?
    public let conversationId: String?
}
public enum RoutineContract {
    /// A one-time rule's moment in whole minutes: absolute, so a phone in any time zone names the same instant.
    public static func onceMoment(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000 / 60_000).rounded(.down) * 60_000 }
    /// Whether a moment can no longer be chosen for a one-time task.
    public static func oncePast(_ at: Double, now: Double) -> Bool { at <= now }
    public static func validatedRule(kind: String, time: String, minute: Int, day: Int, days: Set<Int>, expression: String = "", at: Double? = nil) throws -> JSONValue {
        guard ["manual", "once", "hourly", "daily", "weekdays", "weekly", "custom", "cron"].contains(kind) else { throw ServiceError.invalidResponse }
        if kind == "once" {
            guard let at, at.isFinite, at > 0 else { throw ServiceError.invalidResponse }
            return .object(["kind": .string(kind), "at": .number((at / 60_000).rounded(.down) * 60_000)])
        }
        if kind == "cron" {
            let text = expression.trimmingCharacters(in: .whitespacesAndNewlines)
            guard CronRule.problem(text) == nil else { throw ServiceError.invalidResponse }
            return .object(["kind": .string(kind), "expression": .string(text)])
        }
        if kind == "manual" { return .object(["kind": .string(kind)]) }
        if kind == "hourly" {
            guard (0...59).contains(minute) else { throw ServiceError.invalidResponse }
            return .object(["kind": .string(kind), "minute": .number(Double(minute))])
        }
        guard time.range(of: "^([01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
        var fields: [String: JSONValue] = ["kind": .string(kind), "time": .string(time)]
        if kind == "weekly" { guard (0...6).contains(day) else { throw ServiceError.invalidResponse }; fields["day"] = .number(Double(day)) }
        if kind == "custom" {
            guard !days.isEmpty, days.allSatisfy({ (0...6).contains($0) }) else { throw ServiceError.invalidResponse }
            fields["days"] = .array(days.sorted().map { .number(Double($0)) })
        }
        return .object(fields)
    }
    public static func input(existing: Routine?, name: String, description: String, prompt: String, enabled: Bool, providerID: String, model: String, rule: JSONValue?, now: Double, chosenModel: (providerID: String, model: String)? = nil, permission: String? = nil) throws -> JSONValue {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines), prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 120, !prompt.isEmpty, prompt.utf16.count <= 100_000, description.utf16.count <= 1000, now.isFinite else { throw ServiceError.invalidResponse }
        var fields = existing?.raw.object ?? ["mode": .string("cowork"), "providerId": .string(providerID), "model": .string(model), "defaultModel": .bool(true), "frequency": .string("daily"), "nextRunAt": .number(now)]
        guard fields["providerId"]?.string?.isEmpty == false, fields["model"]?.string?.isEmpty == false else { throw ServiceError.invalidResponse }
        fields["name"] = .string(name); fields["description"] = .string(description); fields["prompt"] = .string(prompt); fields["enabled"] = .bool(enabled)
        if let chosenModel {
            guard !chosenModel.providerID.isEmpty, !chosenModel.model.isEmpty else { throw ServiceError.invalidResponse }
            fields["providerId"] = .string(chosenModel.providerID); fields["model"] = .string(chosenModel.model); fields["defaultModel"] = .bool(false)
        }
        if let rule {
            fields["repeat"] = rule
            fields["frequency"] = .string(rule["kind"].string == "hourly" ? "hourly" : rule["kind"].string == "weekly" ? "weekly" : rule["kind"].string == "cron" ? CronRule.frequency(rule["expression"].string ?? "") : "daily")
            // The server recalculates the next run in its own timezone. Never claim phone-local scheduling.
            // A one-time task is the exception: its moment is absolute, so the next run is that moment.
            fields["nextRunAt"] = .number(rule["kind"].string == "once" ? (rule["at"].number ?? now) : now)
        }
        if let permission {
            guard Routine.permissionModes.contains(permission) else { throw ServiceError.invalidResponse }
            fields["permission"] = .string(permission)
        }
        return .object(fields)
    }
}
public extension RemoteClaudexService {
    func schedules() async throws -> [Routine] { try await rpc.call("listSchedules", as: [Routine].self) }
    func scheduleRuns(_ id: String) async throws -> [RoutineRun] { try await rpc.call("routineRuns", args: [.string(id)], as: [RoutineRun].self) }
    func schedulePolicy() async throws -> JSONValue { try await rpc.call("clientPolicy", as: JSONValue.self) }
    func saveSchedule(_ input: JSONValue) async throws -> Routine { try await rpc.call("saveSchedule", args: [input], as: Routine.self) }
    func runSchedule(_ id: String) async throws -> Routine { try await rpc.call("runSchedule", args: [.string(id)], as: Routine.self) }
    func deleteSchedule(_ id: String) async throws { let _: JSONValue = try await rpc.call("deleteSchedule", args: [.string(id)], as: JSONValue.self) }
    func memoryStatus() async throws -> MemoryStatus { try await rpc.call("memoryStatus", as: MemoryStatus.self) }
    func memoryDocument(_ scope: MemoryScope) async throws -> MemoryDocument? {
        guard scope.valid else { throw ServiceError.invalidResponse }
        return try await rpc.call("memoryDoc", args: [scope.wire], as: Optional<MemoryDocument>.self)
    }
    func saveMemoryDocument(_ scope: MemoryScope, content: String, revision: Int) async throws -> MemoryDocument {
        guard scope.valid, content.utf8.count <= 16 * 1024, revision >= 0, revision <= 9_007_199_254_740_991 else { throw ServiceError.invalidResponse }
        return try await rpc.call("saveMemoryDoc", args: [scope.wire, .string(content), .number(Double(revision))], as: MemoryDocument.self)
    }
    /// Manage memory (the official "remember or forget" edit): adds one instruction to a scope and/or removes some, and answers
    /// the scope's memory (nil when it has none) with how the change went (the service's `outcome`).
    func updateMemoryEdits(_ scope: MemoryScope, add: String? = nil, remove: [String] = []) async throws -> MemoryEditResult {
        let trimmed = add?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard scope.valid, trimmed != nil || !remove.isEmpty, trimmed.map({ !$0.isEmpty && $0.count <= 2_000 }) ?? true else { throw ServiceError.invalidResponse }
        var change: [String: JSONValue] = [:]
        if let trimmed { change["add"] = .string(trimmed) }
        if !remove.isEmpty { change["remove"] = .array(remove.map(JSONValue.string)) }
        let wire: JSONValue = try await rpc.call("updateMemoryEdits", args: [scope.wire, .object(change)], as: JSONValue.self)
        // A scope left without memory answers an empty document.
        let empty = (wire["edits"].array ?? []).isEmpty && (wire["content"].string ?? "").isEmpty
        return MemoryEditResult(document: empty ? nil : try wire.decode(MemoryDocument.self), outcome: MemoryEditOutcome(wire: wire["outcome"], asked: trimmed != nil))
    }
    func setMemoryPreference(searchChats: Bool? = nil, generate: Bool? = nil) async throws -> MemoryStatus {
        var fields: [String: JSONValue] = [:]
        if let searchChats { fields["searchChats"] = .bool(searchChats) }; if let generate { fields["generate"] = .bool(generate) }
        guard !fields.isEmpty else { throw ServiceError.invalidResponse }
        return try await rpc.call("setMemoryPrefs", args: [.object(fields)], as: MemoryStatus.self)
    }
    func resetMemory(_ scope: MemoryScope) async throws -> MemoryStatus {
        guard scope.valid else { throw ServiceError.invalidResponse }
        return try await rpc.call("resetMemory", args: [scope.wire], as: MemoryStatus.self)
    }
    func removeMemoryEdit(_ id: String) async throws -> MemoryStatus {
        try await rpc.call("removeMemoryEdit", args: [.string(id)], as: MemoryStatus.self)
    }
    func apiGroups(fresh: Bool = false) async throws -> APIGroups { try await rpc.call("apiGroups", args: [.bool(fresh)], as: APIGroups.self) }
    func setAPIGroup(providerID: String, groupID: Int) async throws -> APIGroups {
        guard !providerID.isEmpty, providerID.count <= 40, groupID > 0, groupID <= 9_007_199_254_740_991 else { throw ServiceError.invalidResponse }
        return try await rpc.call("setApiGroup", args: [.string(providerID), .number(Double(groupID))], as: APIGroups.self)
    }
    /// Browser-owned web method: use the same authenticated REST endpoints, never runner RPC.
    func groupRates() async throws -> [String: Double] {
        let generation = await rpc.session.sessionGeneration(), direct = DirectServiceClient(rpc: rpc)
        let available = try await direct.requestBound("api/v1/groups/available", generation: generation)
        // Both sources must be read: do not label a group default as a confirmed account rate after an override-fetch failure.
        let own = try await direct.requestBound("api/v1/groups/rates", generation: generation)
        try await rpc.verifyGeneration(generation)
        return APIGroupRates.normalize(available: available, own: own)
    }
}

public enum APIGroupRates {
    /// Mirrors shared/api-keys-api.ts groupRatesFrom, rejecting invalid or non-finite rates.
    public static func normalize(available: JSONValue, own: JSONValue) -> [String: Double] {
        var result: [String: Double] = [:]
        for group in available.array ?? [] {
            if let id = group["id"].integer, id > 0, Double(id) <= 9_007_199_254_740_991,
               let rate = group["rate_multiplier"].number, rate.isFinite, rate >= 0 { result[String(id)] = rate }
        }
        for (key, value) in own.object ?? [:] {
            if key.range(of: "^[0-9]+$", options: .regularExpression) != nil, let id = Int(key), id > 0, id <= 9_007_199_254_740_991,
               let rate = value.number, rate.isFinite, rate >= 0 { result[String(id)] = rate }
        }
        return result
    }
}
