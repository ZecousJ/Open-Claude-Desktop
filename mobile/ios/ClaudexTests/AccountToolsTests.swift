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

final class AccountToolsTests: XCTestCase {
    private func json(_ source: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(source.utf8)) }
    func testComposerToolVisibilityMatchesChatCoworkAndCodeContracts() {
        XCTAssertTrue(ComposerTools.visible(mode: .chat, research: false))
        XCTAssertTrue(ComposerTools.visible(mode: .chat, research: true))
        XCTAssertTrue(ComposerTools.visible(mode: .cowork, research: false))
        XCTAssertFalse(ComposerTools.visible(mode: .cowork, research: true))
        XCTAssertFalse(ComposerTools.visible(mode: .code, research: false))
        XCTAssertFalse(ComposerTools.visible(mode: .code, research: true))
    }
    func testDraftToolFlagsEncodeWithoutChangingExistingConversationDefault() throws {
        let ordinary = SendInput(text: "fixture", mode: .chat, attachments: [], providerId: "p", model: "m")
        XCTAssertEqual(try JSONValue.encode(ordinary)["research"], .null)
        let research = SendInput(text: "fixture", mode: .chat, attachments: [], providerId: "p", model: "m", webSearch: true, research: true)
        XCTAssertEqual(try JSONValue.encode(research)["webSearch"], .bool(true)); XCTAssertEqual(try JSONValue.encode(research)["research"], .bool(true))
    }
    func testAPIKeyReservedNamesMaskingAndNormalization() throws {
        for name in ["", "  ", "claudex-web:fixture", "claudex-device:fixture", "claudex-desktop:fixture", String(repeating: "😀", count: 51)] { XCTAssertThrowsError(try APIKeyContract.validatedName(name)) }
        XCTAssertEqual(try APIKeyContract.validatedName("  My fixture  "), "My fixture")
        let rows = try json(#"[{"id":1,"name":"claudex-device:hidden","key":"fixture"},{"id":2,"name":"Own","key":"synthetic-key-for-tests","group_id":5,"status":"quota_exhausted","created_at":"2026-10-03T02:00:00+01:00"},{"id":3,"name":"Small","key":"tiny","created_at":"2026-10-03T01:30:00+01:00"},{"id":1.2,"name":"invalid","key":"fixture"}]"#).array!
        let keys = APIKeyContract.normalize(rows, groups: [5: "Fixture group"])
        XCTAssertEqual(keys.map(\.id), [2,3]); XCTAssertEqual(keys[0].groupName, "Fixture group"); XCTAssertEqual(keys[0].status, "exhausted")
        XCTAssertFalse(keys[0].masked.contains(keys[0].key)); XCTAssertEqual(keys[1].masked, "••••••••")
    }
    func testUsageFiltersValidateAndMissingValuesStayUnknown() throws {
        let parameters = try UsageRecordQuery(page: 2, start: "2026-10-01", end: "2026-10-03", model: "vendor/m:v1").parameters(timezone: "Asia/Shanghai")
        XCTAssertEqual(parameters["page"], "2"); XCTAssertEqual(parameters["timezone"], "Asia/Shanghai"); XCTAssertEqual(parameters["model"], "vendor/m:v1")
        for query in [UsageRecordQuery(page: 0), UsageRecordQuery(pageSize: 101), UsageRecordQuery(start: "2026-02-30"), UsageRecordQuery(start: "2026-10-04", end: "2026-10-03"), UsageRecordQuery(model: String(repeating: "x", count: 201))] { XCTAssertThrowsError(try query.parameters(timezone: "Etc/UTC")) }
        XCTAssertThrowsError(try UsageRecordQuery().parameters(timezone: "invalid"))
        let page = try UsageRecordPage(json(#"{"items":[{"id":1,"model":"m"},{"id":2,"input_tokens":3,"cache_read_tokens":4,"cache_creation_tokens":5,"actual_cost":0},{"id":0},{"id":"wrong"}],"total":2,"page":2,"pages":3}"#))
        XCTAssertEqual(page.items.count, 2); XCTAssertNil(page.items[0].cost); XCTAssertNil(page.items[0].inputTokens); XCTAssertEqual(page.items[1].cost, 0); XCTAssertEqual(page.items[1].cacheTokens, 9); XCTAssertEqual(page.pages, 3)
    }
    func testNewRESTAllowlistRejectsTraversalWrongMethodsAndUnexpectedQueries() async throws {
        let transport = ToolsTransport(values: []), remote = try makeRemote(transport)
        let direct = DirectServiceClient(rpc: remote.rpc)
        let requests: [(String,String,[String:String],JSONValue?)] = [
            ("api/v1/keys/../auth/me","DELETE",[:],nil), ("api/v1/keys/01","DELETE",[:],nil), ("api/v1/keys/1","GET",[:],nil),
            ("api/v1/keys","POST",[:],.object(["name": .string("claudex-web:reserved"), "group_id": .number(1)])),
            ("api/v1/keys","GET",["page":"1","page_size":"100","user_id":"other"],nil),
            ("api/v1/usage","POST",["page":"1","page_size":"20","timezone":"Etc/UTC"],nil),
            ("api/v1/usage","GET",["page":"1","page_size":"20","timezone":"Etc/UTC","user_id":"other"],nil)]
        for (path,method,query,body) in requests { do { _ = try await direct.request(path, query: query, method: method, body: body); XCTFail("Expected rejection") } catch {} }
        let count = await transport.requests.count; XCTAssertEqual(count,0)
    }
    func testKeyListPagesUseRESTAndFilterDeviceKeys() async throws {
        let transport = ToolsTransport(values: [try json(#"[{"id":5,"name":"Fixture"}]"#), try json(#"{"items":[{"id":1,"name":"claudex-web:hidden","key":"fixture"}],"pages":2}"#), try json(#"{"items":[{"id":2,"name":"Own","key":"synthetic","group_id":5}],"pages":2}"#)])
        let keys = try await makeRemote(transport).apiKeys(); XCTAssertEqual(keys.map(\.id), [2])
        let requests = await transport.requests; XCTAssertEqual(requests.map { $0.url!.path }, ["/api/v1/groups/available","/api/v1/keys","/api/v1/keys"]); XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" })
        let second = URLComponents(url: requests[2].url!, resolvingAgainstBaseURL: false)!; XCTAssertTrue(second.queryItems!.contains(URLQueryItem(name: "page",value:"2")))
    }
    func testKeyCreationValidatesAvailableGroupAndReadsBackExactCreatedID() async throws {
        let groups = try json(#"[{"id":5,"name":"Fixture"}]"#)
        let transport = ToolsTransport(values: [groups, try json(#"{"id":22}"#), groups, try json(#"{"items":[{"id":22,"name":"Own","key":"synthetic"}],"pages":1}"#)])
        let made = try await makeRemote(transport).createAPIKey(name: " Own ", groupID: 5); XCTAssertEqual(made.id,22)
        let requests = await transport.requests; XCTAssertEqual(requests[1].httpMethod,"POST"); XCTAssertEqual(requests[1].url!.path,"/api/v1/keys")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: requests[1].httpBody!), .object(["name": .string("Own"), "group_id": .number(5)]))
        let unavailable = ToolsTransport(values: [groups])
        do { _ = try await makeRemote(unavailable).createAPIKey(name: "Own", groupID: 9); XCTFail("Expected group rejection") } catch {}
        let rejected = await unavailable.requests; XCTAssertEqual(rejected.count,1)
    }
    func testDeviceOrMissingKeyCannotBeDeletedAndOwnKeyDeletesOnce() async throws {
        let groups = try json(#"[]"#), page = try json(#"{"items":[{"id":1,"name":"claudex-device:hidden","key":"fixture"},{"id":2,"name":"Own","key":"synthetic"}],"pages":1}"#)
        for id in [1,3] {
            let transport = ToolsTransport(values:[groups,page]); do { try await makeRemote(transport).deleteAPIKey(id); XCTFail("Expected ownership rejection") } catch {}
            let requests = await transport.requests; XCTAssertFalse(requests.contains { $0.httpMethod == "DELETE" })
        }
        let transport = ToolsTransport(values:[groups,page,.null]); try await makeRemote(transport).deleteAPIKey(2)
        let requests = await transport.requests; XCTAssertEqual(requests.last?.httpMethod,"DELETE"); XCTAssertEqual(requests.last?.url?.path,"/api/v1/keys/2")
    }
    func testAccountChangeBetweenKeyPagesCancelsBeforeLaterPage() async throws {
        let session = ToolsSession(), transport = ToolsTransport(values: [try json(#"[]"#), try json(#"{"items":[],"pages":2}"#)], switching: session, switchOn: 2)
        do { _ = try await makeRemote(transport,session:session).apiKeys(); XCTFail("Expected cancellation") } catch is CancellationError {} catch { XCTFail("Unexpected error") }
        let requests = await transport.requests; XCTAssertEqual(requests.count,2)
    }
    func testUsageRESTAndToolRPCPositionalContractsAndImageSelection() async throws {
        let conversation = try json(#"{"id":"c","title":"Fixture","mode":"chat","providerId":"p","model":"m","createdAt":1,"updatedAt":1,"pinned":false,"archived":false,"turns":[]}"#)
        let groups = try json(#"{"groups":[],"providers":[],"images":{"groupId":8,"models":[{"id":"gpt-image-2.5","name":"Fixture image"}],"selected":"gpt-image-2.5"}}"#)
        let transport = ToolsTransport(values: [try json(#"{"items":[],"page":1,"pages":1,"total":0}"#),conversation,conversation,groups])
        let remote = try makeRemote(transport); _ = try await remote.usageRecords(UsageRecordQuery(model:"vendor/m"),timezone:"Etc/UTC")
        _ = try await remote.setConversationTool("c",enabled:true,research:false,providerID:"p",model:"m")
        _ = try await remote.setConversationTool("c",enabled:true,research:true,providerID:"p",model:"m")
        let images = try await remote.setImageModel("gpt-image-2.5"); XCTAssertEqual(images.images?.selected,"gpt-image-2.5")
        let requests = await transport.requests; XCTAssertEqual(requests[0].url!.path,"/api/v1/usage"); XCTAssertEqual(requests[0].httpMethod,"GET")
        let args = try requests.dropFirst().map { try JSONDecoder().decode(JSONValue.self,from:$0.httpBody!)["args"] }
        XCTAssertEqual(args[0], .array([.string("c"),.bool(true),.string("p"),.string("m")])); XCTAssertEqual(args[1],.array([.string("c"),.bool(true)])); XCTAssertEqual(args[2],.array([.string("gpt-image-2.5")]))
    }
    func testInvalidKeyCreationAndImageModelsNeverSendRequests() async throws {
        let transport = ToolsTransport(values:[]), remote = try makeRemote(transport)
        do { _ = try await remote.createAPIKey(name:"claudex-device:reserved",groupID:1); XCTFail("Expected rejection") } catch {}
        do { _ = try await remote.createAPIKey(name:"Own",groupID:0); XCTFail("Expected rejection") } catch {}
        for model in ["", "bad model", String(repeating:"m",count:201)] { do { _ = try await remote.setImageModel(model); XCTFail("Expected rejection") } catch {} }
        let requests = await transport.requests; XCTAssertTrue(requests.isEmpty)
    }
}
private actor ToolsSession: SessionProvider {
    private var generation = 1
    func accessToken() async throws -> String { "synthetic-token" }
    func sessionGeneration() async -> Int? { generation }
    func switchAccount() { generation += 1 }
    func eventsTicket(tabID:String) async throws -> String { "synthetic-ticket" }
    func signOut() async throws {}
}
private actor ToolsTransport: HTTPTransport {
    var values: [JSONValue]
    var requests: [URLRequest] = []
    let switching: ToolsSession?
    let switchOn: Int?
    init(values:[JSONValue], switching: ToolsSession? = nil, switchOn:Int? = nil) { self.values=values; self.switching=switching; self.switchOn=switchOn }
    func execute(_ request:URLRequest) async throws -> (Data,Int) {
        requests.append(request)
        guard !values.isEmpty else { throw ServiceError.invalidResponse }
        let value=values.removeFirst()
        if requests.count == switchOn { await switching?.switchAccount() }
        let rpc=request.url!.path.contains("/rpc/")
        return (try JSONEncoder().encode(JSONValue.object(rpc ? ["ok":.bool(true),"value":value] : ["code":.number(0),"data":value])),200)
    }
}
private func makeRemote(_ transport:ToolsTransport, session:ToolsSession = ToolsSession()) throws -> RemoteClaudexService {
    RemoteClaudexService(rpc:try RPCClient(baseURL:URL(string:"https://fixture.test")!,tabID:"fixture",session:session,transport:transport))
}
