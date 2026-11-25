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
    private var pendingCatalog: CheckedContinuation<Void, Never>?
    private let holdCatalog: Bool
    private let catalog: ModelCatalog
    private var snapshot: Snapshot
    private(set) var inputs: [JSONValue] = []
    var sends: Int { inputs.count }
    init(holdCatalog: Bool, catalog: ModelCatalog, snapshot: Snapshot) {
        self.holdCatalog = holdCatalog; self.catalog = catalog; self.snapshot = snapshot
    }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        let value: JSONValue
        switch request.url?.lastPathComponent {
        case "send":
            let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody))
            inputs.append(try XCTUnwrap(body["args"].array?.first))
            return try await withCheckedThrowingContinuation { pending = $0 }
        case "snapshot": value = try .encode(snapshot)
        case "modelCatalog":
            if holdCatalog { await withCheckedContinuation { pendingCatalog = $0 } }
            value = try .encode(catalog)
        case "updateConversation":
            let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody))
            let args = try XCTUnwrap(body["args"].array)
            let index = try XCTUnwrap(snapshot.conversations.firstIndex { $0.id == args[0].string })
            snapshot.conversations[index].extensionFields["effort"] = args[1]["effort"]
            value = try .encode(snapshot.conversations[index])
        default: throw ServiceError.invalidResponse
        }
        return (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": value])), 200)
    }
    func finish(_ conversation: Conversation?, fail: Bool = false) throws {
        guard let pending else { throw ServiceError.invalidResponse }
        self.pending = nil
        if fail { pending.resume(throwing: ServiceError.server("SYNTHETIC_SEND_FAILURE", nil)) }
        else { pending.resume(returning: (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": .encode(conversation!)])), 200)) }
    }
    var waitingForCatalog: Bool { pendingCatalog != nil }
    func install(_ conversation: Conversation) { snapshot.conversations = [conversation] }
    func deliverCatalog() {
        pendingCatalog?.resume(); pendingCatalog = nil
    }
}
@MainActor
final class NativeConversationUXTests: XCTestCase {
    func testPersistedDraftsStayWithEditorAccountAndOriginUntilSignOut() async throws {
        let drafts = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: drafts) }
        let (store, _, first) = try await fixture(drafts: drafts)
        let bytes = Data("F021 local attachment".utf8)
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
        try bytes.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        store.composerText = "F021 Home"
        store.selectComposerProject("first-project")
        XCTAssertEqual(store.composerText, "F021 Home")
        store.addFile(source, displayName: "F021.txt")
        store.openProjectComposer("first-project")
        XCTAssertTrue(store.composerText.isEmpty)
        XCTAssertTrue(store.attachments.isEmpty)
        store.composerText = "F021 Project"
        store.closeProjectComposer("first-project")
        store.mode = .code
        store.preparedRepository = RepositoryReference(url: "https://github.com/example/fixture.git", ref: "main")
        store.composerText = "F021 Code"
        store.mode = .cowork
        store.composerText = "F021 Cowork"
        store.activate(first)
        store.composerText = "F021 Conversation"
        store.setScheduleDraftPrompt("F021 Schedule", scope: .new)
        var privateConversation = Conversation(id: "incognito", title: "Private", mode: .chat,
            providerId: first.providerId, model: first.model, pinned: false, archived: false, createdAt: 0, updatedAt: 0, turns: [])
        privateConversation.extensionFields["incognito"] = .bool(true)
        store.activate(privateConversation)
        store.composerText = "F021 Private"
        store.addFile(source)
        store.lifecycle(active: false)

        await store.didLogin(SessionAccount(raw: .object(["id": .number(2)])))
        XCTAssertTrue(store.composerText.isEmpty)
        XCTAssertTrue(store.attachments.isEmpty)
        XCTAssertNil(store.scheduleDraftPrompt(.new))
        store.composerText = "F021 Other account"
        let (otherOrigin, _, _) = try await fixture(origin: "https://other.invalid", drafts: drafts)
        XCTAssertTrue(otherOrigin.composerText.isEmpty)
        otherOrigin.composerText = "F021 Other origin"

        let (restored, _, _) = try await fixture(drafts: drafts)
        XCTAssertEqual(restored.composerText, "F021 Home")
        XCTAssertEqual(restored.preparedProjectID, "first-project")
        let file = try XCTUnwrap(restored.attachments.first)
        XCTAssertEqual(file.name, "F021.txt")
        XCTAssertEqual(try Data(contentsOf: file.url), bytes)
        restored.openProjectComposer("first-project")
        XCTAssertEqual(restored.composerText, "F021 Project")
        restored.closeProjectComposer("first-project")
        restored.mode = .code
        XCTAssertEqual(restored.composerText, "F021 Code")
        XCTAssertEqual(restored.preparedRepository?.ref, "main")
        restored.mode = .cowork
        XCTAssertEqual(restored.composerText, "F021 Cowork")
        restored.activate(first)
        XCTAssertEqual(restored.composerText, "F021 Conversation")
        restored.activate(privateConversation)
        XCTAssertTrue(restored.composerText.isEmpty)
        XCTAssertTrue(restored.attachments.isEmpty)
        XCTAssertEqual(restored.scheduleDraftPrompt(.new), "F021 Schedule")

        await restored.signOut()
        await restored.didLogin(SessionAccount(raw: .object(["id": .number(1)])))
        XCTAssertTrue(restored.composerText.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.url.path))
        XCTAssertNil(restored.scheduleDraftPrompt(.new))
        let (otherAccount, _, _) = try await fixture(accountID: 2, drafts: drafts)
        XCTAssertEqual(otherAccount.composerText, "F021 Other account")
        let (secondOrigin, _, _) = try await fixture(origin: "https://other.invalid", drafts: drafts)
        XCTAssertEqual(secondOrigin.composerText, "F021 Other origin")
    }

    func testUnconfirmedSendReturnsAfterColdReopenWithoutResending() async throws {
        let drafts = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: drafts) }
        let (store, wire, _) = try await fixture(drafts: drafts)
        store.composerText = "F021 Sending"
        store.send()
        try await waitFor { await wire.sends == 1 }
        store.composerText = "F021 Followup"

        let (restored, restartedWire, _) = try await fixture(drafts: drafts)
        XCTAssertEqual(restored.pendingSend?.draft.text, "F021 Sending")
        XCTAssertEqual(restored.composerText, "F021 Followup")
        let restartedSends = await restartedWire.sends
        XCTAssertEqual(restartedSends, 0)

        try await wire.finish(nil, fail: true)
        try await waitFor { !store.isSending }
        XCTAssertEqual(store.composerText, "F021 Sending\n\nF021 Followup")
    }

    func testLateFailedHistorySendRestoresOnlyOriginalDraft() async throws {
        let (store, wire, first) = try await fixture()
        let second = Conversation(id: "synthetic-b", title: "B", mode: .chat,
            providerId: first.providerId, model: first.model, pinned: false, archived: false, createdAt: 0, updatedAt: 0, turns: [])
        store.snapshot?.conversations = [first, second]
        store.activate(first)
        store.composerText = "F021 Alpha"
        store.send()
        try await waitFor { await wire.sends == 1 }
        store.activate(second)
        store.composerText = "F021 Beta"
        try await wire.finish(nil, fail: true)
        try await waitFor { !store.isSending }
        XCTAssertEqual(store.composerText, "F021 Beta")
        store.activate(first)
        XCTAssertEqual(store.composerText, "F021 Alpha")
    }

    private func fixture(defaults: UserDefaults = UserDefaults(suiteName: UUID().uuidString)!, holdCatalog: Bool = false, empty: Bool = false,
                         accountID: Int = 1, origin: String = "https://synthetic.invalid", drafts: URL? = nil) async throws -> (AppStore, UXWire, Conversation) {
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(#"{"settings":{"name":"SYNTHETIC","activeProviderId":"p","providers":[{"id":"p","name":"SYNTHETIC","model":"gpt-synthetic-a","models":["gpt-synthetic-a","gpt-synthetic-b"]}],"effort":"high"},"conversations":[],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[],"host":{"capabilities":{"cloudCode":true}}}"#.utf8))
        let catalog = ModelCatalog(defaultModel: "gpt-synthetic-a", items: empty ? [] : [
            ModelItem(id: "gpt-synthetic-a", displayName: "Model A", description: "", badges: [], sort: 0, hidden: false, isDefault: true, usageHint: "", efforts: nil, defaultEffort: nil, contextWindow: nil),
            ModelItem(id: "gpt-synthetic-b", displayName: "Model B", description: "", badges: [], sort: 1, hidden: false, isDefault: false, usageHint: "", efforts: ["low", "high"], defaultEffort: "high", contextWindow: nil),
        ])
        let wire = UXWire(holdCatalog: holdCatalog, catalog: catalog, snapshot: snapshot)
        let rpc = try RPCClient(baseURL: XCTUnwrap(URL(string: origin)), tabID: "synthetic-ux", session: UXSession(), transport: wire)
        let store = AppStore(service: RemoteClaudexService(rpc: rpc), modelDefaults: defaults, composerDraftRoot: drafts)
        let account = SessionAccount(raw: .object(["id": .number(Double(accountID))]))
        if holdCatalog {
            Task { await store.didLogin(account) }
            try await waitFor { await wire.waitingForCatalog }
        } else {
            await store.didLogin(account)
        }
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
    func testRejectedFirstSendCannotRestoreDraftIntoNewChat() async throws {
        let (store, wire, conversation) = try await fixture()
        store.composerText = "Old draft"
        store.send()
        try await waitFor { await wire.sends == 1 }
        store.beginNewChat()
        try await wire.finish(conversation, fail: true)
        try await waitFor { !store.isSending }
        XCTAssertTrue(store.composerText.isEmpty)
        XCTAssertNil(store.activeConversationID)
    }
    func testAcknowledgementKeepsNewlyTypedIdenticalText() async throws {
        let (store, wire, conversation) = try await fixture()
        store.composerText = "Same text"
        store.send()
        try await waitFor { await wire.sends == 1 }
        store.composerText = "Same text"
        try await wire.finish(conversation)
        try await waitFor { !store.isSending }
        XCTAssertEqual(store.composerText, "Same text")
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
    func testColdStoreSendsSavedModelAndEffortForItsOwnAccountOriginAndMode() async throws {
        let suite = "model-preference-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let (store, _, _) = try await fixture(defaults: defaults)
        let choice = try XCTUnwrap(store.modelChoices.first { $0.model.id == "gpt-synthetic-b" })
        XCTAssertTrue(store.selectModel(choice, mode: .chat, conversation: nil))
        let rejected = await store.setEffort(.medium, mode: .chat, conversation: nil)
        let saved = await store.setEffort(.low, mode: .chat, conversation: nil)
        XCTAssertFalse(rejected)
        XCTAssertTrue(saved)

        let (reopened, wire, response) = try await fixture(defaults: defaults)
        XCTAssertEqual(reopened.selectedModelID, "gpt-synthetic-b")
        XCTAssertEqual(reopened.selectedModel(mode: .code, conversation: nil)?.model.id, "gpt-synthetic-a")
        let (otherAccount, _, _) = try await fixture(defaults: defaults, accountID: 12)
        let (otherOrigin, _, _) = try await fixture(defaults: defaults, origin: "https://synthetic.invalid:8443")
        XCTAssertEqual(otherAccount.selectedModelID, "gpt-synthetic-a")
        XCTAssertEqual(otherOrigin.selectedModelID, "gpt-synthetic-a")

        try await send(reopened, wire, response)
        let request = await wire.inputs.first
        XCTAssertEqual(request?["model"].string, "gpt-synthetic-b")
        XCTAssertEqual(request?["effort"].string, "low")
        XCTAssertTrue(reopened.chatPath.isEmpty)
    }
    func testLoadingCatalogBecomesEmptyAndCannotSendWithProviderOnlyAssignment() async throws {
        let (store, wire, _) = try await fixture(holdCatalog: true, empty: true)
        try await waitFor { store.snapshot != nil }
        guard case .loading = store.modelCatalog else { return XCTFail("Early catalog result") }
        XCTAssertTrue(store.modelChoices.isEmpty)
        await wire.deliverCatalog()
        try await waitFor { if case .loaded = store.modelCatalog { return true }; return false }
        XCTAssertTrue(store.modelChoices.isEmpty)
        store.composerText = "Keep the draft until the account has a model"
        store.send()
        XCTAssertFalse(store.isSending)
        XCTAssertFalse(store.composerText.isEmpty)
        let sends = await wire.sends
        XCTAssertEqual(sends, 0)
    }
    func testModelWithoutPublishedEffortDoesNotSendAnEffort() async throws {
        let (store, wire, response) = try await fixture()
        let selected = await store.setEffort(.high, mode: .chat, conversation: nil)
        XCTAssertFalse(selected)
        try await send(store, wire, response)
        let request = await wire.inputs.first
        XCTAssertEqual(request?["model"].string, "gpt-synthetic-a")
        XCTAssertNil(request?.object?["effort"])
    }
    func testExistingChatEffortIsPersistedBeforeTheNextSend() async throws {
        let (store, wire, response) = try await fixture()
        var conversation = response
        conversation.model = "gpt-synthetic-b"
        await wire.install(conversation)
        await store.refresh()
        store.activate(conversation)
        let selected = await store.setEffort(.low, mode: .chat, conversation: conversation)
        XCTAssertTrue(selected)
        store.beginNewChat()
        await store.refresh()
        let reopened = try XCTUnwrap(store.conversations.first)
        let choice = try XCTUnwrap(store.selectedModel(mode: .chat, conversation: reopened))
        XCTAssertEqual(store.selectedEffort(choice, mode: .chat, conversation: reopened), .low)
        XCTAssertEqual(store.selectedModelID, "gpt-synthetic-a")
        let sends = await wire.sends
        XCTAssertEqual(sends, 0)
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
