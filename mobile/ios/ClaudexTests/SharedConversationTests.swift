import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

private func bridgeFixture() throws -> Conversation {
    try JSONDecoder().decode(Conversation.self, from: Data(#"{"id":"c","title":"Shared fixture","mode":"chat","providerId":"p","model":"m","pinned":false,"archived":false,"createdAt":0,"updatedAt":1,"workflow":{"stage":"review"},"environment":{"kind":"ssh","hostId":"h"},"future":null,"turns":[{"id":"t","prompt":"Hello","attachments":[{"id":"a","name":"a.png","path":"/owned/a","kind":"image","size":5,"newImageMetadata":{"width":10}}],"status":"completed","createdAt":1,"outputTokenBase":12,"research":{"phase":"done"},"items":[{"id":"i","type":"agentMessage","text":"Hello reply\n```swift\nlet x = 1\n```","generatedFiles":[{"id":"f","name":"f.txt","path":"/owned/f.txt","language":"text","state":"ready","content":"trusted bytes","digest":"abc","operation":"update","capturedAt":17,"previousPath":"/owned/old.txt"}],"futureItem":{"x":true}}]}]}"#.utf8))
}
private func bridgeSnapshot(_ c: Conversation) throws -> Snapshot {
    try JSONValue.object(["settings": .object([:]), "conversations": .array([try JSONValue.encode(c)]), "projects": .array([]), "artifactLibrary": .object([:]), "engine": .object([:]), "approvals": .array([])]).decode(Snapshot.self)
}
private func action(_ type: String = "retryResponse", _ payload: JSONValue = .object(["conversationId": .string("c"), "turnId": .string("t")]), session: String = "lease", request: String = "r") throws -> SharedConversationAction {
    let event = try SharedConversationProtocol.decode(.object(["version": .number(1), "sessionId": .string(session), "requestId": .string(request), "type": .string(type), "payload": payload]))
    guard case .action(let value) = event else { throw SharedConversationProtocolError.malformed }; return value
}
final class SharedConversationTests: XCTestCase {
    func testUnknownCanonicalConversationTurnAttachmentAndItemFieldsSurvive() throws {
        var c = try bridgeFixture(); c.title = "Edited"; c.turns[0].status = "inProgress"
        let wire = try JSONValue.encode(c)
        XCTAssertEqual(wire["workflow"]["stage"].string, "review")
        XCTAssertEqual(wire["environment"]["hostId"].string, "h")
        XCTAssertTrue(wire.object?.keys.contains("future") == true)
        let turn = try XCTUnwrap(wire["turns"].array?.first)
        XCTAssertEqual(turn["outputTokenBase"].integer, 12)
        XCTAssertEqual(turn["research"]["phase"].string, "done")
        XCTAssertEqual(turn["attachments"].array?.first?["newImageMetadata"]["width"].integer, 10)
        XCTAssertEqual(turn["items"].array?.first?["futureItem"]["x"].bool, true)
        XCTAssertEqual(try wire.decode(Conversation.self), c)
    }
    func testGeneratedFileUnknownFieldsSurviveTypedRoundTrip() throws {
        let file = try XCTUnwrap(try bridgeFixture().turns.first?.items.first?.generatedFiles.first)
        let wire = try JSONValue.encode(file)
        XCTAssertEqual(wire["operation"].string, "update")
        XCTAssertEqual(wire["capturedAt"].integer, 17)
        XCTAssertEqual(wire["previousPath"].string, "/owned/old.txt")
    }
    func testTurnEventPreservesUnknownConversationMetadataAndNewTurnFields() throws {
        let c = try bridgeFixture(); var reducer = StreamReducer(snapshot: try bridgeSnapshot(c))
        var turn = try JSONValue.encode(c.turns[0]).object!; turn["research"] = .object(["phase": .string("new")])
        let frame: JSONValue = .object(["t": .string("event"), "seq": .number(1), "event": .object(["type": .string("conversation-turn"), "conversationId": .string("c"), "conversation": .object(["updatedAt": .number(2), "futureConversation": .bool(true)]), "turn": .object(turn)])])
        XCTAssertEqual(try reducer.apply(frame), .changed)
        let wire = try JSONValue.encode(XCTUnwrap(reducer.snapshot?.conversations.first))
        XCTAssertEqual(wire["workflow"]["stage"].string, "review")
        XCTAssertEqual(wire["futureConversation"].bool, true)
        XCTAssertEqual(wire["turns"].array?.first?["research"]["phase"].string, "new")
    }
    func testUnknownActionAndBroadRPCRejected() throws {
        for type in ["rpc", "readFile", "runCode", "signOut", "approve", "getToken"] { XCTAssertThrowsError(try action(type)) }
    }
    func testBatchDownloadRejectsEmptyOversizedDuplicateAndCrossConversationIdentities() throws {
        let file: JSONValue = .object(["conversationId": .string("c"), "artifactId": .string("generated:f:abc")])
        let payload: JSONValue = .object(["conversationId": .string("c"), "files": .array([file])])
        XCTAssertEqual(try action("downloadArtifacts", payload).type, .downloadArtifacts)
        let invalid: [[JSONValue]] = [[], [file, file], Array(repeating: file, count: 33), [.object(["conversationId": .string("other"), "artifactId": .string("generated:f:abc")])]]
        for files in invalid {
            XCTAssertThrowsError(try action("downloadArtifacts", .object(["conversationId": .string("c"), "files": .array(files)])))
        }
    }
    func testBatchSaveCountsOnlyCompletedExportsAndStopsAtUserCancel() throws {
        var batch = try SharedConversationBatchProgress(total: 3)
        XCTAssertTrue(batch.complete(index: 0, didSave: true))
        XCTAssertTrue(batch.complete(index: 1, didSave: false))
        XCTAssertTrue(batch.finished); XCTAssertEqual(batch.saved, 1); XCTAssertTrue(batch.cancelled)
        XCTAssertFalse(batch.complete(index: 2, didSave: true))
        XCTAssertEqual(batch.result["saved"].integer, 1); XCTAssertEqual(batch.result["cancelled"].bool, true)
    }
    func testBatchRejectsDuplicateAndReorderedCallbacks() throws {
        var batch = try SharedConversationBatchProgress(total: 2)
        XCTAssertFalse(batch.complete(index: 1, didSave: true)); XCTAssertEqual(batch.saved, 0)
        XCTAssertTrue(batch.complete(index: 0, didSave: true))
        XCTAssertFalse(batch.complete(index: 0, didSave: true))
        XCTAssertTrue(batch.complete(index: 1, didSave: true)); XCTAssertTrue(batch.finished)
        XCTAssertEqual(batch.saved, 2); XCTAssertFalse(batch.cancelled)
    }
    func testWrongVersionMalformedPayloadAndExtraFieldsRejected() throws {
        XCTAssertThrowsError(try SharedConversationProtocol.decode(.object(["version": .number(2), "type": .string("ready")])))
        XCTAssertThrowsError(try action("editPrompt", .object(["conversationId": .string("c"), "turnId": .string("t"), "text": .string(" ")])))
        XCTAssertThrowsError(try action("retryResponse", .object(["conversationId": .string("c"), "turnId": .string("t"), "providerId": .string("attacker") ])))
        XCTAssertThrowsError(try action("replyFeedback", .object(["conversationId": .string("c"), "turnId": .string("t"), "rating": .string("surprise")])))
    }
    func testTextAndEnvelopeSizeAreBounded() throws {
        XCTAssertThrowsError(try action("copyText", .object(["text": .string(String(repeating: "a", count: 1_000_001))])))
        XCTAssertThrowsError(try SharedConversationProtocol.decode(Data(repeating: 32, count: 1_100_001)))
    }
    func testSafeLinksRejectPrivilegedSchemesCredentialsAndMissingHosts() {
        for link in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "claudex-conversation://bundle/index.html", "https://u:p@example.test", "https:relative"] { XCTAssertNil(SharedConversationProtocol.safeLink(link), link) }
        XCTAssertNotNil(SharedConversationProtocol.safeLink("https://example.test/path#anchor"))
    }
    func testNoRenderBeforeReadyAndOnlyOneInFlight() {
        var lease = SharedConversationLease(sessionID: "lease")
        lease.enqueue(.object(["value": .number(1)])); XCTAssertNil(lease.next(now: 0))
        lease.markReady(); let sent = lease.next(now: 0)
        XCTAssertEqual(sent?["sessionId"].string, "lease"); XCTAssertEqual(sent?["revision"].integer, 1)
        lease.enqueue(.object(["value": .number(2)])); XCTAssertNil(lease.next(now: 1))
    }
    func testCoalescingAndMinimumRenderInterval() {
        var lease = SharedConversationLease(sessionID: "lease"); lease.markReady()
        lease.enqueue(.object(["value": .number(1)])); _ = lease.next(now: 0)
        lease.enqueue(.object(["value": .number(2)])); lease.enqueue(.object(["value": .number(3)]))
        XCTAssertTrue(lease.acknowledge(sessionID: "lease", revision: 1))
        XCTAssertNil(lease.next(now: 0.04)); XCTAssertEqual(lease.next(now: 0.081)?["value"].integer, 3)
    }
    func testStaleAndOutOfOrderAckCannotUnlockNewRender() {
        var lease = SharedConversationLease(sessionID: "lease"); lease.markReady(); lease.enqueue(.object([:])); _ = lease.next(now: 0)
        XCTAssertFalse(lease.acknowledge(sessionID: "old", revision: 1)); XCTAssertFalse(lease.acknowledge(sessionID: "lease", revision: 2))
        XCTAssertEqual(lease.inFlight, 1)
    }
    func testLeaseRotationDropsStateAndRequestsAndRequiresNewHandshake() throws {
        var lease = SharedConversationLease(sessionID: "lease"); lease.markReady(); lease.enqueue(.object([:]))
        try lease.begin(action(), now: 0); lease.rotate(sessionID: "new")
        XCTAssertFalse(lease.ready); XCTAssertNil(lease.pending); XCTAssertNil(lease.inFlight); XCTAssertTrue(lease.actions.isEmpty)
        XCTAssertThrowsError(try lease.begin(action(), now: 2))
    }
    func testDuplicateCompletedRequestNeverReplays() throws {
        var lease = SharedConversationLease(sessionID: "lease"); lease.markReady()
        let request = try action(); try lease.begin(request, now: 0); XCTAssertNotNil(lease.finish("r"))
        XCTAssertThrowsError(try lease.begin(request, now: 10))
    }
    func testPendingRequestBackpressureAndCancel() throws {
        var lease = SharedConversationLease(sessionID: "lease"); lease.markReady()
        for index in 0..<16 { try lease.begin(action(request: "r\(index)"), now: 0) }
        XCTAssertThrowsError(try lease.begin(action(request: "more"), now: 0))
        XCTAssertNotNil(lease.finish("r0")); try lease.begin(action(request: "more"), now: 0)
    }
    func testCurrentIdentityResolutionRejectsArbitraryDigestOrPath() throws {
        let c = try bridgeFixture()
        let valid: JSONValue = .object(["artifactId": .string("generated:f:abc"), "sourcePath": .string("/owned/f.txt"), "sourceDigest": .string("abc")])
        XCTAssertEqual(SharedConversationResolver.file(valid, conversation: c)?.content, "trusted bytes")
        XCTAssertNil(SharedConversationResolver.file(.object(["artifactId": .string("generated:f:abc"), "sourcePath": .string("/etc/passwd")]), conversation: c))
        XCTAssertNil(SharedConversationResolver.file(.object(["artifactId": .string("generated:f:other")]), conversation: c))
        XCTAssertNil(SharedConversationResolver.attachment("other", conversation: c))
    }
    func testFenceIdentityResolvesOnlyCurrentCanonicalText() throws {
        let c = try bridgeFixture()
        let file = SharedConversationResolver.file(.object(["artifactId": .string("fence:i:0")]), conversation: c)
        XCTAssertEqual(file?.content, "let x = 1\n")
        XCTAssertNil(SharedConversationResolver.file(.object(["artifactId": .string("fence:i:1")]), conversation: c))
    }
    func testPlanAndReasoningSummaryFenceIdentitiesResolveCanonicalSources() throws {
        var c = try bridgeFixture()
        c.turns[0].items = [try JSONValue.object(["id": .string("plan"), "type": .string("plan"), "text": .string("```txt\nplan source\n```")]).decode(TranscriptItem.self),
                           try JSONValue.object(["id": .string("reason"), "type": .string("reasoning"), "summary": .array([.string("Summary"), .string("```swift\nlet summary = 1\n```")])]).decode(TranscriptItem.self)]
        XCTAssertEqual(SharedConversationResolver.file(.object(["artifactId": .string("fence:plan:0")]), conversation: c)?.content, "plan source\n")
        XCTAssertEqual(SharedConversationResolver.file(.object(["artifactId": .string("fence-summary:reason:0")]), conversation: c)?.content, "let summary = 1\n")
        XCTAssertNil(SharedConversationResolver.file(.object(["artifactId": .string("fence-summary:other:0")]), conversation: c))
    }
    func testPreparedExportDescriptorMustStillExistAfterMaterialization() throws {
        var c = try bridgeFixture(); let file = try XCTUnwrap(c.turns.first?.items.first?.generatedFiles.first)
        XCTAssertTrue(SharedConversationResolver.containsFile(file, conversation: c))
        c.turns[0].items = []
        XCTAssertFalse(SharedConversationResolver.containsFile(file, conversation: c))
    }
    func testCopyAndQuoteCannotInjectUnrelatedText() throws {
        let c = try bridgeFixture()
        XCTAssertTrue(SharedConversationResolver.containsText("let x = 1", conversation: c))
        XCTAssertFalse(SharedConversationResolver.containsText("unrelated clipboard payload", conversation: c))
    }
    func testQuoteFormatsSelectedTextOnceAndAcceptsRenderedMarkdown() throws {
        var c = try bridgeFixture()
        XCTAssertEqual(SharedConversationResolver.quoteForComposer("Hello", conversation: c), "> Hello\n\n")
        c.turns[0].items = [try JSONValue.object(["id": .string("rich"), "type": .string("agentMessage"), "text": .string("**Hello** world")]).decode(TranscriptItem.self)]
        XCTAssertEqual(SharedConversationResolver.quoteForComposer("Hello world", conversation: c), "> Hello world\n\n")
        XCTAssertNil(SharedConversationResolver.quoteForComposer("Injected unrelated text", conversation: c))
    }
    func testCanonicalLinksNormalizeOriginSlashUnicodeAndMarkdownClosingDelimiter() {
        XCTAssertTrue(SharedConversationResolver.containsLink("https://example.com/", source: "[site](https://example.com)"))
        XCTAssertTrue(SharedConversationResolver.containsLink("https://example.com/%E4%BD%A0%E5%A5%BD", source: "[unicode](https://example.com/你好)"))
        XCTAssertTrue(SharedConversationResolver.containsLink("https://example.com/a?x=1&y=2", source: "https://example.com/a?x=1&amp;y=2"))
        XCTAssertFalse(SharedConversationResolver.containsLink("https://evil.example/", source: "[site](https://example.com)"))
    }
    func testVersionActionsAreChatOnlyEvenForKnownVersionIDs() throws {
        let c = try bridgeFixture()
        let payload: JSONValue = .object(["turnId": .string("t"), "versionId": .string("t"), "prompt": .bool(false)])
        XCTAssertTrue(SharedConversationResolver.canSelectVersion(payload, conversation: c))
        for mode in ["code", "cowork"] {
            var wire = try JSONValue.encode(c).object!; wire["mode"] = .string(mode)
            XCTAssertFalse(SharedConversationResolver.canSelectVersion(payload, conversation: try JSONValue.object(wire).decode(Conversation.self)))
        }
    }
    func testMutationsDisabledDuringStreamingSendingAndSlim() throws {
        var c = try bridgeFixture(); XCTAssertTrue(SharedConversationResolver.canMutate(c, sending: false))
        XCTAssertFalse(SharedConversationResolver.canMutate(c, sending: true))
        c.slim = true; XCTAssertFalse(SharedConversationResolver.canMutate(c, sending: false))
        c.slim = nil; c.turns[0].status = "inProgress"; XCTAssertFalse(SharedConversationResolver.canMutate(c, sending: false))
    }
    func testLateHTTPRefreshCannotOverwriteNewerStreamTurnOrMetadata() throws {
        var c = try bridgeFixture(); let old = try bridgeSnapshot(c)
        var tracker = SnapshotRefreshTracker(); let start = tracker.revision
        c.title = "New streamed title"; c.extensionFields["workflow"] = .object(["stage": .string("done")])
        let current = try bridgeSnapshot(c)
        tracker.record(.object(["t": .string("event"), "event": .object(["conversationId": .string("c")])]), snapshot: current)
        XCTAssertEqual(tracker.reconcile(old, current: current, since: start).conversations, [c])
        XCTAssertEqual(tracker.reconcile(old, current: current, since: tracker.revision), old)
    }
    func testLateMutationPreservesPatchedUnknownMetadataWithoutErasingBranchResponse() throws {
        let old = try bridgeFixture(); var current = old
        current.extensionFields["workflow"] = .object(["stage": .string("new")]); current.title = "New title"
        var tracker = StreamMutationTracker(); let start = tracker.revision
        tracker.record(.object(["t": .string("event"), "event": .object(["type": .string("conversation-turn"), "conversationId": .string("c"), "turn": .object(["id": .string("t")]), "conversation": .object(["workflow": .object(["stage": .string("new")]), "title": .string("New title")])])]), snapshot: nil)
        var response = old; response.activeBranchId = "mutation-branch"
        let result = tracker.reconcile(response, current: current, since: start)
        XCTAssertEqual(result.extensionFields["workflow"]?["stage"].string, "new")
        XCTAssertEqual(result.title, "New title"); XCTAssertEqual(result.activeBranchId, "mutation-branch")
    }
    func testEmptyConversationEventStillPreservesNewMetadataAgainstLateMutation() throws {
        var old = try bridgeFixture(); old.turns = []; var current = old; current.title = "Fresh metadata"
        var tracker = StreamMutationTracker()
        tracker.record(.object(["t": .string("event"), "event": .object(["type": .string("conversation"), "conversation": .object(["id": .string("c")])])]), snapshot: try bridgeSnapshot(current))
        XCTAssertEqual(tracker.reconcile(old, current: current, since: 0).title, "Fresh metadata")
    }
    func testRefreshPreservesNewerSettingsApprovalAndLocalMutationResults() throws {
        let old = try bridgeSnapshot(bridgeFixture()); var current = old
        current.settings = try JSONValue.object(["name": .string("new setting")]).decode(Settings.self)
        current.approvals = [.object(["id": .string("pending")])]
        current.replyFeedback = ["rating": .up]
        current.conversations[0].title = "Edited locally"
        var tracker = SnapshotRefreshTracker()
        tracker.record(.object(["t": .string("event"), "event": .object(["type": .string("settings")])]), snapshot: current)
        tracker.record(.object(["t": .string("event"), "event": .object(["type": .string("approval")])]), snapshot: current)
        tracker.recordField("replyFeedback"); tracker.recordConversation("c")
        XCTAssertEqual(tracker.reconcile(old, current: current, since: 0), current)
    }
    func testOlderHTTPConversationTimestampCannotReplaceNewerNativeState() throws {
        let old = try bridgeSnapshot(bridgeFixture()); var current = old
        current.conversations[0].updatedAt = 100; current.conversations[0].title = "Newer HTTP result"
        XCTAssertEqual(SnapshotRefreshTracker().reconcile(old, current: current, since: 0).conversations, current.conversations)
    }
    func testSequencedSnapshotWinsOverOlderUnsequencedRefresh() throws {
        let old = try bridgeSnapshot(bridgeFixture()); var current = old; current.conversations = []
        var tracker = SnapshotRefreshTracker(); tracker.record(.object(["t": .string("snapshot")]), snapshot: current)
        XCTAssertEqual(tracker.reconcile(old, current: current, since: 0), current)
    }
    func testResultCarriesExactLeaseAndRequestAndCancellation() throws {
        let reply = SharedConversationProtocol.result(for: try action(), ok: false, error: "Cancelled", cancelled: true)
        XCTAssertEqual(reply["sessionId"].string, "lease"); XCTAssertEqual(reply["requestId"].string, "r")
        XCTAssertEqual(reply["ok"].bool, false); XCTAssertEqual(reply["cancelled"].bool, true)
    }
}
