#if !SWIFT_PACKAGE
import XCTest
import SwiftUI
import WebKit
@testable import Claudex

private struct UXSession: SessionProvider {
    func accessToken() async throws -> String { "SYNTHETIC_NO_NETWORK" }
    func eventsTicket(tabID: String) async throws -> String { throw ServiceError.invalidResponse }
    func signOut() async throws {}
}
private actor UXWire: HTTPTransport {
    private var pending: CheckedContinuation<(Data, Int), Error>?
    private var pendingSettings: CheckedContinuation<(Data, Int), Error>?
    private var settingsResponse: Data?
    private let holdSettings: Bool
    private(set) var sends = 0
    private(set) var settingsSaves = 0
    init(holdSettings: Bool = false) { self.holdSettings = holdSettings }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        switch request.url?.lastPathComponent {
        case "send":
            sends += 1
            return try await withCheckedThrowingContinuation { pending = $0 }
        case "saveSettings":
            let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
            let data = try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": body["args"].array![0]]))
            settingsSaves += 1
            if holdSettings {
                settingsResponse = data
                return try await withCheckedThrowingContinuation { pendingSettings = $0 }
            }
            return (data, 200)
        default: throw ServiceError.invalidResponse
        }
    }
    func finish(_ conversation: Conversation?, fail: Bool = false) throws {
        guard let pending else { throw ServiceError.invalidResponse }
        self.pending = nil
        if fail { pending.resume(throwing: ServiceError.server("SYNTHETIC_SEND_FAILURE", nil)) }
        else { pending.resume(returning: (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": .encode(conversation!)])), 200)) }
    }
    func finishSettings() throws {
        guard let pendingSettings, let settingsResponse else { throw ServiceError.invalidResponse }
        self.pendingSettings = nil; self.settingsResponse = nil
        pendingSettings.resume(returning: (settingsResponse, 200))
    }
}
@MainActor
final class NativeConversationUXTests: XCTestCase {
    private func fixture(holdSettings: Bool = false) async throws -> (AppStore, UXWire, Conversation) {
        let wire = UXWire(holdSettings: holdSettings)
        let rpc = try RPCClient(baseURL: URL(string: "https://synthetic.invalid")!, tabID: "synthetic-ux", session: UXSession(), transport: wire)
        let store = AppStore(service: RemoteClaudexService(rpc: rpc))
        await store.boot() // DI has no production session, vault or connection.
        store.account = SessionAccount(raw: .object(["email": .string("synthetic@example.invalid")]))
        store.snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(#"{"settings":{"name":"SYNTHETIC","activeProviderId":"p","providers":[{"id":"p","name":"SYNTHETIC","model":"gpt-synthetic-a","models":["gpt-synthetic-a","gpt-synthetic-b"]}],"effort":"high"},"conversations":[],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[],"host":{"capabilities":{"cloudCode":true}}}"#.utf8))
        store.selectedProviderID = "p"; store.selectedModelID = "gpt-synthetic-a"
        let conversation = try JSONDecoder().decode(Conversation.self, from: Data(#"{"id":"synthetic-c","title":"SYNTHETIC · 首次发送","mode":"chat","providerId":"p","model":"gpt-synthetic-a","pinned":false,"archived":false,"createdAt":1,"updatedAt":1,"turns":[{"id":"synthetic-t","prompt":"SYNTHETIC · 测试中文","attachments":[],"items":[{"id":"synthetic-i","type":"agentMessage","text":"**SYNTHETIC** · 当前页面的回复\n\n```swift\nlet answer = 42\n```"}],"status":"completed","createdAt":1}]}"#.utf8))
        return (store, wire, conversation)
    }
    private func waitFor(_ condition: @escaping () async -> Bool) async throws {
        for _ in 0..<100 { if await condition() { return }; try await Task.sleep(for: .milliseconds(20)) }
        XCTFail("Synthetic operation timed out"); throw ServiceError.invalidResponse
    }
    private func send(_ store: AppStore, _ wire: UXWire, _ conversation: Conversation, fail: Bool = false) async throws {
        store.composerText = "SYNTHETIC · 测试中文"; store.send()
        try await waitFor { await wire.sends == 1 }
        try await wire.finish(conversation, fail: fail)
        try await waitFor { !store.isSending }
    }
    func testFirstMessageAdoptsRootSurfaceWithoutPushing() async throws {
        let (store, wire, conversation) = try await fixture()
        try await send(store, wire, conversation)
        XCTAssertEqual(store.chatSurfaceConversationID, conversation.id)
        XCTAssertEqual(store.activeConversationID, conversation.id)
        XCTAssertTrue(store.chatPath.isEmpty); XCTAssertTrue(store.composerText.isEmpty)
        XCTAssertEqual(store.conversations.first?.turns, conversation.turns)
    }
    func testExistingConversationKeepsItsNavigationPath() async throws {
        let (store, wire, conversation) = try await fixture()
        store.snapshot?.conversations = [conversation]; store.activate(conversation)
        store.chatPath = [.history, .conversation(conversation.id)]
        try await send(store, wire, conversation)
        XCTAssertEqual(store.chatPath, [.history, .conversation(conversation.id)])
        XCTAssertNil(store.chatSurfaceConversationID)
    }
    func testFirstSendFromCodeSectionRetainsConversationNavigation() async throws {
        let (store, wire, conversation) = try await fixture()
        store.section = .code
        try await send(store, wire, conversation)
        XCTAssertEqual(store.chatPath, [.conversation(conversation.id)])
        XCTAssertNil(store.chatSurfaceConversationID)
    }
    func testFailedFirstSendKeepsDraftAndWelcome() async throws {
        let (store, wire, conversation) = try await fixture()
        try await send(store, wire, conversation, fail: true)
        XCTAssertNil(store.chatSurfaceConversationID); XCTAssertTrue(store.chatPath.isEmpty)
        XCTAssertEqual(store.composerText, "SYNTHETIC · 测试中文")
        XCTAssertEqual(store.errorMessage, "SYNTHETIC_SEND_FAILURE")
    }
    func testNewChatDuringPendingSendCannotBeReplacedByLateResponse() async throws {
        let (store, wire, conversation) = try await fixture()
        store.composerText = "SYNTHETIC · old draft"; store.send()
        try await waitFor { await wire.sends == 1 }
        store.beginNewChat(); store.composerText = "SYNTHETIC · new draft"
        try await wire.finish(conversation); try await waitFor { !store.isSending }
        XCTAssertNil(store.activeConversationID); XCTAssertNil(store.chatSurfaceConversationID)
        XCTAssertTrue(store.chatPath.isEmpty); XCTAssertEqual(store.composerText, "SYNTHETIC · new draft")
        XCTAssertEqual(store.conversations.first?.id, conversation.id)
    }
    func testNewChatResetsSurfaceModeAndClosesSidebarTogether() async throws {
        let (store, wire, conversation) = try await fixture()
        try await send(store, wire, conversation)
        store.mode = .code; store.sidebarPresented = true; store.chatPath = [.history]
        store.beginNewChat()
        XCTAssertNil(store.chatSurfaceConversationID); XCTAssertNil(store.activeConversationID)
        XCTAssertEqual(store.mode, .chat); XCTAssertEqual(store.section, .chat)
        XCTAssertTrue(store.chatPath.isEmpty); XCTAssertFalse(store.sidebarPresented)
    }
    func testModelThenEffortPersistsOnSameSurface() async throws {
        let (store, _, _) = try await fixture()
        let choices = ModelMenuPolicy.choices(providers: store.snapshot!.settings.providers, catalog: nil, providerID: "p", selected: store.selectedModelID)
        let choice = try XCTUnwrap(choices.quick.first { $0.model.id == "gpt-synthetic-b" })
        let selected = await store.selectModel(choice); XCTAssertTrue(selected)
        await store.setEffort("low")
        XCTAssertEqual(store.selectedModelID, "gpt-synthetic-b")
        XCTAssertEqual(store.snapshot?.settings.effort, "low")
        XCTAssertTrue(store.chatPath.isEmpty); XCTAssertNil(store.chatSurfaceConversationID)
    }
    func testPendingModelSaveCannotOverlapEffortSave() async throws {
        let (store, wire, _) = try await fixture(holdSettings: true)
        let choices = ModelMenuPolicy.choices(providers: store.snapshot!.settings.providers, catalog: nil, providerID: "p", selected: store.selectedModelID)
        let choice = try XCTUnwrap(choices.quick.first { $0.model.id == "gpt-synthetic-b" })
        let selection = Task { await store.selectModel(choice) }
        try await waitFor { await wire.settingsSaves == 1 }
        await store.setEffort("low")
        let saves = await wire.settingsSaves; XCTAssertEqual(saves, 1)
        try await wire.finishSettings()
        let selected = await selection.value; XCTAssertTrue(selected)
        XCTAssertEqual(store.selectedModelID, "gpt-synthetic-b")
        XCTAssertEqual(store.snapshot?.settings.effort, "high")
        XCTAssertFalse(store.isSavingModel)
    }
    func testSyntheticNativeSurfaceRendersBeforeAndAfterFirstSend() async throws {
        let (store, wire, conversation) = try await fixture()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: RootView().environmentObject(store))
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await capture(window, name: "SYNTHETIC-UX-welcome")
        store.sidebarPresented = true
        try await capture(window, name: "SYNTHETIC-UX-sidebar")
        store.beginNewChat()
        try await send(store, wire, conversation)
        try await waitForTranscript(in: window)
        try await capture(window, name: "SYNTHETIC-UX-first-message")
        XCTAssertTrue(store.chatPath.isEmpty)
    }
    private func webView(in view: UIView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        return view.subviews.compactMap { webView(in: $0) }.first
    }
    private func waitForTranscript(in window: UIWindow) async throws {
        for _ in 0..<150 {
            if let web = webView(in: window), let body = try? await web.evaluateJavaScript("document.body.innerText") as? String,
               body.contains("当前页面的回复"), body.contains("测试中文"), body.contains("let answer = 42") { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("The first-message surface did not render its synthetic prompt, reply and code")
        throw ServiceError.invalidResponse
    }
    private func capture(_ window: UIWindow, name: String) async throws {
        try await Task.sleep(for: .seconds(2))
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
#endif
