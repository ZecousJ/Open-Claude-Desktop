import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

final class SessionListTests: XCTestCase {
  private func session(_ id: String, mode: String = "code", archived: Bool = false, updated: Double = 1, turns: [(status: String, texts: [String])] = []) throws -> Conversation {
    let wire: JSONValue = .object([
      "id": .string(id), "title": .string(id), "mode": .string(mode), "providerId": .string("p"), "model": .string("m"),
      "pinned": .bool(false), "archived": .bool(archived), "createdAt": .number(0), "updatedAt": .number(updated),
      "turns": .array(turns.enumerated().map { index, turn in
        .object(["id": .string("\(id)-t\(index)"), "prompt": .string("go"), "attachments": .array([]), "status": .string(turn.status), "createdAt": .number(0),
                 "items": .array(turn.texts.enumerated().map { i, text in .object(["id": .string("i\(i)"), "type": .string("agentMessage"), "text": .string(text)]) })])
      }),
    ])
    return try wire.decode(Conversation.self)
  }
  private let tag = { (number: Int) in "<pr-created>https://github.com/octo/hello/pull/\(number)</pr-created>" }

  func testFiltersFollowTheOfficialOrder() {
    XCTAssertEqual(SessionFilter.allCases.map(\.rawValue), ["all", "working", "needsInput", "readyForReview", "completed", "archived"])
    XCTAssertFalse(SessionList.coworkFilters.contains(.readyForReview))
    XCTAssertEqual(SessionList.coworkFilters.count, 5)
  }

  func testEachSessionIsInOneBucket() throws {
    let done = try session("done", turns: [("completed", [])])
    let running = try session("running", turns: [("inProgress", [])])
    let asking = try session("asking", turns: [("inProgress", [])])
    let reviewing = try session("reviewing", turns: [("completed", [])])
    let archived = try session("archived", archived: true, turns: [("completed", [])])
    let failed = try session("failed", turns: [("failed", [])])
    let all = [done, running, asking, reviewing, archived, failed]
    let waiting: Set = ["asking"], review: Set = ["reviewing", "running", "asking"]
    func ids(_ filter: SessionFilter) -> [String] { all.filter { SessionList.matches(filter, $0, waiting: waiting, review: review) }.map(\.id) }
    XCTAssertEqual(ids(.all), ["done", "running", "asking", "reviewing", "failed"])
    XCTAssertEqual(ids(.working), ["running"])
    XCTAssertEqual(ids(.needsInput), ["asking"])
    // A running or waiting session is never "ready", whatever its last pull request says.
    XCTAssertEqual(ids(.readyForReview), ["reviewing"])
    XCTAssertEqual(ids(.completed), ["done"])
    XCTAssertEqual(ids(.archived), ["archived"])
  }

  func testTheSessionsPullRequestIsTheLastTaggedOne() throws {
    let first = "Done.\n" + tag(3)
    let second = "Pushed again.\n<pr-created> https://github.com/Octo/Hello/pull/9 </pr-created>"
    let c = try session("c", turns: [("completed", [first]), ("completed", [second, "See https://github.com/octo/hello/pull/12 for context"])])
    XCTAssertEqual(SessionReviewPolicy.pullRequest(c), PullRef(repository: "Octo/Hello", number: 9))
    XCTAssertEqual(SessionReviewPolicy.pullRequest(c)?.key, "octo/hello#9")
    // A plain link is not the session's own, and only github.com is asked about.
    XCTAssertNil(SessionReviewPolicy.pullRequest(try session("plain", turns: [("completed", ["https://github.com/octo/hello/pull/12"])])))
    XCTAssertNil(SessionReviewPolicy.pullRequest(try session("ghe", turns: [("completed", ["<pr-created>https://git.example.com/a/b/pull/1</pr-created>"])])))
    XCTAssertNil(SessionReviewPolicy.pullRequest(try session("none")))
  }

  func testOnlyFinishedCodeSessionsAreAskedAbout() throws {
    let list = [
      try session("a", updated: 5, turns: [("completed", [tag(1)])]),
      try session("running", updated: 9, turns: [("inProgress", [tag(2)])]),
      try session("archived", archived: true, turns: [("completed", [tag(3)])]),
      try session("chat", mode: "chat", turns: [("completed", [tag(4)])]),
      try session("b", updated: 7, turns: [("completed", [tag(5)])]),
      try session("plain", turns: [("completed", ["no request"])]),
    ]
    XCTAssertEqual(SessionReviewPolicy.candidates(list).map(\.id), ["b", "a"])
    let many = try (1...60).map { try session("s\($0)", updated: Double($0), turns: [("completed", [tag($0)])]) }
    XCTAssertEqual(SessionReviewPolicy.candidates(many).count, SessionReviewPolicy.maxAsked)
  }

  func testTheServiceBodyAndAnswerRoundTrip() throws {
    let body = SessionReviewPolicy.request([PullRef(repository: "octo/hello", number: 7)])
    XCTAssertEqual(body["pulls"].array?.first?["repo"].string, "octo/hello")
    XCTAssertEqual(body["pulls"].array?.first?["number"].integer, 7)
    let answer = try JSONDecoder().decode(JSONValue.self, from: Data("""
    {"states":[{"repository":"octo/hello","number":7,"state":"open","review":"review_required","awaits_review":true},{"repository":"octo/hello","number":8,"state":"draft","awaits_review":false},{"number":9}]}
    """.utf8))
    XCTAssertEqual(SessionReviewPolicy.verdicts(answer), [PullVerdict(key: "octo/hello#7", awaitsReview: true), PullVerdict(key: "octo/hello#8", awaitsReview: false)])
    XCTAssertTrue(SessionReviewPolicy.verdicts(.object([:])).isEmpty)
  }

  func testVerdictsAreKeptForAMinuteAndAFailedQuestionKeepsThem() async throws {
    let list = try [1, 2, 3].map { try session(["a", "b", "gone"][$0 - 1], turns: [("completed", [tag($0)])]) }
    final class Box: @unchecked Sendable {
      var now = Date(timeIntervalSince1970: 1_000_000); var asked: [[String]] = []
      var answer: [PullVerdict]? = [PullVerdict(key: "octo/hello#1", awaitsReview: true), PullVerdict(key: "octo/hello#2", awaitsReview: false)]
    }
    let box = Box()
    let review = SessionReview(now: { box.now }, ask: { refs in box.asked.append(refs.map(\.key)); return box.answer })
    var ready = await review.load(list)
    XCTAssertEqual(ready, ["a"]); XCTAssertEqual(box.asked.count, 1)
    // Inside the minute nothing is asked again; the filter reads the kept answers.
    box.now = box.now.addingTimeInterval(30); ready = await review.load(list)
    XCTAssertEqual(box.asked.count, 1)
    // Pull to refresh asks at once; a failed question keeps the last answer.
    box.answer = nil; ready = await review.load(list, force: true)
    XCTAssertEqual(box.asked.count, 2); XCTAssertEqual(ready, ["a"])
    // After the minute a request, and one GitHub no longer answers for, is asked again and answered.
    box.now = box.now.addingTimeInterval(61); box.answer = [PullVerdict(key: "octo/hello#2", awaitsReview: true)]
    ready = await review.load(list)
    XCTAssertEqual(ready, ["b"])
    await review.clear()
    box.answer = nil; ready = await review.load(list)
    XCTAssertTrue(ready.isEmpty)
  }

  func testTheDirectClientMayAskTheService() {
    XCTAssertEqual(SessionReviewPolicy.path, "api/v1/claudex/web/github/pull/states")
  }
}
