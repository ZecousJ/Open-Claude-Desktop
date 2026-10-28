#if !SWIFT_PACKAGE
import XCTest
@testable import Claudex

private struct RunningSession: SessionProvider {
    func accessToken() async throws -> String { "SYNTHETIC_NO_NETWORK" }
    func eventsTicket(tabID: String) async throws -> String { throw ServiceError.invalidResponse }
    func signOut() async throws {}
}
private actor RunningWire: HTTPTransport {
    enum Steering: Sendable { case accepted, queued, failed }
    var snapshot: Snapshot
    let steering: Steering
    let hold: Bool
    let failSend: Bool
    private var held: CheckedContinuation<Void, Never>?
    private(set) var steerCalls: [JSONValue] = []
    private(set) var sends: [SendInput] = []
    private(set) var interrupts = 0
    init(snapshot: Snapshot, steering: Steering, hold: Bool, failSend: Bool) { self.snapshot = snapshot; self.steering = steering; self.hold = hold; self.failSend = failSend }
    func release() { held?.resume(); held = nil }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        let args = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)["args"].array ?? []
        let value: JSONValue
        switch request.url?.lastPathComponent {
        case "snapshot": value = try .encode(snapshot)
        case "steerTurn":
            steerCalls.append(.array(args))
            if hold { await withCheckedContinuation { held = $0 } }
            switch steering {
            case .accepted: value = .object(["messageId": .string("synthetic-m"), "conversation": try .encode(snapshot.conversations.first { $0.id == args[0].string }!)])
            case .queued: value = .null
            case .failed: throw ServiceError.server("SYNTHETIC_STEER_FAILURE", nil)
            }
        case "send":
            let input = try args[0].decode(SendInput.self); sends.append(input)
            if failSend { throw ServiceError.server("SYNTHETIC_SEND_FAILURE", nil) }
            var conversation = snapshot.conversations.first { $0.id == input.conversationId }!
            conversation.turns[0].status = "inProgress"; value = try .encode(conversation)
        case "interrupt":
            interrupts += 1
            let index = snapshot.conversations.firstIndex { $0.id == args[0].string }!
            snapshot.conversations[index].turns[0].status = "completed"; value = .null
        default: throw ServiceError.invalidResponse
        }
        return (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": value])), 200)
    }
}
@MainActor final class NativeRunningComposerTests: XCTestCase {
    private func fixture(_ steering: RunningWire.Steering, hold: Bool = false, failSend: Bool = false) async throws -> (AppStore, RunningWire, Conversation) {
        var state = try JSONDecoder().decode(Snapshot.self, from: Data(#"{"settings":{"name":"SYNTHETIC","activeProviderId":"synthetic-provider","providers":[{"id":"synthetic-provider","name":"SYNTHETIC","model":"synthetic-model","models":["synthetic-model"]}]},"conversations":[],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[]}"#.utf8))
        let conversation = try queueConversation(mode: .chat)
        state.conversations = [conversation, try queueConversation("synthetic-b", mode: .chat)]
        let wire = RunningWire(snapshot: state, steering: steering, hold: hold, failSend: failSend)
        let rpc = try RPCClient(baseURL: URL(string: "https://synthetic.invalid")!, tabID: "synthetic-running", session: RunningSession(), transport: wire)
        let store = AppStore(service: RemoteClaudexService(rpc: rpc)); await store.boot()
        store.account = SessionAccount(raw: .object(["email": .string("synthetic@example.invalid")]))
        store.receive(.object(["t": .string("snapshot"), "seq": .number(1), "snapshot": try .encode(state)]))
        store.activate(conversation); store.chatPath = [.conversation(conversation.id)]
        store.composerText = "SYNTHETIC next instruction"
        return (store, wire, conversation)
    }
    private func wait(_ condition: () async -> Bool) async throws {
        for _ in 0..<100 { if await condition() { return }; try await Task.sleep(for: .milliseconds(20)) }
        XCTFail("Synthetic native operation did not complete"); throw ServiceError.invalidResponse
    }
    private func event(_ conversation: Conversation, store: AppStore, seq: Int = 2) throws {
        store.receive(.object(["t": .string("event"), "seq": .number(Double(seq)), "event": .object(["type": .string("conversation"), "conversation": try .encode(conversation)])]))
    }
    func testAcceptedSteerClearsOnlySubmittedDraftAndKeepsSurface() async throws {
        let (store, wire, c) = try await fixture(.accepted)
        let path = store.chatPath, bridge = store.conversationBridgeGeneration
        XCTAssertTrue(store.running); XCTAssertTrue(store.canSend); store.send()
        try await wait { !store.isSending }
        XCTAssertEqual(store.queuedMessages.first?.state, .steered); XCTAssertEqual(store.composerText, "")
        XCTAssertEqual(store.chatPath, path); XCTAssertEqual(store.conversationBridgeGeneration, bridge)
        let initialSends = await wire.sends; XCTAssertTrue(initialSends.isEmpty)
        try event(queueConversation(mode: .chat, delivered: "synthetic-m"), store: store)
        XCTAssertTrue(store.queuedMessages.isEmpty); XCTAssertEqual(store.activeConversationID, c.id)
    }
    func testDefiniteNullQueuesAndDrainsOriginalConversationAfterSwitch() async throws {
        let (store, wire, c) = try await fixture(.queued); store.send(); try await wait { !store.isSending }
        XCTAssertEqual(store.queuedMessages.first?.state, .queued)
        let other = try queueConversation("synthetic-b", mode: .chat)
        store.activate(other); store.chatPath = [.conversation(other.id)]; store.composerText = "NEW DRAFT"
        let path = store.chatPath, bridge = store.conversationBridgeGeneration
        try event(queueConversation(mode: .chat, running: false), store: store)
        try await wait { await wire.sends.count == 1 }
        let sends = await wire.sends; XCTAssertEqual(sends[0].conversationId, c.id)
        XCTAssertEqual(store.composerText, "NEW DRAFT"); XCTAssertEqual(store.chatPath, path)
        XCTAssertEqual(store.conversationBridgeGeneration, bridge); XCTAssertEqual(store.activeConversationID, other.id)
    }
    func testSteerFailurePreservesDraftWithoutQueuedAutomaticReplay() async throws {
        let (store, wire, _) = try await fixture(.failed); store.send(); try await wait { !store.isSending }
        XCTAssertEqual(store.composerText, "SYNTHETIC next instruction"); XCTAssertTrue(store.queuedMessages.isEmpty)
        XCTAssertEqual(store.errorMessage, "SYNTHETIC_STEER_FAILURE")
        try event(queueConversation(mode: .chat, running: false), store: store)
        try await Task.sleep(for: .milliseconds(100)); let calls = await wire.steerCalls, sends = await wire.sends
        XCTAssertEqual(calls.count, 1); XCTAssertTrue(sends.isEmpty)
    }
    func testStopIsIndependentAndDoesNotSubmitTypedInstruction() async throws {
        let (store, wire, _) = try await fixture(.queued)
        await store.stopGeneration()
        let interrupts = await wire.interrupts, sends = await wire.sends, steers = await wire.steerCalls
        XCTAssertEqual(interrupts, 1); XCTAssertTrue(sends.isEmpty); XCTAssertTrue(steers.isEmpty)
        XCTAssertEqual(store.composerText, "SYNTHETIC next instruction")
    }
    func testLogoutDiscardsLateSteerAndItsQueue() async throws {
        let (store, wire, _) = try await fixture(.accepted, hold: true)
        store.send(); try await wait { await wire.steerCalls.count == 1 }
        await store.signOut(); await wire.release()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNil(store.account); XCTAssertTrue(store.composerQueue.allEntries.isEmpty)
    }
    func testFailedLateDraftIsRetainedOnOriginalConversation() async throws {
        let (store, wire, c) = try await fixture(.failed, hold: true)
        store.send(); try await wait { await wire.steerCalls.count == 1 }
        store.beginNewChat(); store.composerText = "NEW DRAFT"; await wire.release()
        try await wait { !store.isSending }
        XCTAssertEqual(store.composerText, "NEW DRAFT")
        let failed = store.composerQueue.entries(c.id)
        XCTAssertEqual(failed.first?.text, "SYNTHETIC next instruction"); XCTAssertNotNil(failed.first?.error)
        try event(queueConversation(mode: .chat, running: false), store: store)
        try await Task.sleep(for: .milliseconds(100)); let sends = await wire.sends; XCTAssertTrue(sends.isEmpty)
    }
    func testQueuedSendFailureStaysBlockedAcrossLaterEvents() async throws {
        let (store, wire, _) = try await fixture(.queued, failSend: true)
        store.send(); try await wait { !store.isSending }
        let idle = try queueConversation(mode: .chat, running: false)
        try event(idle, store: store)
        try await wait { store.queuedMessages.first?.error != nil }
        XCTAssertEqual(store.queuedMessages.first?.text, "SYNTHETIC next instruction")
        try event(idle, store: store, seq: 3); try event(idle, store: store, seq: 4)
        try await Task.sleep(for: .milliseconds(100)); let sends = await wire.sends
        XCTAssertEqual(sends.count, 1); XCTAssertEqual(store.queuedMessages.first?.error, "SYNTHETIC_SEND_FAILURE")
    }
    func testQueuedFileSurvivesNavigationAndEditThenLogoutClearsIt() async throws {
        let (store, _, c) = try await fixture(.queued)
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-synthetic.txt")
        try Data("SYNTHETIC attachment".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        store.addFile(source, displayName: "SYNTHETIC.txt")
        let staged = try XCTUnwrap(store.attachments.first?.url)
        let uploaded = try JSONValue.object(["id": .string("synthetic-file"), "name": .string("SYNTHETIC.txt"), "path": .string("synthetic/file"), "kind": .string("text"), "size": .number(20)]).decode(Attachment.self)
        store.attachments[0].uploaded = uploaded
        store.send(); try await wait { !store.isSending }
        XCTAssertTrue(store.attachments.isEmpty); XCTAssertTrue(FileManager.default.fileExists(atPath: staged.path))
        store.beginNewChat(); XCTAssertTrue(FileManager.default.fileExists(atPath: staged.path))
        store.activate(c); store.chatPath = [.conversation(c.id)]
        let pending = try XCTUnwrap(store.queuedMessages.first)
        store.editQueuedMessage(pending)
        XCTAssertTrue(store.queuedMessages.isEmpty); XCTAssertEqual(store.attachments.first?.uploaded?.id, uploaded.id)
        XCTAssertTrue(FileManager.default.fileExists(atPath: staged.path))
        await store.signOut(); XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
    }
}
#endif
