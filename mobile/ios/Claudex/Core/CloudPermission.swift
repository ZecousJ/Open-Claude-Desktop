import Foundation

/// shared/host.ts CloudPermissionMode; choices are never synthesized from defaults.
public enum CloudPermissionMode: String, CaseIterable, Sendable, Equatable {
    case auto, manual, acceptEdits, plan, bypass
}
public enum CloudPermissionAvailability: Sendable, Equatable {
    case loading, unavailable, invalid, ready, changing
}
public struct CloudPermissionForm: Sendable, Equatable {
    public let availability: CloudPermissionAvailability
    public let modes: [CloudPermissionMode]
    public let selected: CloudPermissionMode?
    public let hasUnsupportedEntries: Bool
    public let bypassDisabled: Bool
    public init(host: JSONValue?, settings: Settings?, loading: Bool, changing: Bool) {
        bypassDisabled = settings?.raw["allowBypassPermissions"].bool == false
        selected = settings.flatMap { CloudPermissionContract.selected($0) }
        let raw = host?["cloud"]["permissionModes"] ?? .null
        var values: [CloudPermissionMode] = []
        var unsupported = false
        for entry in raw.array ?? [] {
            guard let name = entry.string, let mode = CloudPermissionMode(rawValue: name) else { unsupported = true; continue }
            if !values.contains(mode) { values.append(mode) }
        }
        modes = values; hasUnsupportedEntries = unsupported
        if changing { availability = .changing }
        else if loading { availability = .loading }
        else if host?["capabilities"]["cloudCode"].bool != true || raw == .null || raw.array?.isEmpty == true { availability = .unavailable }
        else if raw.array == nil || values.isEmpty || selected == nil { availability = .invalid }
        else { availability = .ready }
    }
    public func canSelect(_ mode: CloudPermissionMode) -> Bool {
        availability == .ready && modes.contains(mode) && (mode != .bypass || !bypassDisabled)
    }
}
public enum CloudPermissionContract {
    /// Display the saved choice, including Bypass; unknown data never becomes Auto/write.
    public static func selected(_ settings: Settings) -> CloudPermissionMode? {
        guard let sandbox = settings.raw["codeSandbox"].string,
              ["read-only", "workspace-write", "danger-full-access"].contains(sandbox),
              let plan = settings.raw["codePlanMode"].bool,
              let edits = settings.raw["autoAcceptEdits"].bool else { return nil }
        if plan { return sandbox == "read-only" && !edits ? .plan : nil }
        if sandbox == "danger-full-access" { return .bypass }
        if edits { return .acceptEdits }
        return sandbox == "read-only" ? .manual : .auto
    }
    public static func selecting(_ mode: CloudPermissionMode, host: JSONValue?, settings: Settings, loading: Bool = false, changing: Bool = false, confirmed: Bool = false) throws -> Settings {
        let form = CloudPermissionForm(host: host, settings: settings, loading: loading, changing: changing)
        guard form.canSelect(mode) else { throw ServiceError.invalidResponse }
        guard mode != .bypass || confirmed else { throw ServiceError.invalidResponse }
        guard var fields = settings.raw.object else { throw ServiceError.invalidResponse }
        // Mirrors CodePermissionPicker's cloud branch on main dd5137a8.
        // Folder confirmation, capability and authorization remain owned by the runner.
        fields["codeSandbox"] = .string(mode == .bypass ? "danger-full-access" : [.manual, .plan].contains(mode) ? "read-only" : "workspace-write")
        fields["autoAcceptEdits"] = .bool(mode == .acceptEdits)
        fields["codePlanMode"] = .bool(mode == .plan)
        var copy = settings; copy.raw = .object(fields); return copy
    }
}
