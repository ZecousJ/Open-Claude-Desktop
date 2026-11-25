import Foundation

/// The iOS release listed by GET /api/v1/claudex/apps. Update opens this address; the app does not download a package.
public struct StoreRelease: Equatable, Sendable {
    public let version: String
    public let url: URL
    public let notes: String
    public init(version: String, url: URL, notes: String) {
        self.version = version
        self.url = url
        self.notes = notes
    }
}

public enum AppReleasePolicy {
    /// Numeric version order ("0.10.0" > "0.9.3"). A value that is not a version is never newer.
    public static func newer(_ candidate: String, than current: String) -> Bool {
        guard isVersion(candidate) else { return false }
        let offered = numbers(candidate)
        let installed = numbers(current.split(separator: "-", maxSplits: 1).first.map(String.init) ?? current)
        for index in 0..<max(offered.count, installed.count) {
            let left = index < offered.count ? offered[index] : 0
            let right = index < installed.count ? installed[index] : 0
            if left != right { return left > right }
        }
        return false
    }

    /// The release to offer, or nil when the version or address is missing or not one this app may open.
    /// Allowed addresses are TestFlight, the App Store, and this app's own service. Another host is ignored.
    public static func release(_ body: JSONValue, origin: String) -> StoreRelease? {
        let container = body["data"].object != nil ? body["data"] : body
        let app = container["ios"]
        guard let version = app["version"].string, isVersion(version) else { return nil }
        guard let raw = app["url"].string, let url = URL(string: raw), allowed(url, origin: origin) else { return nil }
        let notes = String((app["notes"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000))
        return StoreRelease(version: version, url: url, notes: notes)
    }

    private static func isVersion(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...4).contains(parts.count) else { return false }
        return parts.allSatisfy { part in (1...4).contains(part.count) && part.allSatisfy(\.isNumber) }
    }

    private static func numbers(_ value: String) -> [Int] {
        value.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
    }

    private static let stores: Set<String> = ["testflight.apple.com", "apps.apple.com"]

    private static func allowed(_ url: URL, origin: String) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, let host = url.host?.lowercased() else { return false }
        let path = url.path
        guard !path.isEmpty, path != "/" else { return false }
        if stores.contains(host) { return true }
        return host == URL(string: origin)?.host?.lowercased()
    }
}
