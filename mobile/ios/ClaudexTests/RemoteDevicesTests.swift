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

private actor DeviceTestSession: SessionProvider {
    func accessToken() async throws -> String { "test-only-token" }
    func eventsTicket(tabID: String) async throws -> String { "test-only-ticket" }
    func signOut() async throws {}
}
private actor DeviceTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let response: String
    let status: Int
    init(response: String, status: Int = 200) { self.response = response; self.status = status }
    func execute(_ request: URLRequest) async throws -> (Data, Int) { requests.append(request); return (Data(response.utf8), status) }
    func last() -> URLRequest? { requests.last }
}

private func json(_ text: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }
private let turnOne = #"{"id":"t1","prompt":"fix it","attachments":[],"items":[],"status":"completed","createdAt":0}"#
private let conversationOne = #"{"id":"c1","title":"Fix the build","mode":"code","cwd":"/Users/me/Claudex","providerId":"p1","model":"gpt-5.5","pinned":false,"archived":false,"createdAt":0,"updatedAt":1,"turns":["# + turnOne + #"]}"#

final class RemoteDevicesTests: XCTestCase {
  override func setUp() { CoreTextForTests.install() }
    private func state() throws -> DeviceConversationState {
        DeviceConversationState(deviceID: "pc-0123456789", conversation: try json(conversationOne).decode(Conversation.self), approvals: [])
    }

    func testTurnEventsAppendAndReplaceTheLastTurnAndPatchFields() throws {
        var s = try state()
        XCTAssertFalse(s.running)
        let running = #"{"type":"conversation-turn","conversationId":"c1","turn":{"id":"t2","prompt":"run tests","attachments":[],"items":[],"status":"inProgress","createdAt":2},"conversation":{"title":"Run the tests","updatedAt":2}}"#
        XCTAssertTrue(s.apply(json(running)))
        XCTAssertEqual(s.conversation.turns.map(\.id), ["t1", "t2"])
        XCTAssertEqual(s.conversation.title, "Run the tests")
        XCTAssertTrue(s.running)
        let done = running.replacingOccurrences(of: "inProgress", with: "completed")
        XCTAssertTrue(s.apply(json(done)))
        XCTAssertEqual(s.conversation.turns.count, 2)
        XCTAssertFalse(s.running)
        // Another conversation's turn changes nothing.
        XCTAssertFalse(s.apply(json(running.replacingOccurrences(of: #""conversationId":"c1""#, with: #""conversationId":"c2""#))))
    }

    func testWholeConversationAndApprovals() throws {
        var s = try state()
        let replaced = conversationOne.replacingOccurrences(of: "Fix the build", with: "Edited")
        XCTAssertTrue(s.apply(json(#"{"type":"conversation","conversation":"# + replaced + "}")))
        XCTAssertEqual(s.conversation.title, "Edited")
        let approval = #"{"type":"approval","approval":{"id":7,"conversationId":"c1","method":"item/commandExecution/requestApproval","params":{"command":"npm test"}}}"#
        XCTAssertTrue(s.apply(json(approval)))
        XCTAssertTrue(s.apply(json(approval)))
        XCTAssertEqual(s.approvals.count, 1)
        XCTAssertFalse(s.apply(json(approval.replacingOccurrences(of: #""conversationId":"c1""#, with: #""conversationId":"c9""#))))
        XCTAssertTrue(s.apply(json(#"{"type":"approval-resolved","id":7}"#)))
        XCTAssertTrue(s.approvals.isEmpty)
        XCTAssertFalse(s.apply(json(#"{"type":"approval-resolved","id":7}"#)))
    }

    func testStreamFrames() {
        XCTAssertEqual(DeviceStreamEvent(frame: json(#"{"t":"event","seq":3,"event":{"type":"devices-changed"}}"#)), .devicesChanged)
        let device = DeviceStreamEvent(frame: json(#"{"t":"event","seq":4,"event":{"type":"device-event","deviceId":"pc-0123456789","event":{"type":"device-conversations"}}}"#))
        XCTAssertEqual(device, .device(id: "pc-0123456789", event: json(#"{"type":"device-conversations"}"#)))
        XCTAssertNil(DeviceStreamEvent(frame: json(#"{"t":"event","seq":5,"event":{"type":"conversation"}}"#)))
        XCTAssertNil(DeviceStreamEvent(frame: json(#"{"t":"event","seq":6,"event":{"type":"device-event","event":{"type":"x"}}}"#)))
    }

    func testSummaryFolderName() {
        let mac = DeviceConversationSummary(id: "c1", title: "t", cwd: "/Users/me/Developer/Claudex", updatedAt: 0, running: false, approvals: 0, model: "m")
        let win = DeviceConversationSummary(id: "c2", title: "t", cwd: #"C:\build\claudex"#, updatedAt: 0, running: false, approvals: 0, model: "m")
        XCTAssertEqual(mac.folderName, "Claudex")
        XCTAssertEqual(win.folderName, "claudex")
        XCTAssertEqual(DeviceInfo(id: "pc-1", name: "Studio", platform: "win32", version: "0.0.9", connectedAt: "").platformName, "Windows")
    }

    func testClientPathsBodiesAndRefusals() async throws {
        let transport = DeviceTransport(response: #"{"ok":true,"value":null}"#)
        let rpc = try RPCClient(baseURL: URL(string: "https://claudex.example")!, tabID: "tab-1", session: DeviceTestSession(), transport: transport)
        let client = DeviceClient(rpc: rpc)
        try await client.send("pc-0123456789", conversationID: "c1", text: "run tests")
        let request = await transport.last()
        XCTAssertEqual(request?.url?.path, "/api/v1/claudex/web/devices/pc-0123456789/rpc/send")
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer test-only-token")
        let body = try JSONDecoder().decode(JSONValue.self, from: request?.httpBody ?? Data())
        XCTAssertEqual(body["args"].array?.first?["conversationId"].string, "c1")
        XCTAssertEqual(body["args"].array?.first?["text"].string, "run tests")
        // An id that is not a device id never reaches the network.
        do { try await client.interrupt("../../rpc", conversationID: "c1"); XCTFail("accepted a bad id") } catch {}

        let offline = DeviceTransport(response: #"{"ok":false,"error":{"code":"CLAUDEX_DEVICE_OFFLINE","message":"This computer is not online."}}"#, status: 404)
        let offlineClient = DeviceClient(rpc: try RPCClient(baseURL: URL(string: "https://claudex.example")!, tabID: "tab-1", session: DeviceTestSession(), transport: offline))
        do { try await offlineClient.interrupt("pc-0123456789", conversationID: "c1"); XCTFail("no error") }
        catch { XCTAssertEqual(error.localizedDescription, "你的电脑目前无法连接。它可能已休眠或离线，唤醒后应会自动重新连接。") }

        let list = DeviceTransport(response: #"{"ok":true,"value":[{"id":"pc-0123456789","name":"Studio","platform":"darwin","version":"0.0.9","connectedAt":"2026-10-06T02:00:00Z"}]}"#)
        let listClient = DeviceClient(rpc: try RPCClient(baseURL: URL(string: "https://claudex.example")!, tabID: "tab-1", session: DeviceTestSession(), transport: list))
        let devices = try await listClient.devices()
        XCTAssertEqual(devices.map(\.name), ["Studio"])
        let listed = await list.last()
        XCTAssertEqual(listed?.url?.path, "/api/v1/claudex/web/devices")
        XCTAssertEqual(listed?.httpMethod, "GET")
    }

    func testDirectoriesNewSessionEndSessionAndModels() async throws {
        let list = DeviceTransport(response: #"{"ok":true,"value":[{"path":"/work/app","name":"app","sessions":2,"default":true},{"path":"/work/site","name":"site","sessions":0,"default":false}]}"#)
        let listClient = DeviceClient(rpc: try RPCClient(baseURL: URL(string: "https://claudex.example")!, tabID: "tab-1", session: DeviceTestSession(), transport: list))
        let directories = try await listClient.directories("pc-0123456789")
        XCTAssertEqual(directories.map(\.path), ["/work/app", "/work/site"])
        XCTAssertEqual(directories.map(\.isDefault), [true, false])
        let listed = await list.last()
        XCTAssertEqual(listed?.url?.path, "/api/v1/claudex/web/devices/pc-0123456789/rpc/listDirectories")

        let made = DeviceTransport(response: #"{"ok":true,"value":{"conversationId":"fresh"}}"#)
        let madeClient = DeviceClient(rpc: try RPCClient(baseURL: URL(string: "https://claudex.example")!, tabID: "tab-1", session: DeviceTestSession(), transport: made))
        let id = try await madeClient.newSession("pc-0123456789", cwd: "/work/app", text: "build it")
        XCTAssertEqual(id, "fresh")
        let request = await made.last()
        XCTAssertEqual(request?.url?.path, "/api/v1/claudex/web/devices/pc-0123456789/rpc/newSession")
        let body = try JSONDecoder().decode(JSONValue.self, from: request?.httpBody ?? Data())
        XCTAssertEqual(body["args"].array?.first?["cwd"].string, "/work/app")
        XCTAssertEqual(body["args"].array?.first?["text"].string, "build it")

        let ended = DeviceTransport(response: #"{"ok":true,"value":null}"#)
        let endedClient = DeviceClient(rpc: try RPCClient(baseURL: URL(string: "https://claudex.example")!, tabID: "tab-1", session: DeviceTestSession(), transport: ended))
        try await endedClient.endSession("pc-0123456789", conversationID: "c1")
        let endRequest = await ended.last()
        XCTAssertEqual(endRequest?.url?.path, "/api/v1/claudex/web/devices/pc-0123456789/rpc/endSession")
        try await endedClient.setModel("pc-0123456789", conversationID: "c1", model: DeviceModelOption(providerId: "p1", id: "gpt-5.5-mini"))
        let modelBody = try JSONDecoder().decode(JSONValue.self, from: await ended.last()?.httpBody ?? Data())
        XCTAssertEqual(modelBody["args"].array?.first?["providerId"].string, "p1")
        XCTAssertEqual(modelBody["args"].array?.first?["model"].string, "gpt-5.5-mini")

        let models = DeviceTransport(response: #"{"ok":true,"value":{"models":[{"providerId":"p1","id":"gpt-5.5"}],"default":{"providerId":"p1","id":"gpt-5.5"}}}"#)
        let modelsClient = DeviceClient(rpc: try RPCClient(baseURL: URL(string: "https://claudex.example")!, tabID: "tab-1", session: DeviceTestSession(), transport: models))
        let offered = try await modelsClient.models("pc-0123456789")
        XCTAssertEqual(offered.models, [DeviceModelOption(providerId: "p1", id: "gpt-5.5")])
        XCTAssertEqual(offered.default, DeviceModelOption(providerId: "p1", id: "gpt-5.5"))

        let refused = DeviceTransport(response: #"{"ok":false,"error":{"code":"CLAUDEX_WEB_ERROR","message":"This folder isn't added for your phone. Add it in Settings on the computer."}}"#, status: 400)
        let refusedClient = DeviceClient(rpc: try RPCClient(baseURL: URL(string: "https://claudex.example")!, tabID: "tab-1", session: DeviceTestSession(), transport: refused))
        do { _ = try await refusedClient.newSession("pc-0123456789", cwd: "/etc", text: "x"); XCTFail("no error") }
        catch { XCTAssertEqual(error.localizedDescription, "这个文件夹还没有为手机添加。请在电脑的设置中添加。") }
    }

    func testCodeStarter() {
        XCTAssertEqual(CodeStarter.suggestions.map(\.id), ["space-invaders", "flashcard-study", "todo-list"])
        XCTAssertEqual(CodeStarter.suggestions.map(\.emoji), ["🎮", "💬", "📝"])
        XCTAssertTrue(CodeStarter.suggestions.allSatisfy { $0.prompt.contains("index.html") })
        let first = CodeStarter.suggestions[0], second = CodeStarter.suggestions[1]
        XCTAssertEqual(CodeStarter.next(current: nil, tapped: first.id), first.id)
        XCTAssertNil(CodeStarter.next(current: first.id, tapped: first.id))
        XCTAssertEqual(CodeStarter.draftAfter("", choice: first.id), first.prompt)
        XCTAssertEqual(CodeStarter.draftAfter(first.prompt, choice: second.id), second.prompt)
        XCTAssertEqual(CodeStarter.draftAfter(second.prompt, choice: CodeStarter.other), "")
        XCTAssertEqual(CodeStarter.draftAfter("my own idea", choice: first.id), "my own idea")
        XCTAssertFalse(CodeStarter.canStart(draft: "build it", choice: nil))
        XCTAssertFalse(CodeStarter.canStart(draft: "  ", choice: CodeStarter.other))
        XCTAssertTrue(CodeStarter.canStart(draft: "build it", choice: CodeStarter.other))
    }
}
