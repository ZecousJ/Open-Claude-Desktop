// Compiled only in an isolated UI-test copy prepared by the companion script.
// This entry point is never referenced by the shipping Xcode target.
import SwiftUI
import WebKit

@MainActor private enum UIUXDiagnostics {
  static func web(in view: UIView) -> WKWebView? {
    if let web = view as? WKWebView { return web }
    return view.subviews.compactMap { web(in: $0) }.first
  }
  static func sample(_ rendered: @MainActor (Bool) -> Void) async {
    for _ in 0..<35 {
      try? await Task.sleep(for: .seconds(2))
      let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
      if let view = windows.compactMap({ web(in: $0) }).first {
        let value = try? await view.evaluateJavaScript("JSON.stringify({url:location.href,ready:document.readyState,api:typeof window.ClaudexConversation,text:document.body.innerText.slice(0,1200)})")
        print("SYNTHETIC_WEB_DIAGNOSTIC \(Date().timeIntervalSince1970) \(value ?? "unavailable")")
        let code = try? await view.evaluateJavaScript("document.body.innerText.includes('SYNTHETIC_PHONE_REPLY') && [...document.querySelectorAll('pre code')].some(code => code.textContent.includes('let answer = 42'))") as? Bool
        if code == true { rendered(true) }
      }
    }
  }
}

private struct UIUXSession: SessionProvider {
  func accessToken() async throws -> String { "SYNTHETIC_NO_NETWORK" }
  func eventsTicket(tabID: String) async throws -> String { throw ServiceError.invalidResponse }
  func signOut() async throws {}
}
private actor UIUXTransport: HTTPTransport {
  func execute(_ request: URLRequest) async throws -> (Data, Int) {
    let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
    let input = body["args"].array![0]
    let value: JSONValue
    switch request.url?.lastPathComponent {
    case "saveSettings": value = input
    case "send":
      try await Task.sleep(for: .seconds(8))
      var fields = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"id":"synthetic-c","title":"SYNTHETIC · 首次发送","mode":"chat","providerId":"p","model":"gpt-synthetic-a","pinned":false,"archived":false,"createdAt":1,"updatedAt":1,"turns":[{"id":"synthetic-t","prompt":"SYNTHETIC_PHONE_PROMPT","attachments":[],"items":[{"id":"synthetic-i","type":"agentMessage","text":"**SYNTHETIC_PHONE_REPLY** · 当前页面的回复\n\n```swift\nlet answer = 42\n```"}],"status":"completed","createdAt":1}]}"#.utf8)).object!
      fields["model"] = input["model"]
      value = .object(fields)
    default: throw ServiceError.invalidResponse
    }
    return (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": value])), 200)
  }
}
@MainActor private enum UIUXBootstrap {
  static func store() -> AppStore {
    let rpc = try! RPCClient(baseURL: URL(string: "https://synthetic.invalid")!, tabID: "synthetic-ui-63", session: UIUXSession(), transport: UIUXTransport())
    let store = AppStore(service: RemoteClaudexService(rpc: rpc))
    store.account = SessionAccount(raw: .object(["email": .string("synthetic@example.invalid")]))
    store.snapshot = try! JSONDecoder().decode(Snapshot.self, from: Data(#"{"settings":{"name":"SYNTHETIC","activeProviderId":"p","providers":[{"id":"p","name":"SYNTHETIC","model":"gpt-synthetic-a","models":["gpt-synthetic-a","gpt-synthetic-b"]}],"effort":"high"},"conversations":[],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[]}"#.utf8))
    store.selectedProviderID = "p"; store.selectedModelID = "gpt-synthetic-a"
    store.connectionStatus = "SYNTHETIC · 本地受控测试"
    return store
  }
}
@main struct ConversationUXHost: App {
  @StateObject private var store = UIUXBootstrap.store()
  @State private var codeRendered = false
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(store).tint(Brand.ink)
        .overlay(alignment: .bottomTrailing) {
          Text("SYNTHETIC · UI test only").font(.system(size: 7)).padding(2)
            .accessibilityIdentifier("synthetic-ux-state")
            .accessibilityValue("model=\(store.selectedModelID);effort=\(store.snapshot?.settings.effort ?? "");path=\(store.chatPath.count);surface=\(store.chatSurfaceConversationID ?? "nil");sending=\(store.isSending);sidebar=\(store.sidebarPresented);codeRendered=\(codeRendered)")
            .allowsHitTesting(false)
        }
        .task { await store.boot() }
        .task { await UIUXDiagnostics.sample { codeRendered = $0 } }

    }
  }
}
