import Foundation
import XCTest
#if canImport(UIKit) && !SWIFT_PACKAGE
import UIKit
#endif
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
    func testTextAttachmentValidation() throws {
        XCTAssertNoThrow(try AttachmentLimits.validate(name: "first.TXT", data: Data("valid 文本".utf8)))
        XCTAssertNoThrow(try AttachmentLimits.validate(name: "boundary.md", data: Data(repeating: 65, count: AttachmentLimits.textMaximum)))
        XCTAssertThrowsError(try AttachmentLimits.validate(name: "large.txt", data: Data(repeating: 65, count: AttachmentLimits.textMaximum + 1)))
        XCTAssertThrowsError(try AttachmentLimits.validate(name: "nul.csv", data: Data([65, 0, 66])))
        XCTAssertThrowsError(try AttachmentLimits.validate(name: "bad.txt", data: Data([255])))
        XCTAssertNoThrow(try AttachmentLimits.validate(name: "document.pdf", data: Data([0, 255])))
    }

    #if canImport(ImageIO)
    func testImageAttachmentValidation() throws {
        let images: [(String, String)] = [
            ("png", "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAE0lEQVR4nGP8z0AYMBGhZpgrAgAwUAEPZ+AT8AAAAABJRU5ErkJggg=="),
            ("jpg", "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAwDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z"),
            ("gif", "R0lGODdhDAAIAIEAAP8AAAAAAAAAAAAAACwAAAAADAAIAAAIEgABCBxIsKDBgwgTKlzIsGHBgAA7"),
            ("webp", "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoMAAgAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=")
        ]
        for (suffix, encoded) in images {
            let data = try XCTUnwrap(Data(base64Encoded: encoded))
            XCTAssertNoThrow(try AttachmentLimits.validate(name: "image." + suffix, data: data))
            XCTAssertThrowsError(try AttachmentLimits.validate(name: "image." + suffix, data: data.prefix(12)))
        }
        XCTAssertThrowsError(try AttachmentLimits.validate(name: "large.png", data: Data(repeating: 0, count: AttachmentLimits.imageMaximum + 1)))
    }
    #endif

    #if canImport(UIKit) && !SWIFT_PACKAGE
    @MainActor func testCameraPickerReturnsOrientedJPEG() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 8)).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 12, height: 8))
        }
        let oriented = UIImage(cgImage: try XCTUnwrap(image.cgImage), scale: 1, orientation: .right)
        var captured: Data?
        let coordinator = CameraPicker.Coordinator { captured = $0 }
        coordinator.imagePickerController(UIImagePickerController(), didFinishPickingMediaWithInfo: [.originalImage: oriented])
        let decoded = try XCTUnwrap(UIImage(data: try XCTUnwrap(captured)))
        XCTAssertEqual(decoded.imageOrientation, .right)
        XCTAssertEqual(decoded.size, oriented.size)
    }
    #endif

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

final class KnowledgeBaseTests: XCTestCase {
    func testListIsCheckedAndToggles() throws {
        let data = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"bases":[{"id":"huaner-tech","name":"幻尔科技知识库","description":"手册","available":true},{"id":"Bad Id","name":"x"},{"id":"no-name","name":" "}]}
        """.utf8))
        XCTAssertEqual(KnowledgeBase.list(data), [KnowledgeBase(id: "huaner-tech", name: "幻尔科技知识库", description: "手册", available: true)])
        XCTAssertEqual(KnowledgeBase.toggled([], "huaner-tech"), ["huaner-tech"])
        XCTAssertEqual(KnowledgeBase.toggled(["huaner-tech"], "huaner-tech"), [])
    }
    func testConversationKeepsItsBases() throws {
        var conversation = try JSONDecoder().decode(Conversation.self, from: Data(conversationJSON.utf8))
        XCTAssertEqual(conversation.knowledgeBases, [])
        conversation.extensionFields["knowledgeBases"] = .array([.string("huaner-tech"), .string("../x")])
        XCTAssertEqual(conversation.knowledgeBases, ["huaner-tech"])
        let input = SendInput(text: "hi", mode: .chat, attachments: [], providerId: "p", model: "m", knowledgeBases: ["huaner-tech"])
        let wire = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(input))
        XCTAssertEqual(wire["knowledgeBases"].array?.first?.string, "huaner-tech")
    }
}
