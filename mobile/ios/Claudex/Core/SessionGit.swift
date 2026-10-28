import Foundation

/// What a cloud Code session knows about its repository, branch and pull requests. The runner writes
/// them onto the session (`repository`, `branch`, `gitState`, `pullRequests`; shared/session-git.ts in
/// the main repository) and they arrive as wire extension fields.
///
/// The Code list searches the title, repository and branch (official `session_list_search_a11y`), and
/// the session menu offers "Copy branch" (Ready for review is `SessionList`).
extension Conversation {
  /// "owner/name" of the session's main repository.
  public var repositoryName: String? {
    let name = extensionFields["repository"]?["fullName"].string?.trimmingCharacters(in: .whitespacesAndNewlines)
    return name?.isEmpty == false ? name : nil
  }
  /// The branch the session works on, as the runner last read it from the sandbox's folder.
  public var branchName: String? {
    let name = extensionFields["branch"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
    return name?.isEmpty == false ? name : nil
  }
  private var gitDirty: Bool { extensionFields["gitState"]?["dirty"].bool == true }
  private var gitUnpushed: Bool { extensionFields["gitState"]?["unpushed"].bool == true }
  private var latestPullRequest: JSONValue? { extensionFields["pullRequests"]?.array?.last }
  /// The newest pull request's state: open, draft, queued, merged or closed.
  public var latestPullRequestState: String? {
    let state = latestPullRequest?["state"].string
    return state?.isEmpty == false ? state : nil
  }
  /// The newest pull request as "owner/name#12", the key the service answers by.
  public var latestPullRequestKey: String? {
    guard let repository = latestPullRequest?["repository"].string, !repository.isEmpty,
      let number = latestPullRequest?["number"].integer, number > 0
    else { return nil }
    return "\(repository)#\(number)"
  }
  /// The Code list search: the title, repository or branch contains the text (case-insensitive).
  public func matchesSessionSearch(_ query: String) -> Bool {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if needle.isEmpty { return true }
    return title.localizedCaseInsensitiveContains(needle)
      || repositoryName?.localizedCaseInsensitiveContains(needle) == true
      || branchName?.localizedCaseInsensitiveContains(needle) == true
  }
}
