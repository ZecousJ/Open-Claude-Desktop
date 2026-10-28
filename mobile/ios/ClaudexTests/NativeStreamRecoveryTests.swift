#if !SWIFT_PACKAGE
import XCTest
@testable import Claudex

private actor RecoveryWire: HTTPTransport {
    private(set) var reads = 0
    private var pending: CheckedContinuation<(Data, Int), Error>?
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        if request.url?.lastPathComponent == "modelCatalog" { return (Data(#"{"ok":true,"value":null}"#.utf8), 200) }
        guard request.url?.lastPathComponent == "snapshot" else { throw ServiceError.invalidResponse }
        reads += 1
        return try await withCheckedThrowingContinuation { pending = $0 }
    }
    func resolve(_ state: Snapshot) throws {
        let body = try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": try .encode(state)]))
        pending?.resume(returning: (body, 200)); pending = nil
    }
    func fail() { pending?.resume(throwing: ServiceError.server("LOCAL_RECOVERY_FAILURE", nil)); pending = nil }
}
private struct RecoverySession: SessionProvider {
    func accessToken() async throws -> String { "LOCAL_SYNTHETIC_NO_NETWORK" }
    func eventsTicket(tabID: String) async throws -> String { throw ServiceError.invalidResponse }
    func signOut() async throws {}
}
@MainActor
final class NativeStreamRecoveryTests: XCTestCase {
    private func state(_ value: String) throws -> Snapshot {
        var state = try JSONDecoder().decode(Snapshot.self, from: Data(#"{"settings":{"name":"LOCAL_RECOVERY","providers":[],"effort":"high"},"conversations":[],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[]}"#.utf8))
        state.engine = .object(["value": .string(value)]); return state
    }
    private func frame(_ seq: Int, _ value: String) -> JSONValue {
        .object(["t": .string("event"), "seq": .number(Double(seq)), "event": .object(["type": .string("engine"), "engine": .object(["value": .string(value)])])])
    }
    private func snapshot(_ seq: Int, _ value: String) throws -> JSONValue {
        .object(["t": .string("snapshot"), "seq": .number(Double(seq)), "snapshot": try .encode(state(value))])
    }
    private func store(_ wire: RecoveryWire) throws -> AppStore {
        let rpc = try RPCClient(baseURL: URL(string: "https://local.invalid")!, tabID: "local-recovery", session: RecoverySession(), transport: wire)
        return AppStore(service: RemoteClaudexService(rpc: rpc))
    }
    private func wait(_ condition: @escaping () async -> Bool) async throws {
        for _ in 0..<100 { if await condition() { return }; try await Task.sleep(for: .milliseconds(20)) }
        XCTFail("Local recovery condition did not complete"); throw ServiceError.invalidResponse
    }
    func testGapReadsSnapshotAndReplaysLaterFramesOnSameStream() async throws {
        let wire = RecoveryWire(), store = try store(wire)
        store.receive(try snapshot(10, "before")); store.receive(frame(13, "gap"))
        try await wait { await wire.reads == 1 }
        store.receive(frame(14, "after-read"))
        try await wire.resolve(state("read"))
        try await wait { store.snapshot?.engine["value"].string == "after-read" }
        store.receive(frame(15, "continued"))
        XCTAssertEqual(store.snapshot?.engine["value"].string, "continued")
        try await Task.sleep(for: .milliseconds(700))
        let reads = await wire.reads; XCTAssertEqual(reads, 1)
    }
    func testFailedRecoveryDoesNotLoopAndManualRefreshCanRecover() async throws {
        let wire = RecoveryWire(), store = try store(wire)
        store.account = SessionAccount(raw: .object(["email": .string("local@example.invalid")]))
        store.receive(try snapshot(10, "before")); store.receive(frame(13, "gap"))
        try await wait { await wire.reads == 1 }; await wire.fail()
        try await wait { store.errorMessage == "LOCAL_RECOVERY_FAILURE" }
        for seq in 14...100 { store.receive(frame(seq, "pending")) }
        try await Task.sleep(for: .milliseconds(700))
        let reads = await wire.reads; XCTAssertEqual(reads, 1)
        let refresh = Task { await store.refresh() }
        try await wait { await wire.reads == 2 }; try await wire.resolve(state("refreshed"))
        await refresh.value
        store.receive(frame(101, "continued"))
        XCTAssertEqual(store.snapshot?.engine["value"].string, "continued")
    }
    func testOrderedSocketSnapshotSupersedesPendingHTTPRecovery() async throws {
        let wire = RecoveryWire(), store = try store(wire)
        store.receive(try snapshot(10, "before")); store.receive(frame(13, "gap"))
        try await wait { await wire.reads == 1 }
        store.receive(try snapshot(20, "socket"))
        try await wire.resolve(state("stale-http"))
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(store.snapshot?.engine["value"].string, "socket")
        store.receive(frame(21, "continued"))
        XCTAssertEqual(store.snapshot?.engine["value"].string, "continued")
    }
}
#endif
