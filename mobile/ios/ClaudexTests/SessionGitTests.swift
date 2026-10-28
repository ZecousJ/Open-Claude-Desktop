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

}
