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

private let hydrationSentinel = "AFTER_1024_COMMAND_SENTINEL"
private let longCommand = String(repeating: "🧪", count: 700) + hydrationSentinel
private let longPrompt = String(repeating: "完整用户问题", count: 400)
private let longAssistant = String(repeating: "完整助手回答", count: 400)
private func transcriptTurn(full: Bool, text: String? = nil) throws -> Turn {
    let command = full ? (text ?? longCommand) : String(longCommand.prefix(512)) + "…"
    return try JSONValue.object([
        "id": .string("turn-1"), "prompt": .string(longPrompt), "attachments": .array([]),
        "status": .string("completed"), "createdAt": .number(100),
        "items": .array([
            .object(["id": .string("cmd-1"), "type": .string("commandExecution"),
                     "command": .string(command), "aggregatedOutput": .string(command),
                     "commandActions": .array([.object(["command": .string(command)])])]),
            .object(["id": .string("assistant-1"), "type": .string("agentMessage"), "text": .string(longAssistant)])
        ])
    ]).decode(Turn.self)
}
private func hydrationConversation(id: String = "c1", slim: Bool? = true, title: String = "Conversation", full: Bool = false) throws -> Conversation {
    var fields: [String: JSONValue] = ["id": .string(id), "title": .string(title), "mode": .string("code"),
        "providerId": .string("p1"), "model": .string("m1"), "pinned": .bool(false), "archived": .bool(false),
        "createdAt": .number(100), "updatedAt": .number(200), "turns": .array([try .encode(transcriptTurn(full: full))])]
    if let slim { fields["slim"] = .bool(slim) }
    return try JSONValue.object(fields).decode(Conversation.self)
}
private func fullTranscript(_ text: String? = nil, branches: Bool = true) throws -> ConversationTurns {
    let turn = try transcriptTurn(full: true, text: text)
    return ConversationTurns(turns: [turn], savedBranches: branches ? [.object(["id": .string("branch-1"), "turns": .array([try .encode(turn)])])] : nil)
}
private func hydrationSnapshot(_ conversation: Conversation) throws -> Snapshot {
    try JSONValue.object(["settings": .object([:]), "conversations": .array([try .encode(conversation)]),
                          "projects": .array([]), "artifactLibrary": .object([:]), "engine": .object([:]), "approvals": .array([])]).decode(Snapshot.self)
}
private enum HydrationFailure: Error, LocalizedError { case offline
    var errorDescription: String? { "Test transport offline" }
}
private actor ControlledTranscriptFetch {
    private var pending: [Int: CheckedContinuation<ConversationTurns, Error>] = [:]
    private(set) var ids: [String] = []
    func fetch(_ id: String) async throws -> ConversationTurns {
        let index = ids.count; ids.append(id)
        // Deliberately ignores cancellation to reproduce completed-response races.
        return try await withCheckedThrowingContinuation { pending[index] = $0 }
    }
    func succeed(_ index: Int, _ value: ConversationTurns) { pending.removeValue(forKey: index)?.resume(returning: value) }
    func fail(_ index: Int) { pending.removeValue(forKey: index)?.resume(throwing: HydrationFailure.offline) }
    func count() -> Int { ids.count }
}

final class ConversationHydrationTests: XCTestCase {
    @MainActor private func eventually(_ condition: @escaping @MainActor () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<400 { if await condition() { return }; try? await Task.sleep(for: .milliseconds(2)) }
        XCTFail("Condition did not become true", file: file, line: line)
    }
    @MainActor private func make(_ fetch: ControlledTranscriptFetch) -> ConversationHydrator {
        ConversationHydrator(fetch: { id in try await fetch.fetch(id) })
    }
    func testWirePayloadContainsTurnsAndOptionalSavedBranchesNotConversation() throws {
        let value = try JSONValue.encode(fullTranscript())
        XCTAssertNil(value["id"].string)
        let decoded = try value.decode(ConversationTurns.self)
        XCTAssertEqual(decoded.turns.first?.prompt, longPrompt)
        XCTAssertEqual(decoded.savedBranches?.first?["turns"].array?.first?["items"].array?.first?["command"].string, longCommand)
        XCTAssertNil(try JSONValue.object(["turns": .array([])]).decode(ConversationTurns.self).savedBranches)
    }
    func testSlimMarkerAndBranchesRoundTripAndOldServerOmission() throws {
        var value = try hydrationConversation(); value.savedBranches = try fullTranscript().savedBranches
        let encoded = try JSONValue.encode(value)
        XCTAssertEqual(encoded["slim"].bool, true)
        XCTAssertEqual(try encoded.decode(Conversation.self).savedBranches, value.savedBranches)
        XCTAssertNil(try hydrationConversation(slim: nil).slim)
    }
    func testTurnOnlyEventDoesNotClearSlimMarker() throws {
        var reducer = StreamReducer(snapshot: try hydrationSnapshot(hydrationConversation()))
        let event: JSONValue = .object(["t": .string("event"), "seq": .number(1), "event": .object([
            "type": .string("conversation-turn"), "conversationId": .string("c1"), "turn": try .encode(transcriptTurn(full: true)),
            "conversation": .object(["slim": .bool(false), "updatedAt": .number(201)])])])
        XCTAssertEqual(try reducer.apply(event), .changed)
        XCTAssertEqual(reducer.snapshot?.conversations.first?.slim, true)
    }
    func testFullConversationEventClearsMarkerAndPreservesFullCommand() throws {
        var reducer = StreamReducer(snapshot: try hydrationSnapshot(hydrationConversation()))
        let full = try hydrationConversation(slim: nil, full: true)
        _ = try reducer.apply(.object(["t": .string("event"), "seq": .number(1), "event": .object(["type": .string("conversation"), "conversation": try .encode(full)])]))
        XCTAssertNil(reducer.snapshot?.conversations.first?.slim)
        XCTAssertEqual(reducer.snapshot?.conversations.first?.turns.first?.items.first?.raw["command"].string, longCommand)
    }
    @MainActor func testOpeningSlimConversationRestoresAllClippedFieldsAndBranches() async throws {
        let fetch = ControlledTranscriptFetch()
        let subject = make(fetch)
        var applied: Conversation?
        subject.onHydrated = { applied = $0 }
        subject.observe([try hydrationConversation()]); subject.select("c1")
        await eventually { await fetch.count() == 1 }
        await fetch.succeed(0, try fullTranscript())
        await eventually { applied != nil }
        let command = applied?.turns.first?.items.first?.raw
        XCTAssertEqual(command?["command"].string, longCommand)
        XCTAssertEqual(command?["aggregatedOutput"].string, longCommand)
        XCTAssertEqual(command?["commandActions"].array?.first?["command"].string, longCommand)
        XCTAssertEqual(applied?.turns.first?.prompt, longPrompt)
        XCTAssertEqual(applied?.turns.first?.items.last?.text, longAssistant)
        XCTAssertTrue(longCommand.utf16.count > 1024)
        XCTAssertTrue(command?["command"].string?.contains(hydrationSentinel) == true)
        XCTAssertNil(applied?.slim); XCTAssertNotNil(applied?.savedBranches)
        XCTAssertTrue(subject.states.isEmpty)
    }
    @MainActor func testRepeatedSelectionAndObservationAreSingleFlight() async throws {
        let fetch = ControlledTranscriptFetch(), value = try hydrationConversation()
        let subject = make(fetch); subject.observe([value]); subject.select("c1")
        for _ in 0..<20 { subject.select("c1"); subject.observe([value]) }
        await eventually { await fetch.count() == 1 }
        XCTAssertEqual(subject.states["c1"], .loading)
        await fetch.succeed(0, try fullTranscript()); await eventually { subject.states.isEmpty }
        let count = await fetch.count(); XCTAssertEqual(count, 1)
    }
    @MainActor func testNonSlimOldServerNeverHydrates() async throws {
        let fetch = ControlledTranscriptFetch()
        let loader = make(fetch)
        loader.observe([try hydrationConversation(slim: nil, full: true)]); loader.select("c1"); loader.retry("c1")
        for _ in 0..<10 { await Task.yield() }
        let count = await fetch.count(); XCTAssertEqual(count, 0); XCTAssertTrue(loader.states.isEmpty)
    }
    @MainActor func testFailureVisibleNoAutomaticLoopAndExplicitRetrySucceeds() async throws {
        let fetch = ControlledTranscriptFetch(), value = try hydrationConversation()
        let subject = make(fetch); var applied: Conversation?
        subject.onHydrated = { applied = $0 }; subject.observe([value]); subject.select("c1")
        await eventually { await fetch.count() == 1 }; await fetch.fail(0)
        await eventually { if case .failed = subject.states["c1"] { return true }; return false }
        for _ in 0..<20 { subject.observe([value]); subject.select("c1") }
        let count = await fetch.count(); XCTAssertEqual(count, 1); XCTAssertNil(applied)
        subject.retry("c1"); await eventually { await fetch.count() == 2 }
        await fetch.succeed(1, try fullTranscript()); await eventually { applied != nil }
    }
    @MainActor func testNewFullEventWinsAgainstOlderHydration() async throws {
        let fetch = ControlledTranscriptFetch()
        let loader = make(fetch); var applied: [Conversation] = []
        loader.onHydrated = { applied.append($0) }; loader.observe([try hydrationConversation()]); loader.select("c1")
        await eventually { await fetch.count() == 1 }
        loader.observe([try hydrationConversation(slim: nil, title: "New full event", full: true)], changedIDs: ["c1"])
        await fetch.succeed(0, try fullTranscript("old result")); for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(applied.isEmpty); XCTAssertTrue(loader.states.isEmpty)
    }
    @MainActor func testTurnDeltaInvalidatesEvenWithSameUpdatedAtWithoutRefetchLoop() async throws {
        let fetch = ControlledTranscriptFetch(), value = try hydrationConversation(); let loader = make(fetch)
        var applied: [Conversation] = []; loader.onHydrated = { applied.append($0) }
        loader.observe([value]); loader.select("c1"); await eventually { await fetch.count() == 1 }
        loader.observe([value], changedIDs: ["c1"], requestSelected: false)
        await fetch.succeed(0, try fullTranscript("older than delta"))
        await eventually { if case .failed = loader.states["c1"] { return true }; return false }
        for _ in 0..<10 { loader.observe([value], changedIDs: ["c1"], requestSelected: false) }
        let count = await fetch.count(); XCTAssertEqual(count, 1); XCTAssertTrue(applied.isEmpty)
        loader.retry("c1"); await eventually { await fetch.count() == 2 }
        await fetch.succeed(1, try fullTranscript("latest")); await eventually { applied.count == 1 }
        XCTAssertEqual(applied.first?.turns.first?.items.first?.raw["command"].string, "latest")
    }
    @MainActor func testRefreshAndReconnectCoalesceToNewestSnapshotRevision() async throws {
        let fetch = ControlledTranscriptFetch(), value = try hydrationConversation(); let loader = make(fetch)
        var applied: [Conversation] = []; loader.onHydrated = { applied.append($0) }
        loader.observe([value]); loader.select("c1"); await eventually { await fetch.count() == 1 }
        for _ in 0..<4 { loader.observe([value], snapshotReplacement: true) }
        await fetch.succeed(0, try fullTranscript("old snapshot")); await eventually { await fetch.count() == 2 }
        XCTAssertTrue(applied.isEmpty)
        await fetch.succeed(1, try fullTranscript("newest snapshot")); await eventually { applied.count == 1 }
        let count = await fetch.count(); XCTAssertEqual(count, 2)
        XCTAssertEqual(applied.first?.turns.first?.items.first?.raw["command"].string, "newest snapshot")
    }
    @MainActor func testCompletedHydrationReloadsAfterFreshSlimSnapshot() async throws {
        let fetch = ControlledTranscriptFetch(), value = try hydrationConversation(); let loader = make(fetch)
        var applied: [Conversation] = []; loader.onHydrated = { applied.append($0) }
        loader.observe([value]); loader.select("c1"); await eventually { await fetch.count() == 1 }
        await fetch.succeed(0, try fullTranscript()); await eventually { applied.count == 1 }
        loader.observe([value], snapshotReplacement: true); await eventually { await fetch.count() == 2 }
        await fetch.succeed(1, try fullTranscript("refreshed")); await eventually { applied.count == 2 }
    }
    @MainActor func testNavigationAwayAndBackRejectsOriginalRequest() async throws {
        let fetch = ControlledTranscriptFetch(); let loader = make(fetch); var applied: [Conversation] = []
        loader.onHydrated = { applied.append($0) }; loader.observe([try hydrationConversation()]); loader.select("c1")
        await eventually { await fetch.count() == 1 }; loader.select(nil); loader.select("c1")
        await eventually { await fetch.count() == 2 }; await fetch.succeed(0, try fullTranscript("before navigation"))
        for _ in 0..<20 { await Task.yield() }; XCTAssertTrue(applied.isEmpty)
        await fetch.succeed(1, try fullTranscript("after navigation")); await eventually { applied.count == 1 }
        XCTAssertEqual(applied.first?.turns.first?.items.first?.raw["command"].string, "after navigation")
    }
    @MainActor func testAccountResetAndSameConversationIDRejectOldResponse() async throws {
        let fetch = ControlledTranscriptFetch(); let loader = make(fetch); var applied: [Conversation] = []
        loader.onHydrated = { applied.append($0) }; loader.observe([try hydrationConversation(title: "Account A")]); loader.select("c1")
        await eventually { await fetch.count() == 1 }; loader.reset()
        loader.observe([try hydrationConversation(title: "Account B")]); loader.select("c1")
        await eventually { await fetch.count() == 2 }; await fetch.succeed(0, try fullTranscript("account A output"))
        for _ in 0..<20 { await Task.yield() }; XCTAssertTrue(applied.isEmpty)
        await fetch.succeed(1, try fullTranscript("account B output")); await eventually { applied.count == 1 }
        XCTAssertEqual(applied.first?.title, "Account B")
    }
    @MainActor func testDeletionDoesNotResurrectConversation() async throws {
        let fetch = ControlledTranscriptFetch(); let loader = make(fetch); var applied = false
        loader.onHydrated = { _ in applied = true }; loader.observe([try hydrationConversation()]); loader.select("c1")
        await eventually { await fetch.count() == 1 }; loader.observe([], snapshotReplacement: true)
        await fetch.succeed(0, try fullTranscript()); for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(applied); XCTAssertTrue(loader.states.isEmpty)
    }
    @MainActor func testResyncBarrierDiscardsResponseUntilNewBaselineOrRetry() async throws {
        let fetch = ControlledTranscriptFetch(), value = try hydrationConversation(); let loader = make(fetch)
        var applied = false; loader.onHydrated = { _ in applied = true }; loader.observe([value]); loader.select("c1")
        await eventually { await fetch.count() == 1 }; loader.invalidateSource()
        await fetch.succeed(0, try fullTranscript()); await eventually { if case .failed = loader.states["c1"] { return true }; return false }
        XCTAssertFalse(applied); let count = await fetch.count(); XCTAssertEqual(count, 1)
        loader.observe([value], snapshotReplacement: true); await eventually { await fetch.count() == 2 }
        await fetch.succeed(1, try fullTranscript()); await eventually { applied }
    }
    @MainActor func testStaleFailureCannotAffectNewSession() async throws {
        let fetch = ControlledTranscriptFetch(); let loader = make(fetch); var failures = 0
        loader.onFailure = { _ in failures += 1 }; loader.observe([try hydrationConversation()]); loader.select("c1")
        await eventually { await fetch.count() == 1 }; loader.reset(); await fetch.fail(0)
        for _ in 0..<20 { await Task.yield() }; XCTAssertEqual(failures, 0); XCTAssertTrue(loader.states.isEmpty)
    }
    @MainActor func testExact1024And1025UTF16CommandLengthsRemainComplete() async throws {
        for length in [1024, 1025] {
            let command = String(repeating: "x", count: length - 1) + "§"
            let fetch = ControlledTranscriptFetch()
            let subject = make(fetch); var applied: Conversation?
            subject.onHydrated = { applied = $0 }; subject.observe([try hydrationConversation()]); subject.select("c1")
            await eventually { await fetch.count() == 1 }; await fetch.succeed(0, try fullTranscript(command))
            await eventually { applied != nil }
            let result = applied?.turns.first?.items.first?.raw["aggregatedOutput"].string
            XCTAssertEqual(result, command); XCTAssertEqual(result?.utf16.count, length)
        }
    }
    @MainActor func testMalformedRPCReplyRemainsVisibleAndDoesNotAutoRetry() async throws {
        let transport = TranscriptErrorTransport(body: "{\"ok\":true,\"value\":{\"turns\":\"not-an-array\"}}")
        let rpc = try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "tab", session: HydrationRPCSession(), transport: transport)
        let service = RemoteClaudexService(rpc: rpc)
        let loader = ConversationHydrator(fetch: { id in try await service.conversationTurns(id) })
        let value = try hydrationConversation(); var applied = false
        loader.onHydrated = { _ in applied = true }; loader.observe([value]); loader.select("c1")
        await eventually { if case .failed = loader.states["c1"] { return true }; return false }
        for _ in 0..<10 { loader.observe([value]) }
        let count = await transport.count; XCTAssertEqual(count, 1); XCTAssertFalse(applied)
    }
    @MainActor func testHydratedReducerStateSurvivesNextTurnEvent() async throws {
        let fetch = ControlledTranscriptFetch(), conversation = try hydrationConversation()
        let loader = make(fetch)
        var reducer = StreamReducer(snapshot: try hydrationSnapshot(conversation))
        var applied = false
        loader.onHydrated = { full in
            var state = reducer.snapshot!; state.conversations[0] = full; reducer.replace(state); applied = true
        }
        loader.observe([conversation]); loader.select("c1")
        await eventually { await fetch.count() == 1 }; await fetch.succeed(0, try fullTranscript())
        await eventually { applied }
        var turnFields = try JSONValue.encode(transcriptTurn(full: true, text: "new second turn")).object!
        turnFields["id"] = .string("turn-2")
        _ = try reducer.apply(.object(["t": .string("event"), "seq": .number(1), "event": .object([
            "type": .string("conversation-turn"), "conversationId": .string("c1"), "turn": .object(turnFields)])]))
        XCTAssertNil(reducer.snapshot?.conversations.first?.slim)
        XCTAssertEqual(reducer.snapshot?.conversations.first?.turns.count, 2)
        XCTAssertEqual(reducer.snapshot?.conversations.first?.turns.first?.items.first?.raw["command"].string, longCommand)
        XCTAssertNotNil(reducer.snapshot?.conversations.first?.savedBranches)
    }
    @MainActor func testUnrelatedConversationEventDoesNotInvalidateSelectedHydration() async throws {
        let fetch = ControlledTranscriptFetch(), first = try hydrationConversation(), second = try hydrationConversation(id: "c2", slim: nil)
        let loader = make(fetch); var applied: Conversation?
        loader.onHydrated = { applied = $0 }; loader.observe([first, second]); loader.select("c1")
        await eventually { await fetch.count() == 1 }; loader.observe([first, second], changedIDs: ["c2"])
        await fetch.succeed(0, try fullTranscript(branches: false)); await eventually { applied != nil }
        XCTAssertNil(applied?.savedBranches)
    }
}

private actor HydrationRPCTransport: HTTPTransport {
    var request: URLRequest?
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        self.request = request
        let body: JSONValue = .object(["ok": .bool(true), "value": try .encode(fullTranscript())])
        return (try JSONEncoder().encode(body), 200)
    }
}
private actor HydrationRPCSession: SessionProvider {
    func accessToken() async throws -> String { "test-access" }
    func eventsTicket(tabID: String) async throws -> String { String(repeating: "a", count: 43) }
    func signOut() async throws {}
}
private actor TranscriptErrorTransport: HTTPTransport {
    let body: String
    var count = 0
    init(body: String) { self.body = body }
    func execute(_ request: URLRequest) async throws -> (Data, Int) { count += 1; return (Data(body.utf8), 200) }
}
final class ConversationTurnsRPCTests: XCTestCase {
    func testConversationTurnsPreservesServerTooLargeErrorWithoutRetry() async throws {
        let transport = TranscriptErrorTransport(body: "{\"ok\":false,\"error\":{\"message\":\"Transcript exceeds runner limit\",\"code\":\"CLAUDEX_WEB_TOO_LARGE\"}}")
        let rpc = try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "tab", session: HydrationRPCSession(), transport: transport)
        do { _ = try await RemoteClaudexService(rpc: rpc).conversationTurns("c1"); XCTFail("Expected server refusal") }
        catch { XCTAssertEqual(error as? ServiceError, .server("Transcript exceeds runner limit", "CLAUDEX_WEB_TOO_LARGE")) }
        let count = await transport.count; XCTAssertEqual(count, 1)
    }
    func testConversationTurnsUsesExactVerifiedMethodArgsAndPayload() async throws {
        let transport = HydrationRPCTransport()
        let rpc = try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "tab-id", session: HydrationRPCSession(), transport: transport)
        let payload = try await RemoteClaudexService(rpc: rpc).conversationTurns("selected-conversation")
        let request = await transport.request
        XCTAssertEqual(request?.url?.path, "/api/v1/claudex/web/rpc/conversationTurns")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: request!.httpBody!), .object(["args": .array([.string("selected-conversation")])]))
        XCTAssertEqual(payload.turns.first?.items.first?.raw["aggregatedOutput"].string, longCommand)
        XCTAssertNotNil(payload.savedBranches)
    }
}
