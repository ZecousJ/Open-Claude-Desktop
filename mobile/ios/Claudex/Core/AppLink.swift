import Foundation

/// A claudex:// or https://claudex.zecous.cn link. The text is only placed in the composer.
public enum AppLink: Equatable {
    case chat(String)
    case project(String)
    case composer(ChatMode, String?)
}

public enum AppLinks {
    private static let sites: Set<String> = ["claudex.zecous.cn", "claude.ai"]
    private static let id = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,128}$")

    public static func parse(_ href: String) -> AppLink? {
        guard let uri = URL(string: href), uri.user == nil, uri.password == nil, let scheme = uri.scheme?.lowercased() else { return nil }
        let host = uri.host?.lowercased()
        let path = uri.path.split(separator: "/").map { String($0).removingPercentEncoding }.compactMap { $0 }
        if path.count != uri.path.split(separator: "/").count { return nil }
        let parts: [String]
        switch scheme {
        case "claudex":
            var all = [host.map { $0.removingPercentEncoding ?? $0 }].compactMap { $0 } + path
            if let first = all.first, sites.contains(first) { all.removeFirst() }
            parts = all
        case "https":
            guard host == "claudex.zecous.cn" else { return nil }
            parts = path
        default:
            return nil
        }
        let prompt = query(uri, "q").map { String($0.prefix(10_000)) }?.nilIfEmpty
        let first = parts.first
        let second = parts.dropFirst().first
        if parts.count == 1, first == "new" { return .composer(query(uri, "surface") == "cowork" ? .cowork : .chat, prompt) }
        if first == "chat", second == "new" { return .composer(.chat, prompt) }
        if first == "cowork", second == "new" { return .composer(.cowork, prompt) }
        if first == "cowork", second == "project", let project = parts.dropFirst(2).first, valid(project) { return .project(project) }
        if (first == "chat" || first == "conversation"), let second, valid(second) { return .chat(second) }
        if first == "project", let second, valid(second) { return .project(second) }
        if first == "code", second == nil || second == "new" {
            if query(uri, "ssh_host") != nil { return nil }
            return .composer(.code, prompt ?? query(uri, "prompt").map { String($0.prefix(10_000)) }?.nilIfEmpty)
        }
        if first == "code", second == "continue" || second == "needs-input", let session = query(uri, "session"), valid(session) { return .chat(session) }
        return nil
    }

    private static func valid(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..., in: value)
        return id.firstMatch(in: value, range: range)?.range == range
    }

    private static func query(_ uri: URL, _ name: String) -> String? {
        URLComponents(url: uri, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value?.nilIfEmpty
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
