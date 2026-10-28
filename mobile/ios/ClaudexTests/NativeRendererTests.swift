#if !SWIFT_PACKAGE
import XCTest
import SwiftUI
import WebKit
@testable import Claudex

/// Apple-runtime tests only. All text is local synthetic data; no account,
/// service, upload, or model request is used. These are not account acceptance.
@MainActor
final class NativeRendererTests: XCTestCase {
    private final class RenderState: ObservableObject {
        @Published var value: JSONValue
        @Published var size: DynamicTypeSize = .large
        var failures: [String] = []
        init(_ value: JSONValue) { self.value = value }
    }
    private struct Surface: View {
        @ObservedObject var state: RenderState
        var body: some View {
            VStack(spacing: 0) {
                Text("本地受控渲染测试 · 非真实账号").font(.caption).padding(8)
                SharedConversationWebView(state: state.value, watchdogPaused: false,
                    action: { _ in .null }, onFailure: { state.failures.append($0) })
            }.environment(\.dynamicTypeSize, state.size)
        }
    }
    private func transcript(_ text: String, theme: String = "light", id: String = "local-c") throws -> JSONValue {
        let conversation = try JSONDecoder().decode(Conversation.self, from: Data(#"{"id":"local-c","title":"本地受控测试","mode":"chat","providerId":"local","model":"local-no-model-calls","pinned":false,"archived":false,"createdAt":1,"updatedAt":1,"turns":[{"id":"local-t","prompt":"LOCAL_PROMPT: 请展示本地测试内容","attachments":[],"status":"completed","createdAt":1,"items":[]}]}"#.utf8))
        var raw = try XCTUnwrap(JSONValue.encode(conversation).object)
        raw["id"] = .string(id)
        var c = try JSONValue.object(raw).decode(Conversation.self)
        c.turns[0].items = [try JSONValue.object(["id": .string("local-i"), "type": .string("agentMessage"), "text": .string(text)]).decode(TranscriptItem.self)]
        return .object(["conversation": try JSONValue.encode(c), "theme": .string(theme), "locale": .string("zh-CN"), "replyFeedback": .object([:]), "sending": .bool(false), "media": .object([:])])
    }
    private func webView(in view: UIView) -> WKWebView? {
        if let result = view as? WKWebView { return result }
        return view.subviews.compactMap { webView(in: $0) }.first
    }
    private var testWindow: UIWindow?
    private weak var previousWindow: UIWindow?
    private func host(_ state: RenderState) throws -> UIHostingController<Surface> {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        previousWindow = scene.windows.first(where: { $0.isKeyWindow })
        let controller = UIHostingController(rootView: Surface(state: state))
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        testWindow = window
        return controller
    }
    private func unhost(_ controller: UIViewController) {
        testWindow?.isHidden = true
        testWindow?.rootViewController = nil
        testWindow = nil
        previousWindow?.makeKeyAndVisible()
    }
    private func waitForText(_ text: String, controller: UIViewController, state: RenderState) async throws -> WKWebView {
        for _ in 0..<400 {
            if let web = webView(in: controller.view),
               let body = try? await web.evaluateJavaScript("document.body.innerText") as? String,
               body.contains(text) { return web }
            if !state.failures.isEmpty { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        if let web = webView(in: controller.view) {
            let diagnostic = (try? await web.evaluateJavaScript("JSON.stringify({url:location.href,api:typeof window.ClaudexConversation,body:document.body.innerText})")) as? String ?? "unavailable"
            let attachment = XCTAttachment(string: diagnostic); attachment.name = "local-render-diagnostic"; attachment.lifetime = .keepAlways; add(attachment)
        }
        XCTFail("Local WKWebView did not render \(text); native failures: \(state.failures)")
        throw NSError(domain: "NativeRendererTests", code: 1)
    }
    private func capture(_ web: WKWebView, _ name: String) async throws {
        let image = try await web.takeSnapshot(configuration: nil)
        let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func textMetrics(_ web: WKWebView) async throws -> JSONValue {
        let script = """
        JSON.stringify({adjust:document.documentElement.style.webkitTextSizeAdjust,width:innerWidth,
          values:Object.fromEntries(['.markdown h1','.markdown p','.markdown :not(pre)>code','.code-block pre code','.markdown table'].map(selector=>{
            const el=document.querySelector(selector); if(!el)return [selector,null];
            const range=document.createRange();range.selectNodeContents(el);const box=range.getBoundingClientRect();const style=getComputedStyle(el);
            return [selector,{font:parseFloat(style.fontSize),lineHeight:style.lineHeight,glyphWidth:box.width,glyphHeight:box.height}];
          }))})
        """
        let value = try await web.evaluateJavaScript(script)
        return try JSONDecoder().decode(JSONValue.self, from: Data((try XCTUnwrap(value as? String)).utf8))
    }
    func testNativeTextAdjustAcrossAllCategoriesAndStateTransitions() async throws {
        let state = RenderState(try transcript("# 字\n\n字 `字`.\n\n| 字 |\n| --- |\n| 字 |\n\n```swift\n字\n```"))
        let controller = try host(state); defer { unhost(controller) }
        let web = try await waitForText("字", controller: controller, state: state)
        let baseline = try await textMetrics(web)
        _ = try await web.evaluateJavaScript("window.__baselineCanvasRoot = document.getElementById('root'); true;")
        let sizes: [DynamicTypeSize] = [.xSmall,.small,.medium,.large,.xLarge,.xxLarge,.xxxLarge,.accessibility1,.accessibility2,.accessibility3,.accessibility4,.accessibility5]
        var samples: [JSONValue] = []
        for size in sizes {
            let body = Double(UIFont.preferredFont(forTextStyle: .body, compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))).pointSize)
            let expectedPercent = Int((SharedConversationTextScale.zoom(bodyPointSize: body) * 100).rounded())
            state.size = size
            for _ in 0..<100 {
                let adjusted = try? await web.evaluateJavaScript("document.documentElement.style.webkitTextSizeAdjust") as? String
                if adjusted == "\(expectedPercent)%" { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            let value = try await textMetrics(web)
            XCTAssertEqual(value["adjust"].string,"\(expectedPercent)%")
            for selector in [".markdown h1", ".markdown p", ".markdown :not(pre)>code", ".code-block pre code", ".markdown table"] {
                let initial = try XCTUnwrap(baseline["values"][selector]["font"].number)
                let actual = try XCTUnwrap(value["values"][selector]["font"].number)
                XCTAssertEqual(actual, initial * Double(expectedPercent) / 100, accuracy: 0.03, "\(size) \(selector)")
                XCTAssertGreaterThan(try XCTUnwrap(value["values"][selector]["glyphHeight"].number), 0)
            }
            XCTAssertTrue(web === webView(in: controller.view))
            let same = try await web.evaluateJavaScript("window.__baselineCanvasRoot === document.getElementById('root')") as? Bool
            XCTAssertEqual(same,true)
            samples.append(.object(["category":.string(String(describing:size)),"bodyPointSize":.number(body),"desiredRatio":.number(body/17),"appliedPercent":.number(Double(expectedPercent)),"metrics":value]))
            if size == .large || size == .accessibility3 || size == .accessibility5 { try await capture(web,"owner-existing-scale-\(size)") }
        }
        // Exercise complete-state history/new conversation updates on the same native canvas.
        for id in ["local-history", "local-new-conversation"] {
            state.value = try transcript("# 字\n\n字 `字`.\n\n```swift\n字\n```\n\n" + id, id: id)
            _ = try await waitForText(id, controller: controller, state: state)
            let metrics = try await textMetrics(web)
            XCTAssertEqual(metrics["values"][".markdown p"]["font"].number, 48)
            XCTAssertTrue(web === webView(in: controller.view))
            let sameRoot = try await web.evaluateJavaScript("window.__baselineCanvasRoot === document.getElementById('root')") as? Bool
            XCTAssertEqual(sameRoot, true)
        }
        state.value = .object(["document":.object(["id":.string("local-baseline-document"),"name":.string("Baseline document"),"language":.string("markdown"),"content":.string("# 字\n\nLOCAL_BASELINE_DOCUMENT\n\n字 `字`.\n\n```swift\n字\n```")]),"theme":.string("light"),"locale":.string("zh-CN")])
        _ = try await waitForText("LOCAL_BASELINE_DOCUMENT", controller: controller, state: state)
        samples.append(.object(["documentAtAccessibility5":try await textMetrics(web)]))
        let attachment = XCTAttachment(string:String(decoding:try JSONEncoder().encode(JSONValue.object(["baseline":baseline,"samples":.array(samples)])),as:UTF8.self));attachment.name="existing-owner-font-metrics";attachment.lifetime = .keepAlways;add(attachment)
        state.size = .large
        for _ in 0..<100 {
            if (try? await web.evaluateJavaScript("document.documentElement.style.webkitTextSizeAdjust")) as? String == "100%" { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let restored = try await textMetrics(web)
        XCTAssertEqual(restored["values"][".markdown p"]["font"].number, 16)
        XCTAssertTrue(web === webView(in: controller.view))
        let sameRoot = try await web.evaluateJavaScript("window.__baselineCanvasRoot === document.getElementById('root')") as? Bool
        XCTAssertEqual(sameRoot, true)
        XCTAssertTrue(state.failures.isEmpty)
    }

    func testPackagedWebPCTranscriptActuallyRendersAndUpdates() async throws {
        let markdown = "# LOCAL_MARKDOWN\n\n**粗体内容**\n\n| 项目 | 状态 |\n| --- | --- |\n| 本地 | 受控 |\n\n```swift\nlet localValue = 42\n```"
        let state = RenderState(try transcript(markdown))
        let controller = try host(state); defer { unhost(controller) }
        let web = try await waitForText("LOCAL_MARKDOWN", controller: controller, state: state)
        let language = try await web.evaluateJavaScript("document.documentElement.lang") as? String
        XCTAssertEqual(language, "zh-CN")
        let tableCount = try await web.evaluateJavaScript("document.querySelectorAll('table').length") as? Int
        let body = try await web.evaluateJavaScript("document.body.innerText") as? String ?? ""
        XCTAssertEqual(tableCount, 1)
        XCTAssertTrue(body.contains("LOCAL_PROMPT"))
        XCTAssertTrue(body.contains("localValue"))
        try await capture(web, "synthetic-transcript-light")
        for index in 0..<20 { state.value = try transcript(markdown + "\n\nLOCAL_STREAM_\(index)") }
        _ = try await waitForText("LOCAL_STREAM_19", controller: controller, state: state)
        state.value = try transcript(markdown + "\n\nLOCAL_STREAM_19", theme: "dark")
        for _ in 0..<30 {
            if (try? await web.evaluateJavaScript("document.documentElement.dataset.theme")) as? String == "dark" { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let theme = try await web.evaluateJavaScript("document.documentElement.dataset.theme") as? String
        XCTAssertEqual(theme, "dark")
        XCTAssertTrue(state.failures.isEmpty)
        try await capture(web, "synthetic-transcript-dark")
    }
    func testPackagedDocumentLoadsMathAndCode() async throws {
        let state = RenderState(.object(["document": .object(["id": .string("local-doc"), "language": .string("markdown"), "name": .string("本地文档"), "content": .string("# LOCAL_DOCUMENT\n\n公式：\n\n$$\nx^2 + y^2 = z^2\n$$\n\n```python\nprint('LOCAL_CODE')\n```")]), "theme": .string("light"), "locale": .string("zh-CN")]))
        let controller = try host(state); defer { unhost(controller) }
        let web = try await waitForText("LOCAL_DOCUMENT", controller: controller, state: state)
        for _ in 0..<50 {
            if (try? await web.evaluateJavaScript("document.querySelectorAll('.katex').length")) as? Int ?? 0 > 0 { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let mathCount = try await web.evaluateJavaScript("document.querySelectorAll('.katex').length") as? Int ?? 0
        let body = try await web.evaluateJavaScript("document.body.innerText") as? String ?? ""
        XCTAssertGreaterThan(mathCount, 0)
        XCTAssertTrue(body.contains("LOCAL_CODE"))
        XCTAssertTrue(state.failures.isEmpty)
        try await capture(web, "synthetic-document-math-code")
    }


}
#endif
