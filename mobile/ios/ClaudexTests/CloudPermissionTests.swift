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

final class CloudPermissionTests: XCTestCase {
    private func json(_ source: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(source.utf8)) }
    private func settings(_ extra: [String: JSONValue] = [:]) throws -> Settings {
        var fields: [String: JSONValue] = ["codeSandbox": .string("workspace-write"), "autoAcceptEdits": .bool(false), "codePlanMode": .bool(false), "allowBypassPermissions": .bool(true), "bypassFolders": .array([.string("*")]), "futureSetting": .object(["preserve": .bool(true)])]
        fields.merge(extra, uniquingKeysWith: { _, new in new }); return try JSONValue.object(fields).decode(Settings.self)
    }
    private func host(_ modes: [JSONValue]) -> JSONValue { .object(["capabilities": .object(["cloudCode": .bool(true)]), "cloud": .object(["permissionModes": .array(modes)])]) }
    private var allModes: JSONValue { host(CloudPermissionMode.allCases.map { .string($0.rawValue) }) }
    func testServerChoicesPreserveOrderDeduplicateAndDoNotInventBypass() throws {
        let form = CloudPermissionForm(host: host([.string("plan"), .string("manual"), .string("plan")]), settings: try settings(), loading: false, changing: false)
        XCTAssertEqual(form.modes, [.plan,.manual]); XCTAssertEqual(form.availability,.ready); XCTAssertFalse(form.canSelect(.bypass)); XCTAssertFalse(form.canSelect(.auto))
        let offered = CloudPermissionForm(host: host([.string("bypass"), .string("auto")]), settings: try settings(), loading:false,changing:false)
        XCTAssertEqual(offered.modes,[.bypass,.auto]); XCTAssertTrue(offered.canSelect(.bypass))
    }
    func testUnavailableLoadingInvalidAndChangingAllRejectSelection() throws {
        let current = try settings()
        let cases: [(JSONValue?,Bool,Bool,CloudPermissionAvailability)] = [
            (nil,false,false,.unavailable), (host([]),false,false,.unavailable),
            (.object(["capabilities":.object(["cloudCode":.bool(false)]),"cloud":.object(["permissionModes":.array([.string("bypass")])])]),false,false,.unavailable),
            (allModes,true,false,.loading),(allModes,false,true,.changing),
            (host([.string("future"),.number(1)]),false,false,.invalid),
            (.object(["capabilities":.object(["cloudCode":.bool(true)]),"cloud":.object(["permissionModes":.string("bypass")])]),false,false,.invalid)]
        for (value,loading,changing,state) in cases {
            let form = CloudPermissionForm(host:value,settings:current,loading:loading,changing:changing)
            XCTAssertEqual(form.availability,state); XCTAssertFalse(form.canSelect(.bypass))
            XCTAssertThrowsError(try CloudPermissionContract.selecting(.bypass,host:value,settings:current,loading:loading,changing:changing,confirmed:true))
        }
    }
    func testUnknownModesAndMalformedSettingsNeverBecomeWriteDefaults() throws {
        let form = CloudPermissionForm(host:host([.string("manual"),.string("futureMode"),.number(7)]),settings:try settings(),loading:false,changing:false)
        XCTAssertEqual(form.modes,[.manual]); XCTAssertTrue(form.hasUnsupportedEntries); XCTAssertFalse(form.canSelect(.auto))
        for invalid in [try settings(["codeSandbox":.string("future-sandbox")]),try settings(["codeSandbox":.null]),try settings(["autoAcceptEdits":.string("false")]),try settings(["codePlanMode":.bool(true)])] {
            XCTAssertNil(CloudPermissionContract.selected(invalid))
            XCTAssertEqual(CloudPermissionForm(host:allModes,settings:invalid,loading:false,changing:false).availability,.invalid)
            XCTAssertThrowsError(try CloudPermissionContract.selecting(.auto,host:allModes,settings:invalid))
        }
    }
    func testBypassRequiresServerOfferExplicitConfirmationAndExistingUserSetting() throws {
        let original = try settings()
        XCTAssertThrowsError(try CloudPermissionContract.selecting(.bypass,host:allModes,settings:original))
        XCTAssertThrowsError(try CloudPermissionContract.selecting(.bypass,host:host([.string("auto")]),settings:original,confirmed:true))
        let disabled = try settings(["allowBypassPermissions":.bool(false)])
        let form = CloudPermissionForm(host:allModes,settings:disabled,loading:false,changing:false)
        XCTAssertTrue(form.modes.contains(.bypass)); XCTAssertTrue(form.bypassDisabled); XCTAssertFalse(form.canSelect(.bypass)); XCTAssertTrue(form.canSelect(.manual))
        XCTAssertThrowsError(try CloudPermissionContract.selecting(.bypass,host:allModes,settings:disabled,confirmed:true))
        XCTAssertEqual(disabled.raw["allowBypassPermissions"],.bool(false))
    }
    func testModePatchesMatchCloudContractAndPreserveAllUnrelatedSettings() throws {
        let original = try settings()
        let expected: [(CloudPermissionMode,String,Bool,Bool)] = [(.auto,"workspace-write",false,false),(.manual,"read-only",false,false),(.acceptEdits,"workspace-write",true,false),(.plan,"read-only",false,true),(.bypass,"danger-full-access",false,false)]
        for (mode,sandbox,edits,plan) in expected {
            let saved = try CloudPermissionContract.selecting(mode,host:allModes,settings:original,confirmed:mode == .bypass)
            XCTAssertEqual(saved.raw["codeSandbox"],.string(sandbox)); XCTAssertEqual(saved.raw["autoAcceptEdits"],.bool(edits)); XCTAssertEqual(saved.raw["codePlanMode"],.bool(plan))
            XCTAssertEqual(CloudPermissionContract.selected(saved),mode)
            for key in ["allowBypassPermissions","bypassFolders","futureSetting"] { XCTAssertEqual(saved.raw[key],original.raw[key]) }
        }
        XCTAssertEqual(CloudPermissionContract.selected(original),.auto) // Pure construction never changes defaults.
    }
    func testCurrentModeOutsideOfferedListIsRetainedWithoutAutomaticFallback() throws {
        let saved = try settings(["codeSandbox":.string("danger-full-access")])
        let form = CloudPermissionForm(host:host([.string("manual")]),settings:saved,loading:false,changing:false)
        XCTAssertEqual(form.selected,.bypass); XCTAssertEqual(form.modes,[.manual]); XCTAssertFalse(form.canSelect(.bypass))
        XCTAssertEqual(saved.raw["codeSandbox"],.string("danger-full-access"))
    }
    func testModeChangeRPCUsesExistingSaveSettingsAndHonorsReturnedMode() async throws {
        let desired = try CloudPermissionContract.selecting(.bypass,host:allModes,settings:settings(),confirmed:true)
        let transport = PermissionTransport(response:try JSONValue.encode(desired)), remote = try makeRemote(transport)
        let result = try await remote.saveSettings(desired)
        XCTAssertEqual(CloudPermissionContract.selected(result),.bypass)
        let requests = await transport.requests; XCTAssertEqual(requests.count,1); XCTAssertEqual(requests[0].url?.path,"/api/v1/claudex/web/rpc/saveSettings")
        let body = try JSONDecoder().decode(JSONValue.self,from:requests[0].httpBody!)
        XCTAssertEqual(body["args"],.array([try JSONValue.encode(desired)])); XCTAssertEqual(body["args"].array?.first?["allowBypassPermissions"],.bool(true))
        let refused = PermissionTransport(response:try JSONValue.encode(settings()))
        let returned = try await makeRemote(refused).saveSettings(desired)
        XCTAssertEqual(CloudPermissionContract.selected(returned),.auto) // Never represent a requested mode as an acknowledgement.
    }
    func testServerRefusalIsNotRetriedOrConvertedToSuccess() async throws {
        let transport = PermissionTransport(response:.null,refusal:true), remote = try makeRemote(transport)
        let desired = try CloudPermissionContract.selecting(.manual,host:allModes,settings:settings())
        do { _ = try await remote.saveSettings(desired); XCTFail("Expected server refusal") }
        catch { XCTAssertEqual(error as? ServiceError,.server("Permission mode refused","POLICY")) }
        let count = await transport.requests.count; XCTAssertEqual(count,1)
    }
    func testAccountSwitchDuringSaveCancelsReturnedPermissionChange() async throws {
        let session = PermissionSession(), desired = try CloudPermissionContract.selecting(.plan,host:allModes,settings:settings())
        let transport = PermissionTransport(response:try JSONValue.encode(desired),switching:session)
        do { _ = try await makeRemote(transport,session:session).saveSettings(desired); XCTFail("Expected cancellation") }
        catch is CancellationError {} catch { XCTFail("Unexpected error") }
        let count = await transport.requests.count; XCTAssertEqual(count,1)
    }
}
private actor PermissionSession: SessionProvider {
    var generation = 1
    func accessToken() async throws -> String { "synthetic-token" }
    func sessionGeneration() async -> Int? { generation }
    func change() { generation += 1 }
    func eventsTicket(tabID:String) async throws -> String { "synthetic-ticket" }
    func signOut() async throws {}
}
private actor PermissionTransport: HTTPTransport {
    let response: JSONValue, refusal: Bool, switching: PermissionSession?
    var requests: [URLRequest] = []
    init(response:JSONValue,refusal:Bool = false,switching:PermissionSession? = nil) { self.response=response;self.refusal=refusal;self.switching=switching }
    func execute(_ request:URLRequest) async throws -> (Data,Int) {
        requests.append(request); await switching?.change()
        let envelope: JSONValue = refusal ? .object(["ok":.bool(false),"error":.object(["message":.string("Permission mode refused"),"code":.string("POLICY")])]) : .object(["ok":.bool(true),"value":response])
        return (try JSONEncoder().encode(envelope),refusal ? 403 : 200)
    }
}
private func makeRemote(_ transport:PermissionTransport,session:PermissionSession = PermissionSession()) throws -> RemoteClaudexService {
    RemoteClaudexService(rpc:try RPCClient(baseURL:URL(string:"https://fixture.test")!,tabID:"fixture",session:session,transport:transport))
}
