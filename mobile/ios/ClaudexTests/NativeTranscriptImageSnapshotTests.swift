#if !SWIFT_PACKAGE
import XCTest
@testable import Claudex

private struct NativeImageSession: SessionProvider {
    func accessToken() async throws -> String { "SYNTHETIC_NO_NETWORK" }
    func eventsTicket(tabID: String) async throws -> String { throw ServiceError.invalidResponse }
    func signOut() async throws {}
}
private actor NativeImageWire: HTTPTransport {
    private var pending: CheckedContinuation<(Data, Int), Error>?
    private(set) var reads = 0
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        guard request.url?.lastPathComponent == "imageGenerationSnapshot" else { throw ServiceError.invalidResponse }
        reads += 1
        return try await withCheckedThrowingContinuation { pending = $0 }
    }
    func resolve() throws {
        let descriptor: JSONValue = .object(["digest": .string(String(repeating: "a", count: 64)), "mime": .string("image/png"), "bytes": .number(123)])
        pending?.resume(returning: (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": descriptor])), 200)); pending = nil
    }
}
@MainActor
final class NativeTranscriptImageSnapshotTests: XCTestCase {
    private func state(path: String = "synthetic/picture.png") throws -> Snapshot {
        let data = Data(#"{"settings":{"name":"SYNTHETIC","providers":[],"effort":"high"},"conversations":[{"id":"c","title":"SYNTHETIC","mode":"chat","providerId":"p","model":"m","pinned":false,"archived":false,"createdAt":1,"updatedAt":1,"turns":[{"id":"t","prompt":"SYNTHETIC","attachments":[],"items":[{"id":"i","type":"imageGeneration","savedPath":"synthetic/picture.png"}],"status":"completed","createdAt":1}]}],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[]}"#.utf8)
        var wire = try JSONDecoder().decode(JSONValue.self, from: data)
        var fields = wire.object!, conversations = wire["conversations"].array!, conversation = conversations[0].object!, turns = conversation["turns"]!.array!, turn = turns[0].object!, items = turn["items"]!.array!, item = items[0].object!
        item["savedPath"] = .string(path); items[0] = .object(item); turn["items"] = .array(items); turns[0] = .object(turn); conversation["turns"] = .array(turns); conversations[0] = .object(conversation); fields["conversations"] = .array(conversations); wire = .object(fields)
        return try wire.decode(Snapshot.self)
    }
    private func store(_ wire: NativeImageWire) throws -> AppStore {
        let rpc = try RPCClient(baseURL: URL(string: "https://synthetic.invalid")!, tabID: "synthetic-image", session: NativeImageSession(), transport: wire)
        let store = AppStore(service: RemoteClaudexService(rpc: rpc))
        store.account = SessionAccount(raw: .object(["email": .string("synthetic@example.invalid")]))
        store.snapshot = try state(); store.activeConversationID = "c"
        return store
    }
    private func waitForRead(_ wire: NativeImageWire) async throws {
        for _ in 0..<100 { if await wire.reads == 1 { return }; try await Task.sleep(for: .milliseconds(20)) }
        XCTFail("Synthetic snapshot request did not start"); throw ServiceError.invalidResponse
    }
    func testCapturePublishesCanonicalOpenAuthorityAndDoesNotMutateServerSnapshot() async throws {
        let wire = NativeImageWire(), store = try store(wire), generation = store.conversationBridgeGeneration
        let capture = Task { await store.captureTranscriptImages("c", generation: generation) }
        try await waitForRead(wire); try await wire.resolve(); await capture.value
        let file = try XCTUnwrap(store.conversations.first?.turns.first?.items.first?.generatedFiles.first)
        XCTAssertTrue(store.snapshot!.conversations[0].turns[0].items[0].generatedFiles.isEmpty)
        let payload: JSONValue = .object(["conversationId": .string("c"), "artifactId": .string("generated:\(file.id):\(file.digest!)"), "sourcePath": .string(file.path), "sourceDigest": .string(file.digest!)])
        var opened: GeneratedFile?
        _ = try await store.dispatchSharedConversationAction(.init(sessionID: "synthetic", requestID: "open", type: .openArtifact, payload: payload), conversationID: "c", generation: generation, present: { if case .file(let value) = $0 { opened = value } }, export: { _ in XCTFail("Not an export"); return nil })
        XCTAssertEqual(opened, file); XCTAssertNoThrow(try store.validateSharedExport(file, conversationID: "c", generation: generation))
        store.snapshot = try state(path: "changed.png")
        XCTAssertThrowsError(try store.validateSharedExport(file, conversationID: "c", generation: generation))
    }
    func testChangedItemWhileRPCIsPendingCannotGainCanonicalFile() async throws {
        let wire = NativeImageWire(), store = try store(wire), generation = store.conversationBridgeGeneration
        let capture = Task { await store.captureTranscriptImages("c", generation: generation) }
        try await waitForRead(wire); store.snapshot = try state(path: "changed.png"); try await wire.resolve(); await capture.value
        XCTAssertTrue(store.conversations[0].turns[0].items[0].generatedFiles.isEmpty)
    }
    func testLogoutAndReusedConversationIDsCannotReceiveOldDescriptor() async throws {
        let wire = NativeImageWire(), store = try store(wire), generation = store.conversationBridgeGeneration
        let capture = Task { await store.captureTranscriptImages("c", generation: generation) }
        try await waitForRead(wire); await store.signOut()
        store.account = SessionAccount(raw: .object(["email": .string("other-synthetic@example.invalid")]))
        store.snapshot = try state(); store.activeConversationID = "c"
        try await wire.resolve(); await capture.value
        XCTAssertTrue(store.conversations[0].turns[0].items[0].generatedFiles.isEmpty)
    }
    func testNavigationDropsInFlightDescriptor() async throws {
        let wire = NativeImageWire(), store = try store(wire), generation = store.conversationBridgeGeneration
        let capture = Task { await store.captureTranscriptImages("c", generation: generation) }
        try await waitForRead(wire); store.activeConversationID = nil; try await wire.resolve(); await capture.value
        XCTAssertTrue(store.conversations[0].turns[0].items[0].generatedFiles.isEmpty)
    }
}
#endif
