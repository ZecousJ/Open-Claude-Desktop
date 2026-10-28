#if !SWIFT_PACKAGE
import XCTest
import SwiftUI
import WebKit
@testable import Claudex

/// Apple-runtime check that the official transcript layer (TranscriptOfficialStyle) lands on the packaged renderer:
/// computed values from and the gesture messages. Local synthetic data only; no account, service or model request.
@MainActor
final class TranscriptOfficialStyleTests: XCTestCase {
  private final class Box: ObservableObject {
    @Published var state: JSONValue
    var events: [TranscriptUIEvent] = []
    var failures: [String] = []
    init(_ state: JSONValue) { self.state = state }
  }
  private struct Surface: View {
    @ObservedObject var box: Box
    var body: some View {
      SharedConversationWebView(state: box.state, watchdogPaused: false, action: { _ in .null },
                                onFailure: { box.failures.append($0) }, onUI: { box.events.append($0) })
        .background(Palette.bg100)
    }
  }
  private func state(theme: String) throws -> JSONValue {
    let markdown = "## 小标题\n\n这是**回复**正文，带有 `inline code` 和一个[链接](https://example.com)。\n\n- 第一项\n- 第二项\n\n```swift\nlet answer = 42\n```\n\n| 列 A | 列 B |\n|---|---|\n| 1 | 2 |\n\nThe quick brown fox. LOCAL_STYLE_END"
    let conversation = try JSONDecoder().decode(Conversation.self, from: Data(#"{"id":"local-c","title":"本地","mode":"chat","providerId":"local","model":"local","pinned":false,"archived":false,"createdAt":1,"updatedAt":1,"turns":[{"id":"t1","prompt":"LOCAL_PROMPT 请写一段代码","attachments":[],"status":"completed","createdAt":1,"items":[{"id":"r1","type":"reasoning","summary":["先想一下"],"content":[]},{"id":"w1","type":"webSearch","query":"swift"},{"id":"a1","type":"agentMessage","text":"MARKDOWN"}]},{"id":"t2","prompt":"再来一次","attachments":[],"status":"failed","error":"x","createdAt":2,"items":[]}]}"#.replacingOccurrences(of: "MARKDOWN", with: markdown.replacingOccurrences(of: "\n", with: "\\n")).utf8))
    return .object(["conversation": try JSONValue.encode(conversation), "theme": .string(theme), "locale": .string("zh-CN"), "replyFeedback": .object([:]), "sending": .bool(false), "media": .object([:])])
  }
  private func webView(in view: UIView) -> WKWebView? {
    if let result = view as? WKWebView { return result }
    return view.subviews.compactMap { webView(in: $0) }.first
  }
  private func render(theme: String) async throws -> (WKWebView, Box, UIWindow) {
    let box = Box(try state(theme: theme))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.overrideUserInterfaceStyle = theme == "dark" ? .dark : .light
    window.rootViewController = UIHostingController(rootView: Surface(box: box))
    window.makeKeyAndVisible()
    for _ in 0..<150 {
      if let web = webView(in: window), let ready = try? await web.evaluateJavaScript("document.body.innerText.includes('LOCAL_STYLE_END') && !!document.querySelector('.cx-share')") as? Bool, ready {
        try await Task.sleep(for: .milliseconds(400))
        return (web, box, window)
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTFail("transcript did not render: \(box.failures)")
    throw NSError(domain: "TranscriptOfficialStyleTests", code: 1)
  }
  private func style(_ web: WKWebView, _ selector: String, _ property: String) async throws -> String {
    let script = "(() => { const e = document.querySelector(\(String(reflecting: selector))); return e ? getComputedStyle(e).getPropertyValue(\(String(reflecting: property))) : 'missing' })()"
    return try await web.evaluateJavaScript(script) as? String ?? ""
  }

  func testOfficialValuesApplyInLightAndDark() async throws {
    for theme in ["light", "dark"] {
      let (web, box, window) = try await render(theme: theme)
      defer { window.isHidden = true; window.rootViewController = nil }
      let fontSize = try await style(web, ".markdown p", "font-size")
      let lineHeight = try await style(web, ".markdown p", "line-height")
      XCTAssertEqual(fontSize, "17px")
      XCTAssertEqual(lineHeight, "25.5px")
      let bubbleFill = try await style(web, ".user-message", "background-color")
      XCTAssertEqual(bubbleFill, theme == "light" ? "rgb(240, 239, 236)" : "rgb(44, 44, 42)")
      let bubbleRadius = try await style(web, ".user-message", "border-top-left-radius")
      XCTAssertEqual(bubbleRadius, "12px")
      let bubbleSize = try await style(web, ".user-message", "font-size")
      XCTAssertEqual(bubbleSize, "15px")
      let link = try await style(web, ".markdown a", "color")
      XCTAssertEqual(link, "rgb(217, 119, 87)")
      let code = try await style(web, ".markdown p code", "color")
      XCTAssertEqual(code, theme == "light" ? "rgb(24, 79, 149)" : "rgb(109, 167, 236)")
      let codeRadius = try await style(web, ".code-block", "border-top-left-radius")
      XCTAssertEqual(codeRadius, "12px")
      let heading = try await style(web, ".markdown h2", "font-size")
      XCTAssertEqual(heading, "24px")
      let notice = try await style(web, ".turn-interrupted", "border-top-left-radius")
      XCTAssertEqual(notice, "16px")
      let retryText = try await web.evaluateJavaScript("document.querySelector('.cx-notice-retry')?.textContent") as? String
      XCTAssertEqual(retryText, L("generic_retry"))
      let order = try await web.evaluateJavaScript("Array.from(document.querySelectorAll('.turn')[0].querySelectorAll('.message-actions > button')).slice(0, 2).map(b => b.classList.contains('cx-share') ? 'share' : 'other').join(',')") as? String
      XCTAssertEqual(order, "other,share")
      let image = try await web.takeSnapshot(configuration: nil)
      let attachment = XCTAttachment(image: image)
      attachment.name = "official-transcript-\(theme)"
      attachment.lifetime = .keepAlways
      add(attachment)

      // The steps row opens the native sheet; Share reports the turn.
      _ = try await web.evaluateJavaScript("document.querySelector('.chat-steps > summary').click(); document.querySelector('.cx-share').click(); true")
      for _ in 0..<20 where box.events.count < 2 { try await Task.sleep(for: .milliseconds(50)) }
      XCTAssertEqual(box.events, [.steps(.init(index: 0, prompt: "LOCAL_PROMPT 请写一段代码")), .share(.init(index: 0, prompt: "LOCAL_PROMPT 请写一段代码"))])
      let opened = try await web.evaluateJavaScript("document.querySelector('.chat-steps').open") as? Bool
      XCTAssertEqual(opened, false)
    }
  }

  func testPageScriptsCannotReachTheTranscriptHandler() async throws {
    let (web, box, window) = try await render(theme: "light")
    defer { window.isHidden = true; window.rootViewController = nil }
    let reachable = try await web.evaluateJavaScript("!!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.claudexTranscriptUI)") as? Bool
    XCTAssertEqual(reachable, false)
    XCTAssertTrue(box.events.isEmpty)
  }
}
#endif
