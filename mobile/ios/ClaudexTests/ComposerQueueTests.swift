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

func queueConversation(_ id: String = "synthetic-a", mode: ChatMode = .code, running: Bool = true, delivered: String? = nil) throws -> Conversation {
    let item: JSONValue = delivered.map { .object(["id": .string("i"), "type": .string("userMessage"), "steered": .bool(true), "clientId": .string($0)]) } ?? .null
    return try JSONValue.object([
        "id": .string(id), "title": .string("SYNTHETIC queue"), "mode": .string(mode.rawValue),
        "providerId": .string("synthetic-provider"), "model": .string("synthetic-model"), "pinned": .bool(false), "archived": .bool(false), "createdAt": .number(1), "updatedAt": .number(1),
        "turns": .array([.object(["id": .string("t"), "prompt": .string("SYNTHETIC"), "attachments": .array([]), "items": .array(delivered == nil ? [] : [item]), "status": .string(running ? "inProgress" : "completed"), "createdAt": .number(1)])])
    ]).decode(Conversation.self)
}
final class ComposerQueueTests: XCTestCase {
    private func entry(_ c: Conversation, text: String = "SYNTHETIC queued", state: QueuedComposerMessage.State = .queued, messageID: String? = nil) -> QueuedComposerMessage {
        QueuedComposerMessage(text: text, attachments: [], conversation: c, webSearch: false, state: state, messageID: messageID)
    }
    func testSteeredWaitsUntilMatchingCanonicalClientIDAppears() throws {
        let c = try queueConversation(); var queue = ComposerQueue()
        let pending = entry(c, state: .steered, messageID: "m1"); queue.add(pending, conversationID: c.id)
        queue.reconcile(c); XCTAssertEqual(queue.entries(c.id), [pending]); XCTAssertNil(queue.beginNext(c))
        queue.reconcile(try queueConversation(delivered: "other")); XCTAssertEqual(queue.entries(c.id), [pending])
        queue.reconcile(try queueConversation(delivered: "m1")); XCTAssertTrue(queue.entries(c.id).isEmpty)
    }
    func testFullIdleTurnRequeuesUndeliveredSteerExactlyOnce() throws {
        let c = try queueConversation(); var queue = ComposerQueue()
        queue.add(entry(c, state: .steered, messageID: "m1"), conversationID: c.id)
        let idle = try queueConversation(running: false)
        let lease = try XCTUnwrap(queue.beginNext(idle)); XCTAssertEqual(lease.entry.state, .queued)
        XCTAssertNil(queue.beginNext(idle)); XCTAssertTrue(queue.complete(lease)); XCTAssertTrue(queue.entries(c.id).isEmpty)
    }
    func testSlimTranscriptCannotProveUndeliveredOrAuthorizeSend() throws {
        let c = try queueConversation(); var queue = ComposerQueue()
        queue.add(entry(c, state: .steered, messageID: "m1"), conversationID: c.id)
        var slim = try queueConversation(running: false); slim.slim = true
        queue.reconcile(slim); XCTAssertEqual(queue.entries(c.id)[0].state, .steered); XCTAssertNil(queue.beginNext(slim))
        var definiteNull = ComposerQueue(); definiteNull.add(entry(c), conversationID: c.id)
        XCTAssertNil(definiteNull.beginNext(slim))
    }
    func testFIFOFailureSurvivesEventsWithoutAutomaticReplay() throws {
        let c = try queueConversation(running: false); var queue = ComposerQueue()
        let first = entry(c, text: "first"), second = entry(c, text: "second")
        queue.add(first, conversationID: c.id); queue.add(second, conversationID: c.id)
        let lease = try XCTUnwrap(queue.beginNext(c)); XCTAssertEqual(lease.entry.id, first.id)
        queue.complete(lease, error: "SYNTHETIC unconfirmed mutation")
        for _ in 0..<5 { queue.reconcile(c); XCTAssertNil(queue.beginNext(c)) }
        XCTAssertEqual(queue.entries(c.id).map(\.text), ["first", "second"])
        XCTAssertTrue(queue.remove(first.id, conversationID: c.id))
        XCTAssertEqual(queue.beginNext(c)?.entry.id, second.id)
    }
    func testAccountResetRejectsOldSuccessAndFailureLeases() throws {
        let c = try queueConversation(running: false); var queue = ComposerQueue()
        queue.add(entry(c), conversationID: c.id); let old = try XCTUnwrap(queue.beginNext(c))
        queue.reset(); let next = entry(c, text: "new account"); queue.add(next, conversationID: c.id)
        let fresh = try XCTUnwrap(queue.beginNext(c))
        XCTAssertFalse(queue.complete(old)); XCTAssertFalse(queue.complete(old, error: "stale")); XCTAssertFalse(queue.completeSteer(old, messageID: "old"))
        XCTAssertEqual(queue.entries(c.id), [next]); XCTAssertTrue(queue.complete(fresh))
    }
    func testBackgroundBeforeDispatchReleasesWithoutConsumingOrFailingDraft() throws {
        let c = try queueConversation(running: false); var queue = ComposerQueue()
        let message = entry(c); queue.add(message, conversationID: c.id)
        let pending = try XCTUnwrap(queue.beginNext(c))
        queue.releaseBeforeDispatch(pending)
        XCTAssertFalse(queue.isSending(c.id)); XCTAssertEqual(queue.entries(c.id), [message])
        XCTAssertFalse(queue.complete(pending))
        let resumed = try XCTUnwrap(queue.beginNext(c))
        XCTAssertEqual(resumed.entry.id, message.id); XCTAssertTrue(queue.complete(resumed))
    }
    func testConversationQueuesKeepTheirCapturedModeAndModel() throws {
        let a = try queueConversation(mode: .cowork, running: false), b = try queueConversation("synthetic-b", mode: .chat, running: false)
        var queue = ComposerQueue(); queue.add(entry(a), conversationID: a.id); queue.add(entry(b), conversationID: b.id)
        let la = try XCTUnwrap(queue.beginNext(a)), lb = try XCTUnwrap(queue.beginNext(b))
        XCTAssertEqual(la.entry.mode, .cowork); XCTAssertEqual(lb.entry.mode, .chat)
        let input = try JSONValue.encode(la.entry.input(conversationID: a.id))
        XCTAssertEqual(input["conversationId"].string, a.id); XCTAssertEqual(input["providerId"].string, a.providerId)
        XCTAssertEqual(input["model"].string, a.model); XCTAssertEqual(input["webSearch"].bool, false)
        queue.complete(la); XCTAssertEqual(queue.entries(b.id).count, 1)
    }
    func testExplicitSendNowNullBlocksAndSuccessTracksMessageID() throws {
        let c = try queueConversation(); var queue = ComposerQueue(); let message = entry(c)
        queue.add(message, conversationID: c.id)
        let attempt = try XCTUnwrap(queue.beginManualSteer(message.id, conversationID: c.id))
        XCTAssertFalse(queue.remove(message.id, conversationID: c.id))
        queue.complete(attempt, error: "Cannot take it now")
        XCTAssertNil(queue.beginNext(try queueConversation(running: false)))
        let explicit = try XCTUnwrap(queue.beginManualSteer(message.id, conversationID: c.id))
        XCTAssertTrue(queue.completeSteer(explicit, messageID: "m2")); XCTAssertNil(queue.entries(c.id)[0].error)
        XCTAssertEqual(queue.entries(c.id)[0].messageID, "m2"); XCTAssertNil(queue.beginNext(c))
    }
}

private struct SteerSession: SessionProvider {
    func accessToken() async throws -> String { "SYNTHETIC_NO_NETWORK" }
    func eventsTicket(tabID: String) async throws -> String { throw ServiceError.invalidResponse }
    func signOut() async throws {}
}
private actor SteerTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let body: Data
    let status: Int
    init(value: JSONValue, status: Int = 200) throws {
        self.status = status
        body = try JSONEncoder().encode(JSONValue.object(["ok": .bool(status == 200), "value": value, "error": .object(["message": .string("SYNTHETIC failure")])]))
    }
    func execute(_ request: URLRequest) async throws -> (Data, Int) { requests.append(request); return (body, status) }
}
final class SteerProtocolTests: XCTestCase {
    private func remote(_ wire: SteerTransport) throws -> RemoteClaudexService {
        RemoteClaudexService(rpc: try RPCClient(baseURL: URL(string: "https://synthetic.invalid")!, tabID: "synthetic-steer", session: SteerSession(), transport: wire))
    }
    func testNullUsesCanonicalThreeArgumentsAndIsNotAnError() async throws {
        let wire = try SteerTransport(value: .null), client = try remote(wire)
        let result = try await client.steerTurn("synthetic-a", text: "new instruction", attachmentIDs: ["file-1"])
        XCTAssertNil(result)
        let requests = await wire.requests; XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url?.path, "/api/v1/claudex/web/rpc/steerTurn")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)["args"], .array([.string("synthetic-a"), .string("new instruction"), .array([.string("file-1")])]))
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
    }
    func testSuccessKeepsCanonicalMessageAndConversationIdentity() async throws {
        let c = try queueConversation()
        let wire = try SteerTransport(value: .object(["messageId": .string("m1"), "conversation": try .encode(c)]))
        let result = try await remote(wire).steerTurn(c.id, text: "next", attachmentIDs: [])
        XCTAssertEqual(result?.messageId, "m1"); XCTAssertEqual(result?.conversation.id, c.id)
    }
    func testTransportFailureNeverBecomesNullOrRepeatsRequest() async throws {
        let wire = try SteerTransport(value: .null, status: 500)
        do { _ = try await remote(wire).steerTurn("synthetic-a", text: "next", attachmentIDs: []); XCTFail("Must keep failure") }
        catch { XCTAssertEqual(error as? ServiceError, .server("SYNTHETIC failure", nil)) }
        let requests = await wire.requests; XCTAssertEqual(requests.count, 1)
    }
    func testMismatchedConversationIsRejectedWithoutFallback() async throws {
        let wire = try SteerTransport(value: .object(["messageId": .string("m1"), "conversation": try .encode(queueConversation("other"))]))
        do { _ = try await remote(wire).steerTurn("synthetic-a", text: "next", attachmentIDs: []); XCTFail("Must bind response") }
        catch { XCTAssertEqual(error as? ServiceError, .invalidResponse) }
    }
}
