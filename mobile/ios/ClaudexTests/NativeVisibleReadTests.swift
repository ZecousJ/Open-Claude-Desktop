#if !SWIFT_PACKAGE
import XCTest
@testable import Claudex

private struct ReadSession: SessionProvider {
    func accessToken() async throws -> String { "SYNTHETIC_NO_NETWORK" }
    func eventsTicket(tabID: String) async throws -> String { throw ServiceError.invalidResponse }
    func signOut() async throws {}
}
private actor ReadWire: HTTPTransport {
    let snapshot: Snapshot
    let fail: Bool
    private(set) var readIDs: [String] = []
    init(snapshot: Snapshot, fail: Bool) { self.snapshot = snapshot; self.fail = fail }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
        let args = body["args"].array ?? []
        let value: JSONValue
        switch request.url?.lastPathComponent {
        case "snapshot": value = try .encode(snapshot)
        case "updateConversation":
            guard args.count == 2, let id = args[0].string, args[1]["unread"].bool == false,
                  var conversation = snapshot.conversations.first(where: { $0.id == id }) else { throw ServiceError.invalidResponse }
            readIDs.append(id)
            if fail { throw ServiceError.server("SYNTHETIC_READ_FAILURE", nil) }
            conversation.extensionFields["unread"] = .bool(false); value = try .encode(conversation)
        default: throw ServiceError.invalidResponse
        }
        return (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": value])), 200)
    }
}
@MainActor final class NativeVisibleReadTests: XCTestCase {
    private func fixture(fail: Bool = false) async throws -> (AppStore, ReadWire, Conversation) {
        let state = try JSONDecoder().decode(Snapshot.self, from: Data(#"{"settings":{"name":"SYNTHETIC","activeProviderId":"p","providers":[{"id":"p","name":"SYNTHETIC","model":"m","models":["m"]}]},"conversations":[{"id":"synthetic-read","title":"SYNTHETIC visible read","mode":"chat","providerId":"p","model":"m","pinned":false,"archived":false,"createdAt":1,"updatedAt":1,"turns":[],"unread":false}],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[]}"#.utf8))
        let wire = ReadWire(snapshot: state, fail: fail)
        let rpc = try RPCClient(baseURL: URL(string: "https://synthetic.invalid")!, tabID: "synthetic-read", session: ReadSession(), transport: wire)
        let store = AppStore(service: RemoteClaudexService(rpc: rpc)); await store.boot()
        store.account = SessionAccount(raw: .object(["email": .string("synthetic@example.invalid")]))
        store.receive(.object(["t": .string("snapshot"), "seq": .number(1), "snapshot": try .encode(state)]))
        let conversation = state.conversations[0]; store.activate(conversation)
        store.chatPath = [.history, .conversation(conversation.id)]
        return (store, wire, conversation)
    }
    private func unread(_ conversation: Conversation, store: AppStore, seq: Int = 2) throws {
        var next = conversation; next.extensionFields["unread"] = .bool(true)
        store.receive(.object(["t": .string("event"), "seq": .number(Double(seq)), "event": .object(["type": .string("conversation"), "conversation": try .encode(next)])]))
    }
    private func waitForReads(_ wire: ReadWire, count: Int) async throws {
        for _ in 0..<100 {
            if await wire.readIDs.count == count { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Expected \(count) synthetic mark-read requests; got \(await wire.readIDs.count)")
        throw ServiceError.invalidResponse
    }
    func testVisibleRemoteUnreadClearsOnceWithoutNavigation() async throws {
        let (store, wire, conversation) = try await fixture()
        let path = store.chatPath, lease = store.conversationBridgeGeneration
        try unread(conversation, store: store); try await waitForReads(wire, count: 1)
        for _ in 0..<100 {
            if store.activeConversation?.unread == false { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(store.activeConversation!.unread)
        XCTAssertEqual(store.chatPath, path); XCTAssertEqual(store.conversationBridgeGeneration, lease)
        try await Task.sleep(for: .milliseconds(100)); let ids = await wire.readIDs
        XCTAssertEqual(ids, [conversation.id])
    }
    func testBackgroundUnreadWaitsUntilForeground() async throws {
        let (store, wire, conversation) = try await fixture()
        store.lifecycle(active: false); try unread(conversation, store: store)
        try await Task.sleep(for: .milliseconds(100)); let before = await wire.readIDs
        XCTAssertTrue(before.isEmpty); XCTAssertTrue(store.activeConversation!.unread)
        store.lifecycle(active: true); try await waitForReads(wire, count: 1)
    }
    func testOtherSectionDoesNotReadHiddenConversation() async throws {
        let (store, wire, conversation) = try await fixture()
        store.section = .projects; try unread(conversation, store: store)
        try await Task.sleep(for: .milliseconds(100)); let ids = await wire.readIDs
        XCTAssertTrue(ids.isEmpty); XCTAssertTrue(store.activeConversation!.unread)
    }
    func testHistoryDoesNotReadHiddenConversation() async throws {
        let (store, wire, conversation) = try await fixture()
        store.chatPath = [.history]; try unread(conversation, store: store)
        try await Task.sleep(for: .milliseconds(100)); let ids = await wire.readIDs
        XCTAssertTrue(ids.isEmpty); XCTAssertTrue(store.activeConversation!.unread)
    }
    func testIncognitoDoesNotPersistRead() async throws {
        let (store, wire, conversation) = try await fixture()
        var next = conversation; next.extensionFields["incognito"] = .bool(true)
        try unread(next, store: store)
        try await Task.sleep(for: .milliseconds(100)); let ids = await wire.readIDs
        XCTAssertTrue(ids.isEmpty)
    }
    func testQueuedReadIsDiscardedAfterSignOut() async throws {
        let (store, wire, conversation) = try await fixture()
        try unread(conversation, store: store)
        await store.signOut()
        try await Task.sleep(for: .milliseconds(100)); let ids = await wire.readIDs
        XCTAssertTrue(ids.isEmpty); XCTAssertNil(store.account)
    }
    func testSnapshotReplacementReadsCurrentConversation() async throws {
        let (store, wire, _) = try await fixture()
        var state = try XCTUnwrap(store.snapshot)
        state.conversations[0].extensionFields["unread"] = .bool(true)
        store.receive(.object(["t": .string("snapshot"), "seq": .number(2), "snapshot": try .encode(state)]))
        try await waitForReads(wire, count: 1)
    }
    func testReadFailureDoesNotRefetchOrNavigateInALoop() async throws {
        let (store, wire, conversation) = try await fixture(fail: true)
        let path = store.chatPath
        try unread(conversation, store: store); try await waitForReads(wire, count: 1)
        try await Task.sleep(for: .milliseconds(150)); let ids = await wire.readIDs
        XCTAssertEqual(ids, [conversation.id]); XCTAssertEqual(store.chatPath, path)
        XCTAssertTrue(store.activeConversation!.unread)
        XCTAssertEqual(store.errorMessage, "SYNTHETIC_READ_FAILURE")
    }
}
#endif
