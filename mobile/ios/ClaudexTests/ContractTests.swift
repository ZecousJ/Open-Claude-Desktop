import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if SWIFT_PACKAGE
import ClaudexCore
#else
@testable import Claudex
#endif

private func j(_ text: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }
private func state() throws -> Snapshot { try j("""
{"settings":{"name":"Sample","providers":[{"id":"p1","name":"Private","model":"m1","models":["m1"],"routes":[{"keyId":"id-not-a-secret","primary":true}]}],"activeProviderId":"p1","effort":"high","futureFlag":{"nested":[true,1,"x"]}},"conversations":[{"id":"c1","title":"First","mode":"chat","providerId":"p1","model":"m1","pinned":true,"archived":false,"projectId":"proj","createdAt":0,"updatedAt":1,"turns":[]}],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{"state":"ready"},"approvals":[]}
""").decode(Snapshot.self) }
private func snapshotFrame(_ seq: Int = 10) throws -> JSONValue { .object(["t": .string("snapshot"), "seq": .number(Double(seq)), "snapshot": try .encode(state())]) }
private func signedOut(_ seq: Int) -> JSONValue { .object(["t": .string("event"), "seq": .number(Double(seq)), "event": .object(["type": .string("signed-out"), "message": .string("Revoked")])]) }
private actor FakeSession: SessionProvider {
    let token: String
    init(token: String = "fixture-bearer") { self.token = token }
    func accessToken() async throws -> String { token }
    func eventsTicket(tabID: String) async throws -> String { "fixture-ticket" }
    func signOut() async throws {}
}
private actor Wire: HTTPTransport {
    let data: Data
    let status: Int
    var requests: [URLRequest] = []
    init(_ json: String, status: Int = 200) { data = Data(json.utf8); self.status = status }
    func execute(_ request: URLRequest) async throws -> (Data, Int) { requests.append(request); return (data, status) }
    func request() -> URLRequest? { requests.last }
    func count() -> Int { requests.count }
}
private func client(_ wire: Wire, token: String = "fixture-bearer") throws -> RPCClient { try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "tab-one", session: FakeSession(token: token), transport: wire) }

final class StreamContractTests: XCTestCase {
    func testSignedOutWithSequenceGapStillClearsState() throws {
        var reducer = StreamReducer(); _ = try reducer.apply(snapshotFrame())
        XCTAssertEqual(try reducer.apply(signedOut(12)), .signedOut("Revoked"))
        XCTAssertNil(reducer.snapshot); XCTAssertNil(reducer.lastSequence)
    }
    func testSignedOutWhileResyncRequiredStillClearsState() throws {
        var reducer = StreamReducer(); _ = try reducer.apply(snapshotFrame())
        _ = try reducer.apply(j(#"{"t":"event","seq":12,"event":{"type":"engine","engine":{"state":"ready"}}}"#))
        XCTAssertEqual(try reducer.apply(signedOut(13)), .signedOut("Revoked"))
        XCTAssertNil(reducer.snapshot)
    }
    func testEventZeroSequenceIsRejected() throws {
        var reducer = StreamReducer(snapshot: try state())
        XCTAssertThrowsError(try reducer.apply(j(#"{"t":"event","seq":0,"event":{"type":"engine","engine":{"state":"ready"}}}"#)))
        XCTAssertNil(reducer.lastSequence)
    }
    func testEventMissingTypeCannotAdvanceCursor() throws {
        var reducer = StreamReducer(snapshot: try state())
        XCTAssertThrowsError(try reducer.apply(j(#"{"t":"event","seq":1,"event":{}}"#)))
        XCTAssertNil(reducer.lastSequence)
    }
    func testReadyRequiresResumedBoolean() throws {
        var reducer = StreamReducer(snapshot: try state())
        XCTAssertThrowsError(try reducer.apply(j(#"{"t":"ready","v":1,"seq":1}"#)))
        XCTAssertNil(reducer.lastSequence)
    }
    func testUnknownConversationTurnWaitsForFullEventAndAdvancesCursor() throws {
        var reducer = StreamReducer(); _ = try reducer.apply(snapshotFrame())
        let before = reducer.snapshot
        let result = try reducer.apply(j(#"{"t":"event","seq":11,"event":{"type":"conversation-turn","conversationId":"other","turn":{"id":"t1","prompt":"x","attachments":[],"items":[],"status":"completed","createdAt":0}}}"#))
        XCTAssertEqual(result, .none); XCTAssertEqual(reducer.snapshot, before); XCTAssertEqual(reducer.lastSequence, 11) // shared/types.ts: unknown conversations wait for the next full event
    }
    func testMetadataPatchPreservesUnchangedAndClearsNullableProject() throws {
        var reducer = StreamReducer(); _ = try reducer.apply(snapshotFrame())
        let result = try reducer.apply(j(#"{"t":"event","seq":11,"event":{"type":"conversation-turn","conversationId":"c1","turn":{"id":"t1","prompt":"x","attachments":[],"items":[],"status":"completed","createdAt":0},"conversation":{"id":"not-allowed","turns":[],"projectId":null,"title":"Updated"}}}"#))
        XCTAssertEqual(result, .changed)
        let conversation = try XCTUnwrap(reducer.snapshot?.conversations.first)
        XCTAssertEqual(conversation.id, "c1"); XCTAssertEqual(conversation.title, "Updated"); XCTAssertTrue(conversation.pinned)
        XCTAssertNil(conversation.projectId); XCTAssertEqual(conversation.turns.count, 1)
    }
    func testMalformedSnapshotDoesNotChangeCursorOrState() throws {
        var reducer = StreamReducer(); _ = try reducer.apply(snapshotFrame())
        let before = reducer.snapshot
        XCTAssertThrowsError(try reducer.apply(j(#"{"t":"snapshot","seq":11,"snapshot":{"conversations":[]}}"#)))
        XCTAssertEqual(reducer.snapshot, before); XCTAssertEqual(reducer.lastSequence, 10)
    }
    func testResumedReplayCanRecoverSequenceGap() throws {
        var reducer = StreamReducer(); _ = try reducer.apply(snapshotFrame())
        _ = try reducer.apply(j(#"{"t":"event","seq":12,"event":{"type":"engine","engine":{"state":"ready"}}}"#))
        XCTAssertTrue(reducer.needsResync)
        _ = try reducer.apply(j(#"{"t":"ready","v":1,"seq":12,"resumed":true}"#))
        XCTAssertEqual(try reducer.apply(j(#"{"t":"event","seq":11,"event":{"type":"engine","engine":{"state":"starting"}}}"#)), .changed)
        XCTAssertEqual(reducer.lastSequence, 11)
        XCTAssertFalse(reducer.needsResync)
    }
    func testStaleSnapshotIgnored() throws {
        var reducer = StreamReducer(); _ = try reducer.apply(snapshotFrame())
        XCTAssertEqual(try reducer.apply(snapshotFrame(9)), .none); XCTAssertEqual(reducer.lastSequence, 10)
    }
    func testSettingsNestedUnknownFieldsRoundTrip() throws {
        let initial = try state().settings
        let edited = initial.replacingEffort("medium", mode: .code)
        XCTAssertEqual(edited.raw["futureFlag"], initial.raw["futureFlag"])
        XCTAssertEqual(edited.raw["providers"], initial.raw["providers"])
        XCTAssertEqual(edited.effort, "high"); XCTAssertEqual(edited.codeEffort, "medium")
    }
}

final class RPCContractTests: XCTestCase {
    func testNullCatalogIsSupported() async throws {
        let wire = Wire(#"{"ok":true,"value":null}"#)
        let catalog = try await RemoteClaudexService(rpc: client(wire)).models()
        XCTAssertNil(catalog)
        let request = await wire.request(); XCTAssertEqual(request?.url?.path, "/api/v1/claudex/web/rpc/modelCatalog")
    }
    func testVoidRPCMayOmitValue() async throws {
        let wire = Wire(#"{"ok":true}"#)
        try await RemoteClaudexService(rpc: client(wire)).interrupt("c1")
        let count = await wire.count(); XCTAssertEqual(count, 1)
    }
    func testBinaryUploadUsesExactWireBase64Envelope() async throws {
        let wire = Wire(#"{"ok":true,"value":{"id":"a1","name":"tiny.bin","path":"/safe/a1","kind":"document","size":4}}"#)
        _ = try await RemoteClaudexService(rpc: client(wire)).upload(name: "tiny.bin", data: Data([0, 255, 42, 7]))
        let capturedRequest = await wire.request()
        let request = try XCTUnwrap(capturedRequest)
        let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody))
        XCTAssertEqual(body, .object(["args": .array([.string("tiny.bin"), .object(["$bytes": .string("AP8qBw==")])])]))
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Claudex-Web-Tab"), "tab-one")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Claudex-Client")) // Native bridge does not impersonate a web client.
    }
    func testRPCBodyOverOneMiBRejectedBeforeTransport() async throws {
        let wire = Wire(#"{"ok":true}"#)
        do { let _: JSONValue = try await client(wire).call("send", args: [.string(String(repeating: "x", count: 1_048_577))], as: JSONValue.self); XCTFail("Must reject large body") }
        catch { XCTAssertEqual(error as? ServiceError, .tooLarge) }
        let count = await wire.count(); XCTAssertEqual(count, 0)
    }
    func testEmptyBearerNeverReachesTransport() async throws {
        let wire = Wire(#"{"ok":true}"#)
        do { let _: JSONValue = try await client(wire, token: "").call("snapshot", as: JSONValue.self); XCTFail("Must require token") }
        catch { XCTAssertEqual(error as? ServiceError, .signedOut) }
        let count = await wire.count(); XCTAssertEqual(count, 0)
    }
    func test401InvalidJSONStillBecomesSignedOutWithoutRetry() async throws {
        let wire = Wire("<html>expired</html>", status: 401)
        do { let _: JSONValue = try await client(wire).call("send", as: JSONValue.self); XCTFail("Must reject") }
        catch { XCTAssertEqual(error as? ServiceError, .signedOut) }
        let count = await wire.count(); XCTAssertEqual(count, 1)
    }
    func testServerErrorPreservesCodeAndNeverRetriesMutation() async throws {
        let wire = Wire(#"{"ok":false,"error":{"message":"Unavailable","code":"CLAUDEX_WEB_RUNNER_UNAVAILABLE"}}"#, status: 503)
        do { let _: JSONValue = try await client(wire).call("send", as: JSONValue.self); XCTFail("Must reject") }
        catch { XCTAssertEqual(error as? ServiceError, .server("Unavailable", "CLAUDEX_WEB_RUNNER_UNAVAILABLE")) }
        let count = await wire.count(); XCTAssertEqual(count, 1)
    }
    func testInvalidRPCMethodCannotChangeRoute() async throws {
        let wire = Wire(#"{"ok":true}"#)
        for method in ["../auth/logout", "Snapshot", "send?x=1", String(repeating: "a", count: 65)] {
            do { let _: JSONValue = try await client(wire).call(method, as: JSONValue.self); XCTFail("Must reject invalid method") }
            catch { XCTAssertEqual(error as? ServiceError, .invalidResponse) }
        }
        let count = await wire.count(); XCTAssertEqual(count, 0)
    }
}

final class RedirectPolicyTests: XCTestCase {
    func testRedirectDelegateNeverForwardsBearerRequest() throws {
        let transport = URLSessionTransport()
        let networkSession = URLSession(configuration: .ephemeral)
        defer { networkSession.invalidateAndCancel() }
        let source = URL(string: "https://service.test/api/v1/claudex/web/rpc/snapshot")!
        var original = URLRequest(url: source); original.setValue("Bearer fixture-only", forHTTPHeaderField: "Authorization")
        let task = networkSession.dataTask(with: original)
        let redirect = HTTPURLResponse(url: source, statusCode: 302, httpVersion: nil, headerFields: ["Location": "https://other.test/"])!
        var destination = URLRequest(url: URL(string: "https://other.test/")!)
        destination.setValue("Bearer fixture-only", forHTTPHeaderField: "Authorization")
        var completionCalled = false
        var forwardedRequest: URLRequest?
        transport.urlSession(networkSession, task: task, willPerformHTTPRedirection: redirect, newRequest: destination) { request in
            completionCalled = true; forwardedRequest = request
        }
        XCTAssertTrue(completionCalled); XCTAssertNil(forwardedRequest)
    }
}

private actor RefreshingSession: SessionProvider {
    var refreshCount = 0
    func accessToken() async throws -> String { "old-fixture-token" }
    func refreshAccessToken() async throws -> String { refreshCount += 1; return "new-fixture-token" }
    func eventsTicket(tabID: String) async throws -> String { String(repeating: "a", count: 43) }
    func signOut() async throws {}
}
private actor ResponseSequence: HTTPTransport {
    var requests: [URLRequest] = []
    let statuses: [Int]
    let failsTransport: Bool
    init(statuses: [Int], failsTransport: Bool = false) { self.statuses = statuses; self.failsTransport = failsTransport }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        requests.append(request)
        if failsTransport { throw URLError(.timedOut) }
        return (Data(#"{"ok":true,"value":null}"#.utf8), statuses[min(requests.count - 1, statuses.count - 1)])
    }
}
final class AuthenticatedRetryTests: XCTestCase {
    func testExplicit401RefreshesOnceAndReplaysIdenticalBody() async throws {
        let wire = ResponseSequence(statuses: [401, 200]), session = RefreshingSession()
        let rpc = try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "test", session: session, transport: wire)
        let _: JSONValue = try await rpc.call("send", args: [.string("fixture payload")], as: JSONValue.self)
        let requests = await wire.requests, count = await session.refreshCount
        XCTAssertEqual(count, 1); XCTAssertEqual(requests.count, 2); XCTAssertEqual(requests[0].httpBody, requests[1].httpBody)
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer old-fixture-token")
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer new-fixture-token")
    }
    func testSecond401StopsWithoutThirdRequest() async throws {
        let wire = ResponseSequence(statuses: [401, 401]), session = RefreshingSession()
        let rpc = try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "test", session: session, transport: wire)
        do { let _: JSONValue = try await rpc.call("send", as: JSONValue.self); XCTFail("Second401 must end session") }
        catch { XCTAssertEqual(error as? ServiceError, .signedOut) }
        let requests = await wire.requests, count = await session.refreshCount
        XCTAssertEqual(requests.count, 2); XCTAssertEqual(count, 1)
    }
    func testAmbiguousTransportFailureNeverRetriesMutation() async throws {
        let wire = ResponseSequence(statuses: [], failsTransport: true), session = RefreshingSession()
        let rpc = try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "test", session: session, transport: wire)
        do { let _: JSONValue = try await rpc.call("send", as: JSONValue.self); XCTFail("Expected transport timeout") }
        catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
        let requests = await wire.requests, count = await session.refreshCount
        XCTAssertEqual(requests.count, 1); XCTAssertEqual(count, 0)
    }
}
