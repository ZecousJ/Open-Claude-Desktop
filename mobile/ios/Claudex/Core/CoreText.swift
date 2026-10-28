import Foundation

/// Words for the lines the Core raises that a person can read (errors, default file names). The Core
/// stays free of the app bundle: the app installs a resolver at launch that answers from its string
/// catalogue (`L()`), and the tests install the catalogue read from `Resources/Strings`. Without a
/// resolver a key answers itself, so a missing install shows as a key, never as someone else's language.
///
/// Every `Key` must be in both `en.strings` and `zh-Hans.strings` (`CoreTextTests`), and the Core holds
/// no hard-coded Chinese (the same test reads the sources).
public enum CoreText {
    public typealias Resolver = @Sendable (_ key: String, _ arguments: [CVarArg]) -> String

    public enum Key: String, CaseIterable, Sendable {
        // Official resource names the Core reuses.
        case somethingWentWrongTryAgain = "generic_error_something_went_wrong_try_again"
        case sessionInvalid = "error_account_session_invalid"
        case unknownError = "error_unknown"
        case previewTooLarge = "document_preview_too_large"
        // Claudex's own.
        case serverUnexpected = "claudex_core_server_unexpected"
        case fileOverLimit = "claudex_core_file_over_limit"
        case cannotReachService = "claudex_core_cannot_reach_service"
        case runsLimit = "claudex_core_runs_limit"
        case serviceBusy = "claudex_core_service_busy"
        case timeUnknown = "claudex_core_time_unknown"
        case uploadFailed = "claudex_core_upload_failed"
        case keyNameInvalid = "claudex_core_key_name_invalid"
        case keysOverLimit = "claudex_core_keys_over_limit"
        case groupUnavailable = "claudex_core_group_unavailable"
        case keyCreatedNotRead = "claudex_core_key_created_not_read"
        case keyGone = "claudex_core_key_gone"
        case codeInvalid = "claudex_core_code_invalid"
        case fileNotReady = "claudex_core_file_not_ready"
        case titleInvalid = "claudex_core_title_invalid"
        case projectUnavailable = "claudex_core_project_unavailable"
        case photoName = "claudex_core_photo_name"
        case snippetName = "claudex_core_snippet_name"
        case imageName = "claudex_core_image_name"
        case deviceOffline = "claudex_core_device_offline"
        case deviceBusy = "claudex_core_device_busy"
        case deviceTimeout = "claudex_core_device_timeout"
        case deviceOutdated = "claudex_core_device_outdated"
        case deviceNotHere = "claudex_core_device_not_here"
        case deviceAnswered = "claudex_core_device_answered"
        case deviceWriteFirst = "claudex_core_device_write_first"
        case deviceWaitOrStop = "claudex_core_device_wait_or_stop"
        case deviceFolderNotAdded = "claudex_core_device_folder_not_added"
        case deviceNotRoot = "claudex_core_device_not_root"
        case deviceNoModel = "claudex_core_device_no_model"
        case deviceModelNotAllowed = "claudex_core_device_model_not_allowed"
        case deviceStartFailed = "claudex_core_device_start_failed"
    }

    private final class Holder: @unchecked Sendable {
        private let lock = NSLock()
        private var resolver: Resolver?
        func set(_ value: Resolver?) { lock.lock(); resolver = value; lock.unlock() }
        func get() -> Resolver? { lock.lock(); defer { lock.unlock() }; return resolver }
    }
    private static let holder = Holder()

    /// Sets (or, with nil, clears) the resolver; the app calls this once at launch.
    public static func install(_ resolver: Resolver?) { holder.set(resolver) }

    public static func string(_ key: Key, _ arguments: CVarArg...) -> String {
        holder.get()?(key.rawValue, arguments) ?? key.rawValue
    }
}
