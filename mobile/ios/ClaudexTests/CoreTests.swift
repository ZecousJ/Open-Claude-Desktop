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

private let conversationJSON = """
{"id":"c1","title":"First","mode":"chat","providerId":"p1","model":"server-model","pinned":false,"archived":false,"createdAt":0,"updatedAt":1,"turns":[]}
"""
private func fixtureSnapshot() throws -> Snapshot {
    try JSONDecoder().decode(Snapshot.self, from: Data("""
    {"settings":{"name":"Test","providers":[],"activeProviderId":"p1","effort":"high","futureFlag":true},"conversations":[\(conversationJSON)],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{"state":"ready"},"approvals":[]}
    """.utf8))
}
final class CoreTests: XCTestCase {
    func testUnknownSettingsSurviveEffortUpdate() throws {
        let settings = try fixtureSnapshot().settings.replacingEffort("medium", mode: .chat)
        XCTAssertEqual(settings.raw["futureFlag"], .bool(true))
        XCTAssertEqual(settings.effort, "medium")
    }
    func testJSONRoundTripRetainsBooleanAndNumberTypes() throws {
        let value: JSONValue = .object(["b": .bool(true), "n": .number(1), "a": .array([.null, .string("中")])])
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)), value)
    }
    func testInsecureAndCredentialURLsRefused() {
        for address in ["http://service.test", "https://name:secret@service.test", "https://service.test/path", "https://service.test?x=1"] {
            XCTAssertThrowsError(try RPCClient(baseURL: URL(string: address)!, tabID: "test-tab", session: UnavailableNativeSession()))
        }
    }
    func testHelloDoesNotSendCredential() throws {
        let data = try JSONEncoder().encode(WireFrames.hello(tabID: "tab", lastSequence: 42))
        let string = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(string.contains("token")); XCTAssertTrue(string.contains("lastSeq"))
    }
    func testReplayDeduplicationAndGap() throws {
        var reducer = StreamReducer(snapshot: try fixtureSnapshot())
        _ = try reducer.apply(.object(["t": .string("snapshot"), "seq": .number(10), "snapshot": .encode(fixtureSnapshot())]))
        let event: JSONValue = .object(["t": .string("event"), "seq": .number(11), "event": .object(["type": .string("engine"), "engine": .object(["state": .string("ready")])])])
        XCTAssertEqual(try reducer.apply(event), .changed)
        XCTAssertEqual(try reducer.apply(event), .none)
        XCTAssertEqual(reducer.lastSequence, 11)
        XCTAssertEqual(try reducer.apply(.object(["t": .string("event"), "seq": .number(13), "event": .object(["type": .string("engine")])])), .resync)
        XCTAssertEqual(reducer.lastSequence, 11)
    }
    func testSignedOutClearsSensitiveSnapshot() throws {
        var reducer = StreamReducer(snapshot: try fixtureSnapshot())
        XCTAssertEqual(try reducer.apply(.object(["t": .string("event"), "seq": .number(1), "event": .object(["type": .string("signed-out"), "message": .string("Revoked")])])), .signedOut("Revoked"))
        XCTAssertNil(reducer.snapshot); XCTAssertNil(reducer.lastSequence)
    }
    func testTurnUpdateReplacesInsteadOfAppendingText() throws {
        var reducer = StreamReducer(snapshot: try fixtureSnapshot())
        let turn = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"id":"t1","prompt":"Hi","attachments":[],"items":[{"id":"i1","type":"agentMessage","text":"Hello"}],"status":"inProgress","createdAt":0}
        """.utf8))
        for seq in 1...2 {
            let event: JSONValue = .object(["t": .string("event"), "seq": .number(Double(seq)), "event": .object(["type": .string("conversation-turn"), "conversationId": .string("c1"), "turn": turn, "conversation": .object(["title": .string("Updated")])])])
            XCTAssertEqual(try reducer.apply(event), .changed)
        }
        XCTAssertEqual(reducer.snapshot?.conversations[0].turns.count, 1)
        XCTAssertEqual(reducer.snapshot?.conversations[0].title, "Updated")
    }
    func testUnresumedConnectionRequiresResync() throws {
        var reducer = StreamReducer(snapshot: try fixtureSnapshot())
        XCTAssertEqual(try reducer.apply(.object(["t": .string("ready"), "v": .number(1), "seq": .number(7), "resumed": .bool(false)])), .resync)
        XCTAssertTrue(reducer.needsResync)
    }
    func testInvalidSequenceAndProtocolFailClosed() {
        var reducer = StreamReducer()
        XCTAssertThrowsError(try reducer.apply(.object(["t": .string("ready"), "v": .number(99), "seq": .number(1)])))
        XCTAssertThrowsError(try reducer.apply(.object(["t": .string("event"), "seq": .number(-1)])))
    }
    func testReconnectBackoffAndTerminalCodes() {
        XCTAssertEqual(ReconnectPolicy.delay(attempt: 100), 30)
        XCTAssertFalse(ReconnectPolicy.shouldRetry(closeCode: 4008))
        XCTAssertTrue(ReconnectPolicy.shouldRetry(closeCode: 4503))
    }
    func testUnavailableAuthNeverProducesToken() async {
        do { _ = try await UnavailableNativeSession().accessToken(); XCTFail("Must fail closed") }
        catch { XCTAssertEqual(error as? ServiceError, .nativeAuthenticationUnavailable) }
    }
}
private actor TestSession: SessionProvider {
    func accessToken() async throws -> String { "test-only-token" }
    func eventsTicket(tabID: String) async throws -> String { "test-only-ticket" }
    func signOut() async throws {}
}
private actor CapturingTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let response: String
    let status: Int
    init(response: String, status: Int = 200) { self.response = response; self.status = status }
    func execute(_ request: URLRequest) async throws -> (Data, Int) { requests.append(request); return (Data(response.utf8), status) }
    func last() -> URLRequest? { requests.last }
}
final class RPCTests: XCTestCase {
    func testVerifiedRPCEnvelopeAndHeaders() async throws {
        let transport = CapturingTransport(response: "{\"ok\":true,\"value\":null}")
        let rpc = try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "tab-id", session: TestSession(), transport: transport)
        let _: JSONValue = try await rpc.call("interrupt", args: [.string("conversation-id")], as: JSONValue.self)
        let request = await transport.last()
        XCTAssertEqual(request?.url?.path, "/api/v1/claudex/web/rpc/interrupt")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer test-only-token")
        XCTAssertNil(request?.value(forHTTPHeaderField: "Origin"))
        XCTAssertNil(request?.value(forHTTPHeaderField: "Cookie"))
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: request!.httpBody!), .object(["args": .array([.string("conversation-id")])]))
    }
    func testUnauthorizedDoesNotAutomaticallyResendMutation() async throws {
        let transport = CapturingTransport(response: "{}", status: 401)
        let rpc = try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "tab", session: TestSession(), transport: transport)
        do { let _: JSONValue = try await rpc.call("send", as: JSONValue.self); XCTFail("Expected 401") }
        catch { XCTAssertEqual(error as? ServiceError, .signedOut) }
        let count = await transport.requests.count; XCTAssertEqual(count, 1)
    }
    func testLargeUploadRejectedBeforeRequest() async throws {
        let transport = CapturingTransport(response: "{}")
        let service = RemoteClaudexService(rpc: try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "tab", session: TestSession(), transport: transport))
        do { _ = try await service.upload(name: "large.pdf", data: Data(count: AttachmentLimits.clientMaximum + 1)); XCTFail("Expected size limit") }
        catch { XCTAssertEqual(error as? ServiceError, .tooLarge) }
        let count = await transport.requests.count; XCTAssertEqual(count, 0)
    }
}

