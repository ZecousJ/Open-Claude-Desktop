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

/// What the diff page says while it reads a session's working tree.
public enum DiffNotice: Equatable, Sendable {
  case loading, unavailable, unable, partial, editsOnly, tooMany, empty, none, ready, stale
}

/// An empty listing says “No changes” once a commit or another branch is selected, and “No changes yet” on All changes.
public func diffSettledNotice(_ notice: DiffNotice, narrowed: Bool) -> DiffNotice {
  if notice == .empty && narrowed { return .none }
  return notice
}

/// A later read failed. A page that already loaded keeps that diff and says it may be out of date.
public func diffRefreshFailure(hadListing: Bool, turnChanges: Bool) -> DiffNotice {
  if hadListing { return .stale }
  return turnChanges ? .editsOnly : .unable
}

public enum DiffListing {
  /// A ready tree with a diff shows the files. A truncated tree still shows what arrived, and says some
  /// files may be missing; a truncated tree with nothing to show is too large. A session that is not a
  /// git checkout cannot show a diff. A failed read falls back to the edits already on the turn.
  public static func notice(loaded: Bool, failed: Bool, state: String?, truncated: Bool, treeDiff: Bool, turnChanges: Bool) -> DiffNotice {
    if !loaded { return .loading }
    if failed { return turnChanges ? .editsOnly : .unable }
    if state == "not-git" || state == "no-folder" { return .unavailable }
    if truncated && !treeDiff { return .tooMany }
    if truncated { return .partial }
    if !treeDiff && turnChanges { return .editsOnly }
    if !treeDiff { return .empty }
    return .ready
  }
}

/// A file whose diff is not a list of text lines: a binary file, a pure rename, or a change with no hunks.
public struct DiffFileFace: Equatable, Sendable {
  public let binary: Bool
  public let hidden: Bool
  public let renamedFrom: String?
}

public func diffFileFace(_ diff: String) -> DiffFileFace {
  let lines = diff.components(separatedBy: "\n")
  if lines.contains(where: { $0.hasPrefix("Binary files ") || $0 == "GIT binary patch" }) {
    return DiffFileFace(binary: true, hidden: true, renamedFrom: nil)
  }
  let from = lines.first { $0.hasPrefix("rename from ") }.flatMap { gitPath(String($0.dropFirst("rename from ".count))) }
  let hunks = lines.contains { $0.hasPrefix("@@") }
  let header = lines.contains { $0.hasPrefix("diff --git ") }
  return DiffFileFace(binary: false, hidden: header && !hunks, renamedFrom: from)
}

/// Lines of a file that the current hunks do not show, and which side they sit on.
public enum DiffExpandWay: Equatable, Sendable { case up, down, all }
public struct DiffExpand: Equatable, Sendable {
  public let hidden: Int
  public let way: DiffExpandWay
}

public func diffExpand(_ diff: String, lineCount: Int?) -> DiffExpand? {
  guard let lineCount, lineCount > 0 else { return nil }
  let header = try? NSRegularExpression(pattern: "^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,(\\d+))? @@")
  var first = Int.max
  var last = 0
  var any = false
  for line in diff.components(separatedBy: "\n") {
    let range = NSRange(line.startIndex..., in: line)
    guard let match = header?.firstMatch(in: line, range: range), match.numberOfRanges >= 2,
          let startRange = Range(match.range(at: 1), in: line), let start = Int(line[startRange]) else { continue }
    any = true
    let count: Int
    if match.numberOfRanges >= 3, let countRange = Range(match.range(at: 2), in: line), match.range(at: 2).location != NSNotFound, let parsed = Int(line[countRange]) {
      count = parsed
    } else { count = 1 }
    if count <= 0 { continue }
    let end = start + count - 1
    if start < first { first = start }
    if end > last { last = end }
  }
  guard any, first != Int.max else { return nil }
  let above = first > 1
  let below = last < lineCount
  let hidden = (above ? first - 1 : 0) + (below ? lineCount - last : 0)
  guard hidden > 0 else { return nil }
  let way: DiffExpandWay = above && below ? .all : above ? .up : .down
  return DiffExpand(hidden: hidden, way: way)
}

/// One commit the working tree lists for the scope menu.
public struct DiffCommit: Equatable, Sendable {
  public let sha: String
  public let shortSha: String
  public let subject: String?
}

/// The base and branch the scope title compares, when both were returned.
public struct DiffScopeEnds: Equatable, Sendable {
  public let base: String
  public let head: String
}

public func diffScopeEnds(base: String?, branch: String?) -> DiffScopeEnds? {
  let left = base?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let right = branch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !left.isEmpty, !right.isEmpty else { return nil }
  return DiffScopeEnds(base: left, head: right)
}

/// Branches offered under Compare against. The checked-out branch is already the right side of the title.
public func diffCompareBranches(_ names: [String], checkedOut: String?) -> [String] {
  let current = checkedOut?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  var seen = Set<String>()
  return names.compactMap { name in
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed != current, seen.insert(trimmed).inserted else { return nil }
    return trimmed
  }
}

public func diffCommitSubject(_ raw: String?) -> String? {
  let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

/// The path a unified diff writes, from its new side, else its old side.
public func diffNewPath(_ diff: String) -> String? {
  let lines = diff.components(separatedBy: "\n")
  guard let line = lines.first(where: { $0.hasPrefix("+++ b/") }) ?? lines.first(where: { $0.hasPrefix("--- a/") }) else { return nil }
  var raw = line
  if raw.hasPrefix("+++ b/") { raw = String(raw.dropFirst(6)) }
  else if raw.hasPrefix("--- a/") { raw = String(raw.dropFirst(6)) }
  raw = raw.components(separatedBy: "\t").first ?? raw
  if raw == "/dev/null" { return nil }
  return gitPath(raw)
}

private func pullRequestParts(_ key: String?) -> (repo: String, number: Int)? {
  let raw = key?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard let hash = raw.lastIndex(of: "#"), hash != raw.startIndex else { return nil }
  let repo = String(raw[..<hash])
  guard let number = Int(raw[raw.index(after: hash)...]), number > 0,
    repo.range(of: #"^[\w.-]+/[\w.-]+$"#, options: .regularExpression) != nil else { return nil }
  return (repo, number)
}

/// The GitHub page for a session pull request recorded as "owner/name#12".
public func pullRequestUrl(_ key: String?) -> String? {
  guard let parts = pullRequestParts(key) else { return nil }
  return "https://github.com/\(parts.repo)/pull/\(parts.number)"
}

/// The number shown on the pull-request chip, as "#12".
public func pullRequestMark(_ key: String?) -> String? {
  guard let parts = pullRequestParts(key) else { return nil }
  return "#\(parts.number)"
}

/// "owner/name" and the pull-request number, for the service's pull endpoint.
public func pullRequestIdentity(_ key: String?) -> (repository: String, number: Int)? {
  guard let parts = pullRequestParts(key) else { return nil }
  return (parts.repo, parts.number)
}

/// The CI chip. A pending check on a merged or closed request reads as unavailable. An unknown value is left out.
public enum CiChip: Equatable, Sendable { case pending, passed, failed, unavailable }

/// Why this pull request is not ready to merge, in the order the row explains it.
public enum MergeHold: Equatable, Sendable { case queued, draft, conflicts, behind, blocked, checking }

/// The review line on a loaded pull request. An empty or unknown decision reads as no review yet.
public enum PullReview: Equatable, Sendable { case none, approved, changes, required }

public func pullReview(_ review: String?) -> PullReview {
  switch review?.lowercased() {
  case "approved": return .approved
  case "changes_requested": return .changes
  case "review_required": return .required
  default: return .none
  }
}

public func mergeHold(state: String?, conflicting: Bool, mergeState: String?) -> MergeHold? {
  if state == "queued" { return .queued }
  if state == "draft" { return .draft }
  if conflicting { return .conflicts }
  switch mergeState {
  case "behind": return .behind
  case "blocked": return .blocked
  case "unknown": return .checking
  default: return nil
  }
}

/// One conversation output opens itself. More than one opens the outputs sheet.
public enum OutputOpen { case none, direct, sheet }

public func outputOpen(count: Int) -> OutputOpen {
  if count <= 0 { return .none }
  if count == 1 { return .direct }
  return .sheet
}

/// An open request whose check list was counted and came back empty.
public func noChecksReported(checks: String?, state: String?) -> Bool {
  let live = state == "open" || state == "draft" || state == "queued"
  return live && checks == "none"
}

public func ciChip(checks: String?, state: String?) -> CiChip? {
  let live = state == "open" || state == "draft" || state == "queued"
  switch checks {
  case "passed": return .passed
  case "failed": return .failed
  case "pending": return live ? .pending : .unavailable
  case "none", "skipped": return .unavailable
  default: return nil
  }
}

/// A base branch worth naming: another branch with a plain name.
public func usableBaseBranch(_ base: String?, branch: String) -> String? {
  guard let base, !base.isEmpty, base != branch else { return nil }
  return base.range(of: #"^[\w./-]+$"#, options: .regularExpression) == nil ? nil : base
}

/// What `codeGitStatus` says about the folder, enough to offer a pull request.
public struct BranchOffer: Equatable, Sendable {
  public let branch: String
  public let repository: String?
  public let baseBranch: String?
  public let cwd: String?
  public let cloud: Bool
  public let pushed: Bool
  public let dirty: Bool
  public let ahead: Int
}

public func branchOffer(state: String?, branch: String?, repository: String?, baseBranch: String?, cwd: String?, cloud: Bool, pushed: Bool, dirty: Bool, ahead: Int) -> BranchOffer? {
  guard state == "ready", let branch = branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty else { return nil }
  func kept(_ value: String?) -> String? {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
  }
  return BranchOffer(branch: branch, repository: kept(repository), baseBranch: kept(baseBranch), cwd: cloud ? nil : kept(cwd), cloud: cloud, pushed: pushed, dirty: dirty, ahead: ahead)
}

/// The push button is offered when the folder has a GitHub remote, a feature branch, and something to send.
public func offersPullRequest(_ offer: BranchOffer, running: Bool) -> Bool {
  if running || offer.repository?.isEmpty != false { return false }
  if offer.baseBranch != nil && offer.branch == offer.baseBranch { return false }
  if offer.cloud && !offer.pushed { return false }
  return offer.dirty || offer.ahead > 0
}

/// The message the push button sends. Claude commits, pushes and opens the request.
public func createPrPrompt(_ offer: BranchOffer) -> String {
  let open = offer.cloud
    ? "Open the PR with the github create_pull_request tool, with `draft` false: the user chose “Create PR”, not “Create draft PR”, for this request."
    : "Open the PR with `gh pr create`. Do not pass `--draft`: the user chose “Create PR”, not “Create draft PR”, for this request, and that explicit choice overrides any saved memory, standing instruction, or earlier plan to open it as a draft."
  let push = offer.cloud ? "Push the branch with the github push tool." : "Push the branch to the remote."
  let baseHint = offer.cloud
    ? "When the target below names a base branch, pass it as `base`; otherwise leave `base` off."
    : "When the target below names a base branch and that branch exists on origin (`git ls-remote --heads origin <base>`), pass it with `--base`; otherwise leave `--base` off and let gh infer it."
  var lines = [
    "## Overview", "",
    "Create a pull request for the changes in this session, ready for review (not a draft).", "",
    "## Steps", "",
    "1. Check for uncommitted changes. If any exist, stage and commit them with a message that describes what changed and why.",
    "2. \(push)",
    "3. \(open) \(baseHint) Write a title that summarizes the change and a body that covers what changed, why, and anything a reviewer should know. If the repo has a PR template, follow it.",
    "4. Report the PR URL when done. Wrap the URL in a `<pr-created>` tag on its own line so the UI can render a live status card, like this: `<pr-created>https://github.com/owner/repo/pull/123</pr-created>`",
    "",
    "If a PR already exists for this branch, push any new commits and report the existing URL wrapped in the same `<pr-created>` tag instead of creating a duplicate, and leave that PR's draft or ready state as it is.",
    "", "## Target", "",
  ]
  if let repository = offer.repository { lines.append("Repository: \(repository)") }
  lines.append("Branch: \(offer.branch)")
  if let base = usableBaseBranch(offer.baseBranch, branch: offer.branch) { lines.append("Base branch: \(base)") }
  if !offer.cloud, let cwd = offer.cwd { lines.append("Working directory: \(cwd)") }
  return "<create-pr-command>\n\(lines.joined(separator: "\n"))\n</create-pr-command>"
}

private func gitPath(_ raw: String) -> String? {
  let value = raw.trimmingCharacters(in: .whitespaces)
  if value.isEmpty { return nil }
  if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
    let inner = String(value.dropFirst().dropLast())
    return inner.isEmpty ? nil : inner
  }
  return value
}
