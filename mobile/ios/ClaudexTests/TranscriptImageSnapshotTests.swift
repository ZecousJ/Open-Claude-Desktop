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

final class TranscriptImageSnapshotTests: XCTestCase {
    private func item(_ id: String = "i", type: String = "imageGeneration", path: String = "synthetic/picture.png") -> JSONValue {
        .object(["id": .string(id), "type": .string(type), type == "imageGeneration" ? "savedPath" : "path": .string(path), "unknownFixture": .string("preserve")])
    }
    private func conversation(_ items: [JSONValue]) throws -> Conversation {
        try JSONValue.object(["id": .string("c"), "title": .string("Synthetic"), "mode": .string("chat"), "providerId": .string("p"), "model": .string("m"), "pinned": .bool(false), "archived": .bool(false), "createdAt": .number(1), "updatedAt": .number(1),
          "turns": .array([.object(["id": .string("t"), "prompt": .string("synthetic"), "attachments": .array([]), "items": .array(items), "status": .string("completed"), "createdAt": .number(1)])])]).decode(Conversation.self)
    }
    private func descriptor(_ data: Data = Data("synthetic raster bytes".utf8)) -> JSONValue {
        .object(["digest": .string(UploadDigest.sha256(data)), "mime": .string("image/png"), "bytes": .number(Double(data.count))])
    }
    func testOnlyObservedImageEntriesCanBeQueriedAndAmbiguousIDsAreRejected() throws {
        let current = try conversation([item(), item("v", type: "imageView"), item("text", type: "agentMessage"), item("bad", path: "\u{0000}bad"), item("long", path: String(repeating: "x", count: 2001))])
        XCTAssertEqual(TranscriptImageSnapshots.observations(current).map(\.itemID), ["i", "v"])
        XCTAssertTrue(TranscriptImageSnapshots.observations(try conversation([item(), item()])).isEmpty)
        var missingID = item().object!; missingID.removeValue(forKey: "id")
        XCTAssertTrue(TranscriptImageSnapshots.observations(try conversation([.object(missingID)])).isEmpty)
        var slim = current; slim.slim = true; XCTAssertTrue(TranscriptImageSnapshots.observations(slim).isEmpty)
    }
    func testSnapshotRPCUsesTheActualGenerationAndViewArgumentShapes() async throws {
        let observations = TranscriptImageSnapshots.observations(try conversation([item(), item("v", type: "imageView")]))
        let wire = ImageSnapshotWire(value: descriptor()), remote = try remote(wire)
        for observation in observations { let result = try await remote.transcriptImageSnapshot(observation); XCTAssertNotNil(result) }
        let requests = await wire.requests
        XCTAssertEqual(requests.map { $0.url!.lastPathComponent }, ["imageGenerationSnapshot", "viewedImageSnapshot"])
        let args = try requests.map { try JSONDecoder().decode(JSONValue.self, from: $0.httpBody!)["args"] }
        XCTAssertEqual(args, [.array([.string("synthetic/picture.png")]), .array([.string("c"), .string("synthetic/picture.png")])])
    }
    func testDescriptorRejectsBadDigestSizeAndActiveOrGuessedMIME() throws {
        let observation = TranscriptImageSnapshots.observations(try conversation([item()]))[0]
        for (key, value) in [("digest", JSONValue.string(String(repeating: "A", count: 64))), ("digest", .string("path")), ("bytes", .number(-1)), ("bytes", .number(1.5)), ("bytes", .number(Double(64*1024*1024+1))), ("mime", .string("image/svg+xml")), ("mime", .string("image/gif")), ("mime", .string("image/PNG"))] {
            var fields = descriptor().object!; fields[key] = value
            XCTAssertThrowsError(try TranscriptImageSnapshots.capture(.object(fields), observation: observation))
        }
        XCTAssertThrowsError(try TranscriptImageSnapshots.capture(.null, observation: observation))
    }
    func testPictureLargerThanAnInlineThumbnailIsCaptured() throws {
        let observation = TranscriptImageSnapshots.observations(try conversation([item()]))[0]
        var fields = descriptor().object!; fields["bytes"] = .number(2_573_330)
        XCTAssertEqual(try TranscriptImageSnapshots.capture(.object(fields), observation: observation).file.bytes, 2_573_330)
    }
    func testCanonicalDescriptorAttachesOnlyToItsCurrentItemEvenWithSamePath() throws {
        let current = try conversation([item(), item("other")])
        let observation = TranscriptImageSnapshots.observations(current)[0], captured = try TranscriptImageSnapshots.capture(descriptor(), observation: observation)
        let projected = TranscriptImageSnapshots.applying([captured], to: current)
        XCTAssertEqual(projected.turns[0].items[0].generatedFiles, [captured.file]); XCTAssertTrue(projected.turns[0].items[1].generatedFiles.isEmpty)
        XCTAssertTrue(current.turns[0].items[0].generatedFiles.isEmpty); XCTAssertEqual(projected.turns[0].items[0].raw["unknownFixture"], .string("preserve"))
        XCTAssertEqual(captured.file.path, observation.path); XCTAssertTrue(captured.file.quickLookAllowed); XCTAssertEqual(captured.file.extensionFields["operation"], .string("create"))
    }
    func testChangedRemovedReusedAndForeignItemsCannotRetainCaptureAuthority() throws {
        let current = try conversation([item()]), captured = try TranscriptImageSnapshots.capture(descriptor(), observation: TranscriptImageSnapshots.observations(current)[0])
        for changed in [try conversation([item(path: "different.png")]), try conversation([]), try conversation([item(type: "imageView")])] {
            XCTAssertEqual(TranscriptImageSnapshots.applying([captured], to: changed), changed)
        }
        var raw = item().object!; raw["unknownFixture"] = .string("reused")
        let reused = try conversation([.object(raw)]); XCTAssertEqual(TranscriptImageSnapshots.applying([captured], to: reused), reused)
        var foreign = try JSONValue.encode(current).object!; foreign["id"] = .string("different-account-conversation")
        let foreignConversation = try JSONValue.object(foreign).decode(Conversation.self)
        XCTAssertEqual(TranscriptImageSnapshots.applying([captured], to: foreignConversation), foreignConversation)
    }
    func testExistingGeneratedFilesAreNeverReplacedOrExtendedByDiscovery() throws {
        let current = try conversation([item()]), captured = try TranscriptImageSnapshots.capture(descriptor(), observation: TranscriptImageSnapshots.observations(current)[0])
        var raw = item().object!; raw["generatedFiles"] = .array([try .encode(captured.file)])
        let supplied = try conversation([.object(raw)])
        XCTAssertTrue(TranscriptImageSnapshots.observations(supplied).isEmpty)
        XCTAssertEqual(TranscriptImageSnapshots.applying([captured], to: supplied), supplied)
        raw["generatedFiles"] = .array([.object(["malformed": .bool(true)])])
        XCTAssertTrue(TranscriptImageSnapshots.observations(try conversation([.object(raw)])).isEmpty)
    }
    func testOpenAndExportResolveTheSameCanonicalFileAndRejectChangedClaims() throws {
        let current = try conversation([item()]), captured = try TranscriptImageSnapshots.capture(descriptor(), observation: TranscriptImageSnapshots.observations(current)[0])
        let projected = TranscriptImageSnapshots.applying([captured], to: current), file = captured.file
        let payload: JSONValue = .object(["conversationId": .string("c"), "artifactId": .string("generated:\(file.id):\(file.digest!)"), "sourcePath": .string(file.path), "sourceDigest": .string(file.digest!)])
        XCTAssertEqual(SharedConversationResolver.file(payload, conversation: projected), file)
        XCTAssertTrue(SharedConversationResolver.containsFile(file, conversation: projected)); XCTAssertFalse(SharedConversationResolver.containsFile(file, conversation: current))
        var wrong = payload.object!; wrong["sourcePath"] = .string("different.png")
        XCTAssertNil(SharedConversationResolver.file(.object(wrong), conversation: projected))
    }
    func testDigestCheckedBytesCannotBeSubstitutedAndNilStaysUnavailable() async throws {
        let observation = TranscriptImageSnapshots.observations(try conversation([item()]))[0], data = Data("synthetic only".utf8)
        let file = try TranscriptImageSnapshots.capture(descriptor(data), observation: observation).file
        XCTAssertEqual(try GeneratedFileSafety.decode(data.base64EncodedString(), file: file), data)
        XCTAssertThrowsError(try GeneratedFileSafety.decode(Data("different".utf8).base64EncodedString(), file: file))
        let wire = ImageSnapshotWire(value: .null), remote = try remote(wire)
        let missing = try await remote.transcriptImageSnapshot(observation); XCTAssertNil(missing)
    }
    func testDiscoveryIsBoundedAndKeysAreDeterministicForSourceContent() throws {
        let observed = TranscriptImageSnapshots.observations(try conversation((0..<30).map { item("i\($0)") }))
        XCTAssertEqual(observed.count, 12); XCTAssertEqual(observed.first?.itemID, "i18")
        XCTAssertEqual(observed[0].revisionKey, observed[0].revisionKey)
        let a = try TranscriptImageSnapshots.capture(descriptor(), observation: observed[0]), b = try TranscriptImageSnapshots.capture(descriptor(), observation: observed[1])
        XCTAssertNotEqual(a.file.id, b.file.id)
    }
    func testAccountChangeDuringAuthorizedRPCDropsReturnedDescriptor() async throws {
        let observation = TranscriptImageSnapshots.observations(try conversation([item()]))[0], session = ImageSnapshotSession()
        let wire = ImageSnapshotWire(value: descriptor(), switching: session)
        do { _ = try await remote(wire, session: session).transcriptImageSnapshot(observation); XCTFail("Expected account cancellation") }
        catch is CancellationError {} catch { XCTFail("Wrong error: \(error)") }
    }
    func testLargerDescriptorsRemainCanonicalWithoutBeingInlineEligible() throws {
        let current = try conversation([item()]), observation = TranscriptImageSnapshots.observations(current)[0]
        for size in [2_573_330, 16 * 1024 * 1024, 64 * 1024 * 1024] {
            var value = descriptor().object!; value["bytes"] = .number(Double(size))
            let captured = try TranscriptImageSnapshots.capture(.object(value), observation: observation)
            let projected = TranscriptImageSnapshots.applying([captured], to: current)
            XCTAssertTrue(SharedConversationResolver.containsFile(captured.file, conversation: projected))
            XCTAssertFalse(TranscriptImageSnapshots.inlineEligible(captured.file, budget: 8 * 1024 * 1024))
        }
        XCTAssertEqual(GeneratedFileSafety.maximumBytes, 16 * 1024 * 1024)
    }
    func testInlineAndTotalBudgetsRetainTheirIndependentBoundaries() throws {
        let observation = TranscriptImageSnapshots.observations(try conversation([item()]))[0]
        var value = descriptor().object!; value["bytes"] = .number(Double(2 * 1024 * 1024))
        let file = try TranscriptImageSnapshots.capture(.object(value), observation: observation).file
        XCTAssertTrue(TranscriptImageSnapshots.inlineEligible(file, budget: 8 * 1024 * 1024))
        XCTAssertFalse(TranscriptImageSnapshots.inlineEligible(file, budget: 4 * 1024 * 1024 - 1))
        XCTAssertEqual(TranscriptImageSnapshots.maximumInlineTotalBytes, 8 * 1024 * 1024)
    }
    func testImageLargerThanInlineCapReadsVerifiedBytesThroughExistingDigestRPC() async throws {
        let data = Data(repeating: 0x61, count: 2_573_330)
        let observation = TranscriptImageSnapshots.observations(try conversation([item()]))[0]
        let file = try TranscriptImageSnapshots.capture(descriptor(data), observation: observation).file
        let wire = ImageSnapshotWire(value: .string(data.base64EncodedString()))
        let bytes = try await remote(wire).generatedFileData(file)
        XCTAssertEqual(bytes, data)
        let requests = await wire.requests
        XCTAssertEqual(requests.map { $0.url!.lastPathComponent }, ["readGeneratedFile"])
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: requests[0].httpBody!)["args"], .array([.string(file.digest!)]))
    }
    func testDescriptorAboveExistingReadLimitFailsClearlyBeforeAnyFileRPC() async throws {
        let observation = TranscriptImageSnapshots.observations(try conversation([item()]))[0]
        var value = descriptor().object!; value["bytes"] = .number(Double(16 * 1024 * 1024 + 1))
        let file = try TranscriptImageSnapshots.capture(.object(value), observation: observation).file
        let wire = ImageSnapshotWire(value: .null)
        do { _ = try await remote(wire).generatedFileData(file); XCTFail("Expected retained read cap") }
        catch let error as ServiceError {
            guard case .server(_, "GENERATED_FILE_READ_LIMIT") = error else { XCTFail("Missing actionable read-limit error"); return }
        }
        let requests = await wire.requests; XCTAssertTrue(requests.isEmpty)
    }
    private func remote(_ wire: ImageSnapshotWire, session: ImageSnapshotSession = ImageSnapshotSession()) throws -> RemoteClaudexService {
        RemoteClaudexService(rpc: try RPCClient(baseURL: URL(string: "https://synthetic.invalid")!, tabID: "synthetic-image", session: session, transport: wire))
    }
}
private actor ImageSnapshotSession: SessionProvider {
    private var generation = 1
    func sessionGeneration() async -> Int? { generation }
    func changeAccount() { generation += 1 }
    func accessToken() async throws -> String { "SYNTHETIC_NO_NETWORK" }
    func eventsTicket(tabID: String) async throws -> String { throw ServiceError.invalidResponse }
    func signOut() async throws {}
}
private actor ImageSnapshotWire: HTTPTransport {
    let value: JSONValue
    let switching: ImageSnapshotSession?
    private(set) var requests: [URLRequest] = []
    init(value: JSONValue, switching: ImageSnapshotSession? = nil) { self.value = value; self.switching = switching }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        requests.append(request)
        if let switching { await switching.changeAccount() }
        return (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": value])), 200)
    }
}
