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

final class NativeFeatureTests: XCTestCase {
    func testStaticArtifactPreviewFormatsAreLimitedAndNormalized() {
        XCTAssertEqual(ArtifactIndex.staticPreviewLanguage(language: "HTML", name: "index.html"), "html")
        XCTAssertEqual(ArtifactIndex.staticPreviewLanguage(language: "text", name: "drawing.SVG"), "svg")
        XCTAssertEqual(ArtifactIndex.staticPreviewLanguage(language: "text", name: "download", mime: "text/html; charset=utf-8"), "html")
        XCTAssertNil(ArtifactIndex.staticPreviewLanguage(language: "javascript", name: "script.html"))
        XCTAssertNil(ArtifactIndex.staticPreviewLanguage(language: "text", name: "report.pdf"))
    }
    func testArtifactIdentityMatchesJavaScriptWithoutEscapingPaths() {
        XCTAssertEqual(ArtifactIndex.identity(["conversation", "/workspace/file.html"]), "[\"conversation\",\"/workspace/file.html\"]")
        XCTAssertEqual(ArtifactIndex.identity(["library", "中文"]), "[\"library\",\"中文\"]")
    }
    func testOnlyAgentMessageFencesBecomeArtifacts() throws {
        let text = "正文\n```html\n<h1>你好</h1>\n```\n```swift\nlet n = 1\n```"
        let item = try JSONValue.object(["id": .string("i1"), "type": .string("agentMessage"), "text": .string(text)]).decode(TranscriptItem.self)
        let conversation = try JSONDecoder().decode(Conversation.self, from: Data("""
        {"id":"c1","title":"标题","mode":"chat","providerId":"p","model":"m","pinned":false,"archived":false,"createdAt":0,"updatedAt":1,"turns":[]}
        """.utf8))
        let artifacts = ArtifactIndex.fencedArtifacts(item, conversation: conversation)
        XCTAssertEqual(artifacts.count, 2); XCTAssertEqual(artifacts[0]["language"].string, "html")
        XCTAssertEqual(artifacts[0]["content"].string, "<h1>你好</h1>\n")
        let tool = try JSONValue.object(["id": .string("i2"), "type": .string("commandExecution"), "text": .string(text)]).decode(TranscriptItem.self)
        XCTAssertTrue(ArtifactIndex.fencedArtifacts(tool, conversation: conversation).isEmpty)
    }
    func testUnreadServerFieldSurvivesHydrationAndRoundTrip() throws {
        var wire = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"id":"synthetic","title":"Fixture","mode":"chat","providerId":"p","model":"m","pinned":false,"archived":false,"createdAt":0,"updatedAt":1,"turns":[],"unread":true,"incognito":false}
        """.utf8))
        let unread = try wire.decode(Conversation.self)
        XCTAssertTrue(unread.unread); XCTAssertFalse(unread.incognito)
        XCTAssertTrue(try JSONValue.encode(unread)["unread"].bool == true)
        var fields = wire.object!; fields.removeValue(forKey: "unread"); wire = .object(fields)
        XCTAssertFalse(try wire.decode(Conversation.self).unread)
    }
    func testIntegerReaderRejectsOverflowAndFractions() {
        XCTAssertNil(JSONValue.number(1e100).integer); XCTAssertNil(JSONValue.number(1.5).integer)
        XCTAssertEqual(JSONValue.number(30).integer, 30)
    }
    func testDirectEndpointsRejectUnknownRouteBeforeNetwork() async throws {
        let transport = FeatureTransport()
        let direct = DirectServiceClient(rpc: try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "tab", session: FeatureSession(), transport: transport))
        do { _ = try await direct.request("https://attacker.test"); XCTFail("Must refuse") } catch { XCTAssertEqual(error as? ServiceError, .invalidResponse) }
        let count = await transport.count; XCTAssertEqual(count, 0)
    }
    func testServiceStatusUsesVerifiedMinutesQueryAndNoBrowserIdentity() async throws {
        let transport = FeatureTransport()
        let direct = DirectServiceClient(rpc: try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "tab", session: FeatureSession(), transport: transport))
        _ = try await direct.request("api/v1/claudex/status", query: ["hours":"24", "step":"10"])
        let request = await transport.last
        XCTAssertEqual(request?.url?.absoluteString, "https://service.test/api/v1/claudex/status?hours=24&step=10")
        XCTAssertNil(request?.value(forHTTPHeaderField: "X-Claudex-Client")); XCTAssertNil(request?.value(forHTTPHeaderField: "Origin"))
    }
}
private actor FeatureSession: SessionProvider {
    func accessToken() async throws -> String { "test-access" }
    func eventsTicket(tabID: String) async throws -> String { String(repeating:"a", count:43) }
    func signOut() async throws {}
}
private actor FeatureTransport: HTTPTransport {
    var last: URLRequest?
    var count = 0
    func execute(_ request: URLRequest) async throws -> (Data, Int) { count += 1; last = request; return (Data("{\"code\":0,\"data\":{}}".utf8),200) }
}
