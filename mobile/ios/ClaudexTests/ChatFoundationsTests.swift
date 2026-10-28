import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

/// Schema-pinned fixtures from main 7dda489 shared/types.ts, branches.ts and runner handlers.
/// Synthetic test values, not a recording or claim of live native account acceptance.
private let conversationFixture = """
{"id":"c1","title":"Fixture","mode":"chat","providerId":"p","model":"m","pinned":false,"archived":false,"createdAt":0,"updatedAt":10,"branchVisit":5,"turns":[{"id":"t3","responseGroupId":"r1","promptGroupId":"p1","promptVersionId":"pv2","prompt":"Edited","attachments":[],"items":[{"id":"i3","type":"agentMessage","text":"# Result\\n\\nComplete"}],"status":"completed","createdAt":3}],"savedBranches":[{"id":"b1","visited":1,"turns":[{"id":"t1","responseGroupId":"r1","promptGroupId":"p1","promptVersionId":"pv1","prompt":"Original","attachments":[],"items":[],"status":"completed","createdAt":1}]},{"id":"b2","visited":3,"turns":[{"id":"t2","responseGroupId":"r1","promptGroupId":"p1","promptVersionId":"pv2","prompt":"Edited","attachments":[],"items":[],"status":"completed","createdAt":2}]}]}
"""
private func fixtureConversation() throws -> Conversation { try JSONDecoder().decode(Conversation.self, from: Data(conversationFixture.utf8)) }
private func fileFixture(data: Data = Data("abc".utf8), digest: String? = nil, size: Int? = nil, name: String = "result.pdf", state: String = "ready") throws -> GeneratedFile {
    try JSONValue.object(["id": .string("f1"), "name": .string(name), "path": .string("/workspace/result.pdf"), "language": .string("pdf"), "state": .string(state), "blob": .bool(true), "digest": .string(digest ?? UploadDigest.sha256(data)), "bytes": .number(Double(size ?? data.count)), "mime": .string("application/pdf")]).decode(GeneratedFile.self)
}
final class ChatFoundationsTests: XCTestCase {
    func testBlockMarkdownHasStructureNotInlineOnlyText() {
        let result = MarkdownBlocks.parse("# Heading\n\nParagraph **bold**\n\n- first\n  - child\n2. next\n\n> quote\n\n---")
        XCTAssertEqual(result, [.heading(1, "Heading"), .paragraph("Paragraph **bold**"), .list(marker: "•", text: "first", depth: 0), .list(marker: "•", text: "child", depth: 1), .list(marker: "2.", text: "next", depth: 0), .quote("quote"), .rule])
    }
    func testStreamingFenceRetainsEveryCodeByteAndDoesNotParseInnerHTML() {
        let source = "```html\n<script>bad()</script>\n# not a heading"
        XCTAssertEqual(MarkdownBlocks.parse(source), [.code(language: "html", source: "<script>bad()</script>\n# not a heading")])
        XCTAssertEqual(MarkdownBlocks.parse("````swift\n```\nlet x = 1\n````\nAfter"), [.code(language: "swift", source: "```\nlet x = 1"), .paragraph("After")])
    }
    func testTablesPreserveEscapedPipesAndInlineCodeAndPadShortRows() {
        XCTAssertEqual(MarkdownBlocks.parse("| A | B |\n| :--- | ---: |\n| x\\|y | `a|b` |\n| one |"), [.table(header: ["A", "B"], rows: [["x|y", "`a|b`"], ["one", ""]])])
    }
    func testMathAndMermaidRemainExplicitSourceBlocks() {
        XCTAssertEqual(MarkdownBlocks.parse("$$\nx^2 + y^2\n$$\n```mermaid\ngraph TD; A-->B\n```"), [.math("x^2 + y^2"), .code(language: "mermaid", source: "graph TD; A-->B")])
    }
    func testImagesParsedWithoutFetchingAndOnlyHTTPSLinksAllowed() {
        XCTAssertEqual(MarkdownBlocks.parse("![alt](https://images.test/p.png)"), [.image(alt: "alt", destination: "https://images.test/p.png")])
        for url in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "http://example.com", "claudex://run", "https://u:p@example.com", "https://example.com/\nfoo"] { XCTAssertNil(SafeContentURL.link(url), url) }
        XCTAssertEqual(SafeContentURL.link("https://example.com/path?q=a#section")?.host, "example.com")
    }
    func testVersionsFollowServerGroupingAndMostVisitedPromptContinuation() throws {
        let conversation = try fixtureConversation(), turn = try XCTUnwrap(conversation.turns.first)
        XCTAssertEqual(ConversationVersions.versions(conversation, turn: turn).map(\.turnID), ["t1", "t2", "t3"])
        let prompt = ConversationVersions.versions(conversation, turn: turn, prompt: true)
        XCTAssertEqual(prompt.map(\.turnID), ["t1", "t3"])
        XCTAssertEqual(prompt.last?.createdAt, 2)
        let roundTrip = try JSONValue.encode(conversation).decode(Conversation.self)
        XCTAssertEqual(roundTrip.turns.first?.promptVersionId, "pv2"); XCTAssertEqual(roundTrip.branchVisit, 5)
    }
    func testLegacyTurnsWithoutVersionMetadataRemainSingleVersion() throws {
        var conversation = try fixtureConversation(); conversation.savedBranches = nil
        conversation.turns[0].responseGroupId = nil; conversation.turns[0].promptGroupId = nil; conversation.turns[0].promptVersionId = nil
        XCTAssertEqual(ConversationVersions.versions(conversation, turn: conversation.turns[0]).map(\.turnID), ["t3"])
    }
    func testPromptVersionIndexUsesIdentityWhenRepresentativeIsAnotherRetry() throws {
        var conversation = try fixtureConversation(); conversation.branchVisit = 0
        let turn = conversation.turns[0]
        let versions = ConversationVersions.versions(conversation, turn: turn, prompt: true)
        XCTAssertEqual(versions.map(\.turnID), ["t1", "t2"])
        XCTAssertEqual(ConversationVersions.selectedIndex(versions, turn: turn, prompt: true), 1)
    }
    func testReversedRatingResponsesOnlyChangeTheirRequestedIdentity() {
        let a = ArtifactIndex.identity(["a", "ta"]), b = ArtifactIndex.identity(["b", "tb"])
        var current = ReplyFeedbackProjection.merging([a: .up, b: .down], into: [:], conversationID: "b", turnID: "tb")
        current = ReplyFeedbackProjection.merging([a: .up], into: current, conversationID: "a", turnID: "ta")
        XCTAssertEqual(current, [a: .up, b: .down])
        current = ReplyFeedbackProjection.merging([:], into: current, conversationID: "a", turnID: "ta")
        XCTAssertEqual(current, [b: .down])
    }
    func testLateMutationResponsePreservesNewerStreamedTurnWithoutChangingVersionMembership() throws {
        var initial = try fixtureConversation(); initial.turns[0].status = "inProgress"
        var current = initial
        current.turns[0].items = [try JSONValue.object(["id": .string("streamed"), "type": .string("agentMessage"), "text": .string("new token after RPC snapshot")]).decode(TranscriptItem.self)]
        var tracker = StreamMutationTracker(); let started = tracker.revision
        tracker.record(.object(["t": .string("event"), "event": .object(["type": .string("conversation-turn"), "conversationId": .string("c1"), "turn": .object(["id": .string("t3")])])]), snapshot: nil)
        let merged = tracker.reconcile(initial, current: current, since: started)
        XCTAssertEqual(merged.turns.first?.items.first?.text, "new token after RPC snapshot")
        XCTAssertEqual(merged.savedBranches, initial.savedBranches)
        var switched = initial; switched.turns = try XCTUnwrap(initial.savedBranches?.first?["turns"]).decode([Turn].self)
        XCTAssertEqual(tracker.reconcile(switched, current: current, since: started).turns.map(\.id), ["t1"])
        // An event from before the request must not override a later authoritative result.
        XCTAssertEqual(tracker.reconcile(initial, current: current, since: tracker.revision), initial)
        var newerBranch = current; newerBranch.branchVisit = 6; newerBranch.activeBranchId = "later-branch"
        XCTAssertEqual(tracker.reconcile(initial, current: newerBranch, since: started), newerBranch)
        current.slim = true
        XCTAssertEqual(tracker.reconcile(initial, current: current, since: started).slim, true)
        tracker.reset(); XCTAssertEqual(tracker.reconcile(initial, current: current, since: started), initial)
    }
    func testBinarySnapshotChecksBase64DigestAndDeclaredSize() throws {
        let file = try fileFixture()
        XCTAssertEqual(try GeneratedFileSafety.decode("YWJj", file: file), Data("abc".utf8))
        for invalid in ["!!!!", "YWJj\n", "YWJk"] { XCTAssertThrowsError(try GeneratedFileSafety.decode(invalid, file: file)) }
        XCTAssertThrowsError(try GeneratedFileSafety.decode("YWJj", file: fileFixture(size: 4)))
        XCTAssertThrowsError(try GeneratedFileSafety.decode("YWJj", file: fileFixture(state: "deleted")))
        XCTAssertThrowsError(try GeneratedFileSafety.decode("YWJj", file: fileFixture(digest: String(repeating: "A", count: 64))))
    }
    func testBinaryNamesCannotEscapeTemporaryFolderAndActiveContentIsNotQuickLooked() throws {
        XCTAssertEqual(GeneratedFileSafety.filename("../../secret.pdf"), "secret.pdf")
        XCTAssertEqual(GeneratedFileSafety.filename("C:\\temp\\report.xlsx"), "report.xlsx")
        XCTAssertEqual(GeneratedFileSafety.filename(".."), "generated-file")
        XCTAssertEqual(GeneratedFileSafety.filename("a\u{0000}b.pdf"), "ab.pdf")
        for name in ["x.html", "x.svg", "x.js", "x.app", "x.sh"] { XCTAssertFalse(try fileFixture(name: name).quickLookAllowed) }
        XCTAssertTrue(try fileFixture().quickLookAllowed)
    }
    func testLibraryUsesLatestBinaryAndDeletedStateRatherThanOlderTextSnapshot() throws {
        var conversation = try fixtureConversation()
        var ready = try JSONValue.encode(fileFixture()).object!
        let readyItem = try JSONValue.object(["id": .string("ready"), "type": .string("commandExecution"), "generatedFiles": .array([.object(ready)])]).decode(TranscriptItem.self)
        conversation.turns[0].items = [readyItem]
        XCTAssertEqual(ArtifactIndex.latestGeneratedFiles(conversation).first?.blob, true)
        ready["state"] = .string("deleted")
        let deleted = try JSONValue.object(["id": .string("deleted"), "type": .string("commandExecution"), "generatedFiles": .array([.object(ready)])]).decode(TranscriptItem.self)
        conversation.turns[0].items.append(deleted)
        XCTAssertEqual(ArtifactIndex.latestGeneratedFiles(conversation).count, 1)
        XCTAssertEqual(ArtifactIndex.latestGeneratedFiles(conversation).first?.state, "deleted")
        XCTAssertTrue(ArtifactIndex.latestGeneratedFiles(conversation).filter(\.isReady).isEmpty)
    }
    func testMismatchedMimeNeverGetsQuickLookPreview() throws {
        var value = try JSONValue.encode(fileFixture()).object!
        value["mime"] = .string("text/html")
        XCTAssertFalse(try JSONValue.object(value).decode(GeneratedFile.self).quickLookAllowed)
        value["mime"] = .string("application/pdf; charset=binary")
        XCTAssertTrue(try JSONValue.object(value).decode(GeneratedFile.self).quickLookAllowed)
    }
    func testDeletionProjectionPreservesProjectConversationsButDropsDeletedConversationAndRatings() throws {
        var conversation = try fixtureConversation(); conversation.projectId = "project1"
        let state = try JSONValue.object(["settings": .object([:]), "conversations": .array([try .encode(conversation)]),
            "projects": .array([.object(["id": .string("project1"), "name": .string("Project"), "description": .string(""), "instructions": .string(""), "createdAt": .number(0)])]),
            "artifactLibrary": .object([:]), "engine": .object([:]), "approvals": .array([]),
            "replyFeedback": .object([ArtifactIndex.identity(["c1", "t3"]): .string("up")])]).decode(Snapshot.self)
        let afterProject = DeletionProjection.apply(state, conversations: [], projects: ["project1"])
        XCTAssertTrue(afterProject.projects.isEmpty); XCTAssertEqual(afterProject.conversations.count, 1)
        XCTAssertNil(afterProject.conversations.first?.projectId)
        XCTAssertEqual(afterProject.replyFeedback?.count, 1)
        let afterConversation = DeletionProjection.apply(state, conversations: ["c1"], projects: [])
        XCTAssertTrue(afterConversation.conversations.isEmpty); XCTAssertTrue(afterConversation.replyFeedback?.isEmpty == true)
        XCTAssertEqual(afterConversation.projects.count, 1)
        XCTAssertEqual(DeletionProjection.apply(state, conversations: ["c1"], projects: []), afterConversation)
    }
    func testGeneratedFileRPCUsesDigestNeverPathAndValidatesReturnedBytes() async throws {
        let transport = FoundationsTransport(responses: [.string("YWJj")]), remote = try makeRemote(transport)
        let data = try await remote.generatedFileData(fileFixture()); XCTAssertEqual(data, Data("abc".utf8))
        let requests = await transport.requests; let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url?.path, "/api/v1/claudex/web/rpc/readGeneratedFile")
        let payload = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody))
        XCTAssertEqual(payload, .object(["args": .array([.string(UploadDigest.sha256(Data("abc".utf8)))])]))
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin")); XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
    }
    func testInvalidBlobMetadataFailsBeforeNetwork() async throws {
        let transport = FoundationsTransport(responses: []), remote = try makeRemote(transport)
        for file in [try fileFixture(digest: "../../path"), try fileFixture(size: GeneratedFileSafety.maximumBytes + 1), try fileFixture(state: "unavailable")] {
            do { _ = try await remote.generatedFileData(file); XCTFail("Expected validation failure") } catch {}
        }
        let requests = await transport.requests; XCTAssertTrue(requests.isEmpty)
    }
    func testReplyAndDeletionRPCsMatchCurrentPositionalContracts() async throws {
        let response = try JSONDecoder().decode(JSONValue.self, from: Data(conversationFixture.utf8))
        let ratings: JSONValue = .object(["[\"c1\",\"t3\"]": .string("up")])
        let transport = FoundationsTransport(responses: [response, response, response, response, ratings, .object([:]), .null, .null]), remote = try makeRemote(transport)
        _ = try await remote.editPrompt(conversationID: "c1", turnID: "t3", text: "edit", providerID: "p", model: "m")
        _ = try await remote.retryResponse(conversationID: "c1", turnID: "t3", providerID: "p", model: "m")
        _ = try await remote.selectVersion(conversationID: "c1", turnID: "t3", versionTurnID: "t1", prompt: false)
        _ = try await remote.selectVersion(conversationID: "c1", turnID: "t3", versionTurnID: "t2", prompt: true)
        let rating = try await remote.setReplyFeedback(conversationID: "c1", turnID: "t3", rating: .up)
        XCTAssertEqual(rating[ArtifactIndex.identity(["c1", "t3"])], .up)
        _ = try await remote.setReplyFeedback(conversationID: "c1", turnID: "t3", rating: nil)
        try await remote.deleteConversation("c1"); try await remote.deleteProject("project1")
        let expected: [(String, [JSONValue])] = [
            ("editPrompt", [.string("c1"), .string("t3"), .string("edit"), .string("p"), .string("m")]),
            ("retryResponse", [.string("c1"), .string("t3"), .string("p"), .string("m")]),
            ("selectReplyVersion", [.string("c1"), .string("t3"), .string("t1")]),
            ("selectPromptVersion", [.string("c1"), .string("t3"), .string("t2")]),
            ("setReplyFeedback", [.string("c1"), .string("t3"), .string("up")]),
            ("setReplyFeedback", [.string("c1"), .string("t3"), .null]),
            ("deleteConversation", [.string("c1")]), ("deleteProject", [.string("project1")])]
        let requests = await transport.requests
        for (request, expected) in zip(requests, expected) {
            XCTAssertEqual(request.url?.lastPathComponent, expected.0)
            let value = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody))
            XCTAssertEqual(value, .object(["args": .array(expected.1)]))
        }
        XCTAssertEqual(requests.count, expected.count)
    }
}
private actor FoundationsSession: SessionProvider {
    func accessToken() async throws -> String { "fixture-token" }
    func eventsTicket(tabID: String) async throws -> String { "fixture-ticket" }
    func signOut() async throws {}
}
private actor FoundationsTransport: HTTPTransport {
    var requests: [URLRequest] = []
    var responses: [JSONValue]
    init(responses: [JSONValue]) { self.responses = responses }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        requests.append(request)
        guard !responses.isEmpty else { throw ServiceError.invalidResponse }
        return (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": responses.removeFirst()])), 200)
    }
}
private func makeRemote(_ transport: FoundationsTransport) throws -> RemoteClaudexService {
    RemoteClaudexService(rpc: try RPCClient(baseURL: URL(string: "https://fixture.test")!, tabID: "fixture-tab", session: FoundationsSession(), transport: transport))
}
