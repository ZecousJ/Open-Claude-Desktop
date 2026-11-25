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
    private(set) var uploadCalls = 0
    private(set) var steerCalls: [JSONValue] = []
    private(set) var sends: [SendInput] = []
    private(set) var interrupts: [JSONValue] = []
    private(set) var retries: [JSONValue] = []
    private var codeEntries: [JSONValue] = []
    init(snapshot: Snapshot, steering: Steering, hold: Bool, failSend: Bool) { self.snapshot = snapshot; self.steering = steering; self.hold = hold; self.failSend = failSend }
    func release() { held?.resume(); held = nil }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        let args = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)["args"].array ?? []
        let value: JSONValue
        switch request.url?.lastPathComponent {
        case "snapshot": value = try .encode(snapshot)
        case "addAttachmentData": uploadCalls += 1; throw ServiceError.invalidResponse
        case "codeQueue": value = .object(["entries": .array(codeEntries)])
        case "queueCodeMessage":
            let input = args[1]
            let id = input["eventId"].string!
            codeEntries.removeAll { $0["eventId"].string == id }
            codeEntries.append(.object(["eventId": .string(id), "text": input["text"], "priority": input["priority"], "state": .string("queued"), "attachments": .array([]), "choice": input["choice"]]))
            value = .object(["entries": .array(codeEntries)])
        case "cancelCodeMessage":
            codeEntries.removeAll { $0["eventId"].string?.lowercased() == args[1].string?.lowercased() }
            value = .object(["entries": .array(codeEntries)])
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
        case "retryResponse":
            retries.append(.array(args))
            value = try .encode(snapshot.conversations.first { $0.id == args[0].string }!)
        case "interrupt":
            interrupts.append(.array(args))
            let index = snapshot.conversations.firstIndex { $0.id == args[0].string }!
            let conversation = snapshot.conversations[index]
            let turn = conversation.turns.last!
            let target = args.count > 1 ? args[1] : .null
            if target["turnId"].string == turn.id && target["turnCreatedAt"].number == turn.createdAt
                && target["conversationCreatedAt"].number == conversation.createdAt
                && target["threadId"].string == conversation.extensionFields["threadId"]?.string {
                snapshot.conversations[index].turns[0].status = "interrupted"
                snapshot.conversations[index].turns[0].extensionFields["userStopped"] = .bool(true)
                value = .object(["status": .string("accepted")])
            } else {
                value = .object(["status": .string("mismatch")])
            }
        default: throw ServiceError.invalidResponse
        }
        return (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": value])), 200)
    }
}
@MainActor final class NativeRunningComposerTests: XCTestCase {
    private func fixture(_ steering: RunningWire.Steering, hold: Bool = false, failSend: Bool = false, mode: ChatMode = .chat) async throws -> (AppStore, RunningWire, Conversation) {
        var state = try JSONDecoder().decode(Snapshot.self, from: Data(#"{"settings":{"name":"SYNTHETIC","activeProviderId":"synthetic-provider","providers":[{"id":"synthetic-provider","name":"SYNTHETIC","model":"synthetic-model","models":["synthetic-model"]}]},"conversations":[],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[]}"#.utf8))
        var conversation = try queueConversation(mode: mode)
        conversation.extensionFields["threadId"] = .string("synthetic-thread")
        conversation.turns[0].items = [try JSONValue.object(["id": .string("partial"), "type": .string("message"), "text": .string("SYNTHETIC partial reply")]).decode(TranscriptItem.self)]
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
    func testCodeQueueSurvivesNavigationAndCanBeCancelled() async throws {
        let (store, _, conversation) = try await fixture(.queued, mode: .code)
        store.send()
        try await wait { !store.isSending && store.queuedMessages.count == 1 }
        XCTAssertEqual(store.queuedMessages.first?.text, "SYNTHETIC next instruction")
        XCTAssertEqual(store.composerText, "")
        let entry = try XCTUnwrap(store.queuedMessages.first)
        store.activate(try queueConversation("synthetic-b", mode: .chat))
        store.activate(conversation)
        try await wait { store.queuedMessages.first?.id == entry.id }
        store.removeQueuedMessage(entry)
        try await wait { store.queuedMessages.isEmpty }
    }
    func testCodeQueueKeepsSelectedModelAcrossNavigationAndUndo() async throws {
        let (store, wire, conversation) = try await fixture(.queued, mode: .code)
        let next = ModelItem(id: "synthetic-next", displayName: "Next", description: "", badges: [], sort: 0,
                             hidden: false, isDefault: true, usageHint: "", efforts: ["high"], defaultEffort: "high", contextWindow: nil)
        store.modelCatalog = .loaded(.init(defaultModel: next.id, items: [next]))
        store.snapshot?.settings.raw = .object(["activeProviderId": .string("synthetic-provider"), "providers": .array([
            .object(["id": .string("synthetic-provider"), "name": .string("SYNTHETIC"), "model": .string(next.id), "models": .array([.string(next.id)])]),
        ])])
        let choice = try XCTUnwrap(store.modelChoices.first)
        XCTAssertTrue(store.selectModel(choice, mode: .code, conversation: conversation))
        store.send()
        try await wait { !store.isSending && store.queuedMessages.count == 1 }
        let entry = try XCTUnwrap(store.queuedMessages.first)
        XCTAssertEqual(entry.model, next.id); XCTAssertEqual(entry.effort, .high); XCTAssertTrue(entry.startsNextTurn)
        let rpc = try RPCClient(baseURL: URL(string: "https://synthetic.invalid")!, tabID: "synthetic-reopened", session: RunningSession(), transport: wire)
        let reopened = AppStore(service: RemoteClaudexService(rpc: rpc)); await reopened.boot()
        reopened.account = SessionAccount(raw: .object(["email": .string("synthetic@example.invalid")]))
        let state = await wire.snapshot
        reopened.receive(.object(["t": .string("snapshot"), "seq": .number(1), "snapshot": try .encode(state)]))
        reopened.modelCatalog = store.modelCatalog
        reopened.snapshot?.settings = try XCTUnwrap(store.snapshot?.settings)
        reopened.activate(conversation)
        try await wait { reopened.queuedMessages.first?.id == entry.id }
        let restored = try XCTUnwrap(reopened.queuedMessages.first)
        XCTAssertEqual(restored.model, next.id); XCTAssertEqual(restored.effort, .high)
        reopened.editQueuedMessage(restored)
        try await wait { reopened.queuedMessages.isEmpty && reopened.composerText == "SYNTHETIC next instruction" }
        XCTAssertEqual(reopened.selectedModelKey(mode: .code, conversation: conversation), choice.key)
        XCTAssertEqual(reopened.selectedEffort(choice, mode: .code, conversation: conversation), .high)
    }
    func testInvalidTextStopsBatchBeforeUploadAndKeepsDraft() async throws {
        let (store, wire, _) = try await fixture(.accepted)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let valid = folder.appendingPathComponent("first.txt"), invalid = folder.appendingPathComponent("second.txt")
        try Data("valid text".utf8).write(to: valid); try Data([0, 255]).write(to: invalid)
        store.addFile(valid); store.addFile(invalid)
        store.send(); try await wait { !store.isSending }
        XCTAssertEqual(store.composerText, "SYNTHETIC next instruction")
        XCTAssertEqual(store.attachments.count, 2)
        XCTAssertNotNil(store.errorMessage)
        let uploads = await wire.uploadCalls, steers = await wire.steerCalls, sends = await wire.sends
        XCTAssertEqual(uploads, 0); XCTAssertTrue(steers.isEmpty); XCTAssertTrue(sends.isEmpty)
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
    func testChangingModelQueuesANewTurnInsteadOfSteeringTheRunningModel() async throws {
        let (store, wire, conversation) = try await fixture(.accepted)
        let next = ModelItem(id: "synthetic-next", displayName: "Next", description: "", badges: [], sort: 0,
                             hidden: false, isDefault: true, usageHint: "", efforts: ["low"], defaultEffort: "low", contextWindow: nil)
        store.modelCatalog = .loaded(.init(defaultModel: next.id, items: [next]))
        store.snapshot?.settings.raw = .object(["activeProviderId": .string("synthetic-provider"), "providers": .array([
            .object(["id": .string("synthetic-provider"), "name": .string("SYNTHETIC"), "model": .string(next.id), "models": .array([.string(next.id)])]),
        ])])
        let choice = try XCTUnwrap(store.modelChoices.first)
        XCTAssertTrue(store.selectModel(choice, mode: .chat, conversation: conversation))
        store.send()
        try await wait { !store.isSending }
        let steers = await wire.steerCalls
        XCTAssertTrue(steers.isEmpty)
        XCTAssertEqual(store.queuedMessages.first?.state, .queued)

        try event(queueConversation(mode: .chat, running: false), store: store)
        try await wait { await wire.sends.count == 1 }
        let input = await wire.sends.first
        XCTAssertEqual(input?.model, next.id)
        XCTAssertEqual(input?.effort, .low)
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
    func testStopInterruptsOnlyTheDisplayedTurnAndKeepsDraftAndPartialText() async throws {
        let (store, wire, conversation) = try await fixture(.queued)
        await store.stopGeneration(conversation)
        let interrupts = await wire.interrupts, sends = await wire.sends, steers = await wire.steerCalls
        XCTAssertEqual(interrupts, [.array([.string(conversation.id), .object([
            "turnId": .string("t"), "turnCreatedAt": .number(1),
            "conversationCreatedAt": .number(1), "threadId": .string("synthetic-thread")
        ])])])
        XCTAssertTrue(sends.isEmpty); XCTAssertTrue(steers.isEmpty)
        XCTAssertEqual(store.composerText, "SYNTHETIC next instruction")
        XCTAssertEqual(store.activeConversation?.turns.last?.status, "interrupted")
        XCTAssertEqual(store.activeConversation?.turns.last?.extensionFields["userStopped"], .bool(true))
        XCTAssertEqual(store.activeConversation?.turns.last?.items.last?.text, "SYNTHETIC partial reply")
    }
    func testCodeRetrySendsTheSelectedTurn() async throws {
        let (store, wire, conversation) = try await fixture(.queued, mode: .code)
        try event(queueConversation(mode: .code, running: false), store: store)
        let retried = await store.retryResponse(conversationID: conversation.id, turnID: "t")
        XCTAssertTrue(retried)
        let retries = await wire.retries
        XCTAssertEqual(retries.first?.array?.prefix(2).map { $0 }, [.string(conversation.id), .string("t")])
    }
    func testCodeStopCarriesDisplayedTurnIdentity() async throws {
        let (store, wire, conversation) = try await fixture(.queued, mode: .code)
        await store.stopGeneration(conversation)
        let interrupts = await wire.interrupts
        XCTAssertEqual(interrupts, [.array([.string(conversation.id), .object([
            "turnId": .string("t"), "turnCreatedAt": .number(1),
            "conversationCreatedAt": .number(1), "threadId": .string("synthetic-thread")
        ])])])
    }
    func testStartingCodeStopUsesPendingIdentity() throws {
        var conversation = try queueConversation(mode: .code)
        var fields = try XCTUnwrap(JSONValue.encode(conversation.turns[0]).object)
        fields["id"] = .string("pending-synthetic")
        conversation.turns[0] = try JSONValue.object(fields).decode(Turn.self)
        let target = try XCTUnwrap(ChatStopTarget(conversation))
        XCTAssertEqual(try JSONValue.encode(target), .object([
            "kind": .string("starting"), "turnId": .string("pending-synthetic"),
            "turnCreatedAt": .number(1), "conversationCreatedAt": .number(1)
        ]))
    }
    func testStopRejectedForAChangedTurnDoesNotInterruptTheReplacement() async throws {
        let (store, wire, conversation) = try await fixture(.queued)
        var stale = conversation
        stale.extensionFields["threadId"] = .string("earlier-thread")
        await store.stopGeneration(stale)
        let interrupts = await wire.interrupts
        XCTAssertEqual(interrupts.count, 1)
        XCTAssertTrue(store.running)
        XCTAssertNotNil(store.errorMessage)
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
