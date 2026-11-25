import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

final class SessionGitTests: XCTestCase {
  private func session(_ extra: [String: JSONValue] = [:], status: String = "completed", archived: Bool = false, title: String = "Fix login") throws -> Conversation {
    var fields: [String: JSONValue] = [
      "id": .string("c1"), "title": .string(title), "mode": .string("code"), "providerId": .string("p"), "model": .string("m"),
      "pinned": .bool(false), "archived": .bool(archived), "createdAt": .number(1), "updatedAt": .number(2),
      "turns": .array([.object(["id": .string("t1"), "prompt": .string("go"), "attachments": .array([]), "items": .array([]),
                                "status": .string(status), "createdAt": .number(1)])]),
    ]
    for (key, value) in extra { fields[key] = value }
    return try JSONValue.object(fields).decode(Conversation.self)
  }
  private func pullRequest(_ state: String, repository: String = "octo/repo", number: Double = 1) -> JSONValue {
    .object(["repository": .string(repository), "number": .number(number), "url": .string("https://github.com/\(repository)/pull/\(Int(number))"), "state": .string(state)])
  }

  func testFactsComeFromTheWireExtensionFields() throws {
    let c = try session([
      "repository": .object(["fullName": .string("Octo/Repo"), "url": .string("https://github.com/Octo/Repo")]),
      "branch": .string("feature/login"),
    ])
    XCTAssertEqual(c.repositoryName, "Octo/Repo")
    XCTAssertEqual(c.branchName, "feature/login")
    // A session from before they were recorded carries nothing.
    let bare = try session()
    XCTAssertNil(bare.repositoryName)
    XCTAssertNil(bare.branchName)
    XCTAssertNil(try session(["branch": .string("  ")]).branchName)
  }

  func testSearchMatchesTitleRepositoryAndBranch() throws {
    let c = try session(["repository": .object(["fullName": .string("Octo/Repo")]), "branch": .string("feature/login-fix")])
    XCTAssertTrue(c.matchesSessionSearch("fix login"))
    XCTAssertTrue(c.matchesSessionSearch("octo/repo"))
    XCTAssertTrue(c.matchesSessionSearch(" LOGIN-FIX "))
    XCTAssertFalse(c.matchesSessionSearch("payments"))
    XCTAssertTrue(c.matchesSessionSearch("   "))
    XCTAssertFalse(try session().matchesSessionSearch("octo"))
  }

  func testDiffNoticeFollowsTheWorkingTree() {
    XCTAssertEqual(diffSettledNotice(.empty, narrowed: true), .none)
    XCTAssertEqual(diffSettledNotice(.empty, narrowed: false), .empty)
    XCTAssertEqual(diffSettledNotice(.ready, narrowed: true), .ready)
    XCTAssertEqual(diffRefreshFailure(hadListing: true, turnChanges: true), .stale)
    let feature = BranchOffer(branch: "feature", repository: "owner/name", baseBranch: "main", cwd: "/src", cloud: false, pushed: false, dirty: true, ahead: 0)
    XCTAssertTrue(offersPullRequest(feature, running: false))
    XCTAssertFalse(offersPullRequest(feature, running: true))
    XCTAssertNil(usableBaseBranch("main", branch: "main"))
    XCTAssertNil(usableBaseBranch("bad name", branch: "feature"))
    let prompt = createPrPrompt(feature)
    XCTAssertTrue(prompt.hasPrefix("<create-pr-command>"))
    XCTAssertTrue(prompt.contains("Repository: owner/name"))
    XCTAssertTrue(prompt.contains("Branch: feature"))
    XCTAssertTrue(prompt.contains("Base branch: main"))
    XCTAssertTrue(prompt.contains("Working directory: /src"))
    XCTAssertTrue(prompt.contains("gh pr create"))
    XCTAssertEqual(pullRequestUrl("owner/name#12"), "https://github.com/owner/name/pull/12")
    XCTAssertEqual(pullRequestMark("owner/name#12"), "#12")
    XCTAssertEqual(ciChip(checks: "passed", state: "open"), .passed)
    XCTAssertEqual(ciChip(checks: "pending", state: "merged"), .unavailable)
    XCTAssertEqual(ciChip(checks: "pending", state: "draft"), .pending)
    XCTAssertNil(ciChip(checks: nil, state: "open"))
    XCTAssertEqual(mergeHold(state: "draft", conflicting: true, mergeState: "behind"), .draft)
    XCTAssertEqual(mergeHold(state: "open", conflicting: true, mergeState: "blocked"), .conflicts)
    XCTAssertEqual(mergeHold(state: "open", conflicting: false, mergeState: "behind"), .behind)
    XCTAssertEqual(mergeHold(state: "open", conflicting: false, mergeState: "unknown"), .checking)
    XCTAssertNil(mergeHold(state: "open", conflicting: false, mergeState: "clean"))
    XCTAssertEqual(pullReview("APPROVED"), .approved)
    XCTAssertEqual(pullReview("changes_requested"), .changes)
    XCTAssertEqual(pullReview("review_required"), .required)
    XCTAssertEqual(pullReview(nil), .none)
    XCTAssertEqual(outputOpen(count: 0), .none)
    XCTAssertEqual(outputOpen(count: 1), .direct)
    XCTAssertEqual(outputOpen(count: 2), .sheet)
    XCTAssertTrue(noChecksReported(checks: "none", state: "open"))
    XCTAssertFalse(noChecksReported(checks: "none", state: "merged"))
    XCTAssertFalse(noChecksReported(checks: "skipped", state: "open"))
    XCTAssertNil(pullRequestUrl("owner/name"))
    XCTAssertNil(pullRequestUrl("bad name#1"))
    XCTAssertEqual(diffRefreshFailure(hadListing: false, turnChanges: true), .editsOnly)
    XCTAssertEqual(diffRefreshFailure(hadListing: false, turnChanges: false), .unable)
    XCTAssertEqual(DiffListing.notice(loaded: false, failed: false, state: nil, truncated: false, treeDiff: false, turnChanges: false), .loading)
    XCTAssertEqual(DiffListing.notice(loaded: true, failed: false, state: "not-git", truncated: false, treeDiff: false, turnChanges: true), .unavailable)
    XCTAssertEqual(DiffListing.notice(loaded: true, failed: false, state: "no-folder", truncated: false, treeDiff: false, turnChanges: false), .unavailable)
    XCTAssertEqual(DiffListing.notice(loaded: true, failed: true, state: nil, truncated: false, treeDiff: false, turnChanges: false), .unable)
    XCTAssertEqual(DiffListing.notice(loaded: true, failed: true, state: nil, truncated: false, treeDiff: false, turnChanges: true), .editsOnly)
    XCTAssertEqual(DiffListing.notice(loaded: true, failed: false, state: "ready", truncated: true, treeDiff: false, turnChanges: false), .tooMany)
    XCTAssertEqual(DiffListing.notice(loaded: true, failed: false, state: "ready", truncated: true, treeDiff: true, turnChanges: false), .partial)
    XCTAssertEqual(DiffListing.notice(loaded: true, failed: false, state: "ready", truncated: false, treeDiff: false, turnChanges: false), .empty)
    XCTAssertEqual(DiffListing.notice(loaded: true, failed: false, state: "ready", truncated: false, treeDiff: true, turnChanges: false), .ready)
  }

  func testBinaryRenameAndHeaderOnlyDiffsAreNamed() {
    XCTAssertTrue(diffFileFace("diff --git a/a.bin b/a.bin\nBinary files a/a.bin and b/a.bin differ").binary)
    XCTAssertTrue(diffFileFace("GIT binary patch").binary)
    let renamed = diffFileFace("diff --git a/old b/new\nrename from \"old name\"\nrename to new")
    XCTAssertEqual(renamed.renamedFrom, "old name")
    XCTAssertTrue(renamed.hidden)
    XCTAssertFalse(renamed.binary)
    let edited = diffFileFace("diff --git a/old b/new\nrename from old\n@@ -1 +1 @@\n-a\n+b")
    XCTAssertEqual(edited.renamedFrom, "old")
    XCTAssertFalse(edited.hidden)
    XCTAssertTrue(diffFileFace("diff --git a/a b/a\nindex 1..2").hidden)
    XCTAssertFalse(diffFileFace("plain text").hidden)
    XCTAssertFalse(diffFileFace("plain text").binary)
    let both = diffExpand("@@ -10,2 +10,2 @@\n a\n b", lineCount: 20)
    XCTAssertEqual(both?.hidden, 18)
    XCTAssertEqual(both?.way, .all)
    let down = diffExpand("@@ -1,2 +1,2 @@\n a\n b", lineCount: 10)
    XCTAssertEqual(down?.hidden, 8)
    XCTAssertEqual(down?.way, .down)
    let up = diffExpand("@@ -8,3 +8,3 @@\n a\n b\n c", lineCount: 10)
    XCTAssertEqual(up?.hidden, 7)
    XCTAssertEqual(up?.way, .up)
    XCTAssertNil(diffExpand("@@ -1,10 +1,10 @@\n a", lineCount: 10))
    XCTAssertNil(diffExpand("@@ -1,3 +0,0 @@", lineCount: 5))
    XCTAssertEqual(diffNewPath("diff --git a/src/A.kt b/src/A.kt\n+++ b/src/A.kt"), "src/A.kt")
    XCTAssertEqual(diffNewPath("diff --git a/old b/old\n--- a/old\n+++ /dev/null"), "old")
    let ends = diffScopeEnds(base: " main ", branch: " feature ")
    XCTAssertEqual(ends?.base, "main")
    XCTAssertEqual(ends?.head, "feature")
    XCTAssertNil(diffScopeEnds(base: " ", branch: "feature"))
    XCTAssertEqual(diffCompareBranches([" feature ", "develop", "develop", ""], checkedOut: "feature"), ["develop"])
    XCTAssertEqual(diffCommitSubject(" Fix "), "Fix")
    XCTAssertNil(diffCommitSubject(" "))
  }

}
