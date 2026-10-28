import SwiftUI
import WebKit
import SafariServices

enum SharedConversationDestination: Identifiable {
    case attachment(Attachment), file(GeneratedFile), changes(Conversation), link(URL)
    var id: String {
        switch self {
        case .attachment(let value): return "attachment:" + value.id
        case .file(let value): return "file:" + value.id
        case .changes(let value): return "changes:" + value.id
        case .link(let value): return "link:" + value.absoluteString
        }
    }
}

/// Native owns navigation, composer, auth, transport and system dialogs. Every
/// message/tool transcript rendering uses the exact bundled web/PC component tree/CSS.
struct SharedConversationView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    let conversation: Conversation
    /// Set for a Code conversation on one of the account's computers
    /// (DeviceViews): whether it is sending. Such a transcript only copies
    /// text and opens links; its files and images are on the computer.
    var remoteSending: Bool? = nil
    /// The new-chat page's empty draft loads behind the greeting without the spinner.
    var quietLoading = false
    @State private var destination: SharedConversationDestination?
    @State private var loadError: String?
    @State private var hasRendered = false
    @State private var reload = UUID()
    @State private var media: JSONValue = .object([:])
    @StateObject private var exporter = SharedConversationExporter()
    @State private var commands = TranscriptCommands()
    @State private var menu: MessageMenuRequest?
    @State private var selection: TranscriptTextSelection?
    @State private var steps: TranscriptStepsItem?
    private var mediaKey: String {
        store.conversationBridgeGeneration.uuidString + conversation.turns.flatMap(\.attachments).map(\.id).joined(separator: "|") +
        conversation.turns.flatMap(\.items).flatMap(\.generatedFiles).compactMap(\.digest).joined(separator: "|")
    }
    private var captureKey: String { store.imageSnapshotKey(conversation.id) + reload.uuidString }
    private var state: JSONValue {
        let ratings = (store.snapshot?.replyFeedback ?? [:]).filter { pair in
            conversation.turns.contains { pair.key == ArtifactIndex.identity([conversation.id, $0.id]) }
        }
        return .object([
            "conversation": (try? JSONValue.encode(conversation)) ?? .null,
            // Native UI currently exposes Simplified Chinese (Settings → Language).
            "locale": .string("zh-CN"),
            "theme": .string(colorScheme == .dark ? "dark" : "light"),
            "replyFeedback": (try? JSONValue.encode(ratings)) ?? .object([:]),
            "sending": .bool(remoteSending ?? (store.isSending || store.conversationActions.contains(conversation.id))),
            "media": media
        ])
    }
    private var actionHandler: @MainActor (SharedConversationAction) async throws -> JSONValue {
        let generation = store.conversationBridgeGeneration, conversationID = conversation.id
        if remoteSending != nil {
            let conversation = conversation
            return { action in
                let payload = action.payload
                switch action.type {
                case .copyText:
                    let text = payload["text"].string ?? ""
                    guard SharedConversationResolver.containsText(text, conversation: conversation) else { throw ServiceError.invalidResponse }
                    UIPasteboard.general.string = text
                case .openLink:
                    let text = payload["url"].string ?? ""
                    guard let url = SharedConversationProtocol.safeLink(text), SharedConversationResolver.containsLink(text, conversation: conversation) else { throw ServiceError.invalidResponse }
                    destination = .link(url)
                default:
                    throw ServiceError.server(L("generic_error_something_went_wrong_try_again"), "DEVICE_CONVERSATION")
                }
                return .null
            }
        }
        return { action in
            try await store.dispatchSharedConversationAction(action, conversationID: conversationID,
                                                              generation: generation, present: { destination = $0 },
                                                              export: { file in
                                                                  try await exporter.export(file, store: store) {
                                                                      try store.validateSharedExport(file, conversationID: conversationID, generation: generation)
                                                                  }
                                                              })
        }
    }
    var body: some View {
        ZStack {
            SharedConversationWebView(state: state, watchdogPaused: scenePhase != .active || exporter.isExporting, action: actionHandler, onFailure: { loadError = $0 }, onRendered: { if !hasRendered { Task { try? await Task.sleep(for: .milliseconds(50)); hasRendered = true } } }, onUI: handle, commands: commands)
                .id(store.conversationBridgeGeneration.uuidString + reload.uuidString)
            // The page stays visible under a cover in the page colour until it has rendered:
            // WebKit does not composite a view at opacity 0, so revealing one showed a frame
            // of black before its first paint.
            if loadError == nil && !hasRendered {
                ZStack {
                    Palette.bg100
                    // Plain loading state: the large spinner, no words.
                    if !quietLoading {
                        ClaudeSpinner(size: .large).accessibilityLabel(L("usage_meter_row_loading"))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(false)
            }
            if let loadError, !quietLoading {
                TranscriptErrorState(detail: loadError) { self.loadError = nil; hasRendered = false; reload = UUID() }
            }
            if let menu {
                MessageMenuOverlay(request: menu,
                                   onCopy: { copy(menu.text); self.menu = nil },
                                   onSelect: { selection = TranscriptTextSelection(text: menu.text); self.menu = nil },
                                   onEdit: menu.role == .user && menu.canEdit && remoteSending == nil ? { commands.edit(renderedIndex: menu.renderedIndex); self.menu = nil } : nil,
                                   onRetry: menu.role == .assistant && menu.canRetry && remoteSending == nil ? { retry(menu.turn); self.menu = nil } : nil,
                                   onDismiss: { self.menu = nil })
            }
        }
        .sheet(item: $selection) { SelectTextSheet(text: $0.text) }
        .sheet(item: $steps) { CollapsedStepsSheet(steps: $0.steps) }
        .onChange(of: conversation.id) { _, _ in menu = nil; selection = nil; steps = nil }
        .sheet(item: $destination) { target in
            NavigationStack {
                Group {
                    switch target {
                    case .attachment(let value): RemoteAttachmentDetailView(attachment: value)
                    case .file(let value): GeneratedFileDetailView(file: value)
                    case .changes(let value): ReviewChangesView(conversation: value)
                    case .link(let url): SharedConversationLinkView(url: url)
                    }
                }.toolbar {
                    // Files and attachments are the official preview sheet, closed with its X; the other
                    // destinations keep Done.
                    switch target {
                    case .file, .attachment:
                        ToolbarItem(placement: .topBarLeading) { FilePreviewCloseButton { destination = nil } }
                    default:
                        ToolbarItem(placement: .cancellationAction) { Button(L("generic_button_done")) { destination = nil } }
                    }
                }
            }
        }
        .background(SharedConversationExportHost(exporter: exporter).frame(width: 0, height: 0))
        .onChange(of: store.conversationBridgeGeneration) { _, _ in exporter.cancel(); destination = nil; media = .object([:]); loadError = nil; hasRendered = false; menu = nil; selection = nil; steps = nil }
        .task(id: mediaKey) { if remoteSending == nil { await loadPreviews() } }
        .task(id: captureKey) { if remoteSending == nil { await store.captureTranscriptImages(conversation.id, generation: store.conversationBridgeGeneration) } }
    }
    /// Gestures from the restyled transcript, resolved against the current conversation.
    @MainActor private func handle(_ event: TranscriptUIEvent) {
        let current = store.conversations.first { $0.id == conversation.id } ?? conversation
        switch event {
        case .messageMenu(let role, let place, let point, let canRetry, let canEdit):
            guard let turn = TranscriptTurns.resolve(place, in: current) else { return }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            menu = MessageMenuRequest(role: role, turn: turn, point: CGPoint(x: point.x, y: point.y),
                                      canRetry: canRetry, canEdit: canEdit, renderedIndex: place.index)
        case .steps(let place):
            guard let turn = TranscriptTurns.resolve(place, in: current) else { return }
            let list = TranscriptSteps.steps(turn)
            if !list.isEmpty { steps = TranscriptStepsItem(steps: list) }
        case .share(let place):
            guard let turn = TranscriptTurns.resolve(place, in: current) else { return }
            let text = TranscriptTurns.replyText(turn)
            if !text.isEmpty { ActivitySheet.present([text]) }
        }
    }
    @MainActor private func copy(_ text: String) {
        guard !text.isEmpty else { Snackbars.shared.toast(L("generic_copy_failed_toast")); return }
        UIPasteboard.general.string = text
        Snackbars.shared.toast(L("generic_copied_toast"))
    }
    @MainActor private func retry(_ turn: Turn) {
        guard let current = store.conversations.first(where: { $0.id == conversation.id }),
              SharedConversationResolver.canMutate(current, sending: store.isSending),
              current.turns.contains(where: { $0.id == turn.id }) else { return }
        Task { await store.retryResponse(conversationID: current.id, turnID: turn.id) }
    }
    @MainActor private func loadPreviews() async {
        let generation = store.conversationBridgeGeneration
        var previews: [String: JSONValue] = [:]
        var budget = TranscriptImageSnapshots.maximumInlineTotalBytes
        for attachment in conversation.turns.flatMap(\.attachments).filter({ $0.kind == "image" }).suffix(12) {
            do {
                guard let current = store.activeConversation,
                      SharedConversationResolver.attachment(attachment.id, conversation: current) == attachment else { continue }
                let value: String? = try await store.accountRequest { remote in
                    try await remote.rpc.call("attachmentPreview", args: [.string(attachment.id)], as: Optional<String>.self)
                }
                try Task.checkCancellation()
                guard generation == store.conversationBridgeGeneration, store.activeConversationID == conversation.id else { return }
                guard let current = store.activeConversation,
                      SharedConversationResolver.attachment(attachment.id, conversation: current) == attachment else { continue }
                guard let value, let comma = value.firstIndex(of: ","), value.utf8.count <= min(budget, 2 * 1024 * 1024),
                      ["data:image/png;base64", "data:image/jpeg;base64", "data:image/gif;base64", "data:image/webp;base64"].contains(String(value[..<comma])),
                      let data = Data(base64Encoded: String(value[value.index(after: comma)...])), UIImage(data: data) != nil else { continue }
                previews[attachment.id] = .string(value); budget -= value.utf8.count
            } catch is CancellationError { return }
            catch { store.validateSessionError(error) }
        }
        var generated: [String: JSONValue] = [:]
        for file in conversation.turns.flatMap(\.items).flatMap(\.generatedFiles).suffix(8) {
            guard file.isReady, file.blob == true, let digest = file.digest, generated[digest] == nil,
                  TranscriptImageSnapshots.inlineEligible(file, budget: budget) else { continue }
            do {
                try store.validateSharedExport(file, conversationID: conversation.id, generation: generation)
                let data = try await store.accountRequest { remote in try await remote.generatedFileData(file) }
                try Task.checkCancellation()
                guard generation == store.conversationBridgeGeneration, store.activeConversationID == conversation.id else { return }
                try store.validateSharedExport(file, conversationID: conversation.id, generation: generation)
                guard UIImage(data: data) != nil else { continue }
                let bytes = data.base64EncodedString(); guard bytes.utf8.count <= budget else { continue }
                generated[digest] = .string(bytes); budget -= bytes.utf8.count
            } catch is CancellationError { return }
            catch { store.validateSessionError(error) }
        }
        guard generation == store.conversationBridgeGeneration, store.activeConversationID == conversation.id else { return }
        media = .object(["attachmentPreviews": .object(previews), "generatedFileBytes": .object(generated)])
    }
}

/// Library and generated-file text previews use the same web Markdown, code,
/// table, math and diagram components, with no conversation mutation authority.
struct SharedDocumentView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    let id: String
    let language: String
    let content: String
    let name: String
    @State private var error: String?
    @State private var link: SharedConversationDestination?
    @State private var reload = UUID()
    private var handler: @MainActor (SharedConversationAction) async throws -> JSONValue {
        let generation = store.conversationBridgeGeneration
        return { request in
            guard store.account != nil, generation == store.conversationBridgeGeneration else { throw CancellationError() }
            switch request.type {
            case .copyText:
                guard let text = request.payload["text"].string, !text.isEmpty, content.contains(text) else { throw ServiceError.invalidResponse }
                UIPasteboard.general.string = text
            case .openLink:
                guard let text = request.payload["url"].string, SharedConversationResolver.containsLink(text, source: content), let url = SharedConversationProtocol.safeLink(text) else { throw ServiceError.invalidResponse }
                link = .link(url)
            default: throw ServiceError.server(L("generic_error_something_went_wrong_try_again"), "DISPLAY_ONLY")
            }
            return .null
        }
    }
    var body: some View {
        ZStack {
            if store.account != nil {
                SharedConversationWebView(state: .object(["document": .object(["id": .string(id), "language": .string(language), "content": .string(content), "name": .string(name)]), "theme": .string(colorScheme == .dark ? "dark" : "light"), "locale": .string("zh-CN")]), watchdogPaused: scenePhase != .active, action: handler, onFailure: { error = $0 })
                    .id(id + store.conversationBridgeGeneration.uuidString + reload.uuidString)
            }
            if let error {
                VStack { Text(error); Button(L("generic_retry")) { self.error = nil; reload = UUID() } }.padding().background(Brand.surface)
            }
        }.sheet(item: $link) { destination in
            if case .link(let url) = destination { SharedConversationLinkView(url: url) }
        }.onChange(of: store.conversationBridgeGeneration) { _, _ in link = nil }
    }
}

private struct SharedConversationLinkView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIViewController {
        if ["https", "http"].contains(url.scheme?.lowercased() ?? "") { return SFSafariViewController(url: url) }
        // mailto is intentionally not submitted or opened automatically.
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        return controller
    }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}
}

struct SharedConversationWebView: UIViewRepresentable {
    let state: JSONValue
    let watchdogPaused: Bool
    let action: @MainActor (SharedConversationAction) async throws -> JSONValue
    let onFailure: @MainActor (String) -> Void
    var onRendered: (@MainActor () -> Void)? = nil
    /// Long press, steps row and Share from the official transcript layer.
    var onUI: (@MainActor (TranscriptUIEvent) -> Void)? = nil
    var commands: TranscriptCommands? = nil
    func makeCoordinator() -> Coordinator { Coordinator(action: action, onFailure: onFailure) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.setURLSchemeHandler(SharedConversationAssets(), forURLScheme: SharedConversationAssets.scheme)
        config.userContentController.add(context.coordinator, name: "claudexConversation")
        // The official look and gestures run in an isolated content world (TranscriptOfficialStyle).
        let ui = TranscriptUIHandler(coordinator: context.coordinator)
        config.userContentController.add(ui, contentWorld: .defaultClient, name: TranscriptOfficialStyle.messageHandler)
        config.userContentController.addUserScript(WKUserScript(source: TranscriptOfficialStyle.script(), injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        context.coordinator.textPercent = Self.textPercent(context)
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.backgroundColor = .clear
        view.isInspectable = false
        view.accessibilityIdentifier = "shared-web-pc-transcript"
        context.coordinator.webView = view
        context.coordinator.onUI = onUI
        commands?.webView = view
        context.coordinator.update(state: state, watchdogPaused: watchdogPaused, action: action, onFailure: onFailure, onRendered: onRendered)
        view.load(URLRequest(url: SharedConversationAssets.entry))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        let percent = Self.textPercent(context)
        if context.coordinator.textPercent != percent {
            context.coordinator.textPercent = percent
            context.coordinator.applyTextSize()
        }
        context.coordinator.onUI = onUI
        commands?.webView = view
        context.coordinator.update(state: state, watchdogPaused: watchdogPaused, action: action, onFailure: onFailure, onRendered: onRendered)
    }
    /// The transcript's text follows the system text size, as the native views
    /// around it do; only the text grows, so lines rewrap in the same width.
    private static func textPercent(_ context: Context) -> Int {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(context.environment.dynamicTypeSize))
        let zoom = SharedConversationTextScale.zoom(bodyPointSize: Double(UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize))
        return Int((zoom * 100).rounded())
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.dispose()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "claudexConversation")
        view.configuration.userContentController.removeScriptMessageHandler(forName: TranscriptOfficialStyle.messageHandler, contentWorld: .defaultClient)
        view.configuration.userContentController.removeAllUserScripts()
        view.navigationDelegate = nil
        view.stopLoading()
        // Blank after removing bridge, so history/screenshots cannot expose the prior account.
        view.loadHTMLString("", baseURL: nil)
    }

    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        /// The system text size for the page, in percent of its own; set once
        /// the page has loaded and again whenever it changes.
        var textPercent = 100
        func applyTextSize() {
            webView?.evaluateJavaScript("document.documentElement.style.webkitTextSizeAdjust = '\(textPercent)%';")
        }
        weak var webView: WKWebView?
        var onUI: (@MainActor (TranscriptUIEvent) -> Void)?
        /// A gesture from the isolated transcript script. It only names a rendered position;
        /// SharedConversationView resolves it against native state.
        func receiveUI(_ message: WKScriptMessage) {
            guard !disposed, message.webView === webView, message.frameInfo.isMainFrame,
                  message.frameInfo.request.url == SharedConversationAssets.entry,
                  JSONSerialization.isValidJSONObject(message.body),
                  let data = try? JSONSerialization.data(withJSONObject: message.body), data.count <= 200_000,
                  let raw = try? JSONDecoder().decode(JSONValue.self, from: data),
                  let event = TranscriptUIEvent.decode(raw) else { return }
            onUI?(event)
        }
        private var lease = SharedConversationLease()
        private var state: JSONValue?
        private var pumpTask: Task<Void, Never>?
        private var timeoutTask: Task<Void, Never>?
        private var requests: [String: Task<Void, Never>] = [:]
        private var disposed = false
        private var watchdogPaused = false
        private var action: @MainActor (SharedConversationAction) async throws -> JSONValue
        private var onFailure: @MainActor (String) -> Void
        private var onRendered: (@MainActor () -> Void)?
        init(action: @escaping @MainActor (SharedConversationAction) async throws -> JSONValue, onFailure: @escaping @MainActor (String) -> Void) {
            self.action = action; self.onFailure = onFailure
        }
        func update(state: JSONValue, watchdogPaused: Bool, action: @escaping @MainActor (SharedConversationAction) async throws -> JSONValue, onFailure: @escaping @MainActor (String) -> Void, onRendered: (@MainActor () -> Void)? = nil) {
            self.action = action; self.onFailure = onFailure; self.onRendered = onRendered
            if self.watchdogPaused != watchdogPaused {
                self.watchdogPaused = watchdogPaused
                timeoutTask?.cancel()
                if !watchdogPaused { armTimeout() }
            }
            guard !disposed, self.state != state else { return }
            self.state = state; lease.enqueue(state); schedulePump()
            if !lease.ready { armTimeout() }
        }
        private func schedulePump() {
            guard !disposed, pumpTask == nil, lease.ready, lease.inFlight == nil, lease.pending != nil else { return }
            pumpTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(80))
                guard !Task.isCancelled, let self, !disposed else { return }
                pumpTask = nil
                guard let next = lease.next(now: ProcessInfo.processInfo.systemUptime), let webView else { schedulePump(); return }
                do {
                    let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(next))
                    _ = try await webView.callAsyncJavaScript(next["document"].object == nil ? "window.ClaudexConversation.render(state)" : "window.ClaudexConversation.renderDocument(state)", arguments: ["state": object], in: nil, contentWorld: .page)
                    guard !disposed, lease.inFlight == next["revision"].integer else { return }
                    armTimeout()
                } catch { if !disposed { fail(L("chat_load_failed_reload")) } }
            }
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !disposed, message.name == "claudexConversation", message.webView === webView,
                  message.frameInfo.isMainFrame, message.frameInfo.request.url == SharedConversationAssets.entry,
                  message.frameInfo.securityOrigin.protocol == SharedConversationAssets.scheme,
                  message.frameInfo.securityOrigin.host == "bundle",
                  JSONSerialization.isValidJSONObject(message.body),
                  let data = try? JSONSerialization.data(withJSONObject: message.body),
                  let event = try? SharedConversationProtocol.decode(data) else { return }
            switch event {
            case .ready:
                // Duplicate ready cannot reset the lease or re-authorize old request IDs.
                timeoutTask?.cancel(); lease.markReady(); schedulePump()
            case .applied(let session, let revision):
                if lease.acknowledge(sessionID: session, revision: revision) { timeoutTask?.cancel(); onRendered?(); schedulePump() }
            case .rejected(let session, let revision, _):
                if lease.acknowledge(sessionID: session, revision: revision) { fail(L("chat_load_failed_reload")) }
            case .cancel(let session, let request):
                guard session == lease.sessionID, let original = lease.finish(request) else { return }
                requests.removeValue(forKey: request)?.cancel()
                sendResult(SharedConversationProtocol.result(for: original, ok: false, error: L("claudex_msg_action_stopped"), cancelled: true))
            case .action(let request):
                do { try lease.begin(request, now: ProcessInfo.processInfo.systemUptime) }
                catch {
                    if request.sessionID == lease.sessionID { sendResult(SharedConversationProtocol.result(for: request, ok: false, error: L("claudex_msg_too_many_actions"))) }
                    return
                }
                let handler = action
                requests[request.requestID] = Task { [weak self] in
                    guard let self else { return }
                    let result: JSONValue
                    do { result = SharedConversationProtocol.result(for: request, ok: true, value: try await handler(request)) }
                    catch is CancellationError { result = SharedConversationProtocol.result(for: request, ok: false, error: L("claudex_msg_action_stopped"), cancelled: true) }
                    catch { result = SharedConversationProtocol.result(for: request, ok: false, error: error.localizedDescription) }
                    guard !disposed, lease.sessionID == request.sessionID, lease.finish(request.requestID) != nil else { return }
                    requests[request.requestID] = nil
                    sendResult(result)
                }
            }
        }
        private func sendResult(_ result: JSONValue) {
            guard !disposed, let webView, let data = try? JSONEncoder().encode(result), let object = try? JSONSerialization.jsonObject(with: data) else { return }
            Task { _ = try? await webView.callAsyncJavaScript("window.ClaudexConversation.result(reply)", arguments: ["reply": object], in: nil, contentWorld: .page) }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            decisionHandler(!disposed && navigationAction.targetFrame?.isMainFrame == true && navigationAction.request.url == SharedConversationAssets.entry && navigationAction.navigationType == .other ? .allow : .cancel)
        }
        private func armTimeout() {
            timeoutTask?.cancel()
            guard !disposed, !watchdogPaused, !lease.ready || lease.inFlight != nil else { return }
            let session = lease.sessionID, revision = lease.inFlight
            // Cold WebKit process startup and the shared module graph can take
            // longer than a render acknowledgement, especially on a simulator.
            // Keep a bounded startup grace without extending ready-page deadlines.
            let delay: Duration = lease.ready ? .seconds(10) : .seconds(30)
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, let self, !disposed, !watchdogPaused, lease.sessionID == session else { return }
                if let revision {
                    guard lease.inFlight == revision else { return }
                    fail(L("chat_load_failed_reload"))
                } else if !lease.ready { fail(L("chat_load_failed_reload")) }
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { applyTextSize(); armTimeout() }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail(L("chat_load_failed_reload")) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if !disposed { fail(L("chat_load_failed")) } }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if !disposed { fail(L("chat_load_failed")) } }
        private func fail(_ message: String) { onFailure(message); dispose() }
        func dispose() {
            guard !disposed else { return }; disposed = true
            pumpTask?.cancel(); timeoutTask?.cancel(); requests.values.forEach { $0.cancel() }; requests = [:]
            if let webView { webView.evaluateJavaScript("window.ClaudexConversation?.dispose()", completionHandler: nil) }
            lease.rotate(); state = nil
        }
    }
}

/// Serve only packaged, non-symlink files. This origin cannot access the network,
/// an arbitrary file path, Keychain, native RPC or another application directory.
private final class SharedConversationAssets: NSObject, WKURLSchemeHandler {
    static let scheme = "claudex-conversation"
    static let entry = URL(string: "claudex-conversation://bundle/index.html")!
    private let root = Bundle.main.resourceURL?.appendingPathComponent("SharedConversation", isDirectory: true)
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.scheme == Self.scheme, url.host == "bundle", url.user == nil, url.password == nil, url.port == nil,
              url.query == nil, url.fragment == nil, urlSchemeTask.request.httpMethod == "GET",
              let root, let path = url.path.removingPercentEncoding, !path.contains("\\"),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile)); return }
        // The open fonts the official transcript layer uses (Resources/Fonts, OFL).
        if path.hasPrefix("/native-fonts/") {
            let name = String(path.dropFirst("/native-fonts/".count))
            guard TranscriptOfficialStyle.fonts.contains(name),
                  let file = Bundle.main.resourceURL?.appendingPathComponent("Fonts", isDirectory: true).appendingPathComponent(name),
                  let data = try? Data(contentsOf: file),
                  let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": name.hasSuffix(".otf") ? "font/otf" : "font/ttf", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff"]) else { urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return }
            urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
            return
        }
        guard path == "/index.html" || path.hasPrefix("/assets/") else { urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile)); return }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.resolvingSymlinksInPath().path.hasPrefix(root.resolvingSymlinksInPath().path + "/"),
              let data = try? Data(contentsOf: file), data.count <= 16 * 1024 * 1024 else { urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return }
        let mime = ["html": "text/html", "js": "text/javascript", "css": "text/css", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "png": "image/png", "svg": "image/svg+xml", "jpg": "image/jpeg", "webp": "image/webp"][file.pathExtension] ?? "application/octet-stream"
        let headers = ["Content-Type": mime, "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; script-src 'self' claudex-conversation:; style-src 'self' 'unsafe-inline' claudex-conversation:; img-src 'self' data: blob:; font-src 'self' data: claudex-conversation:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else { urlSchemeTask.didFailWithError(URLError(.badServerResponse)); return }
        urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

// MARK: Official transcript layer (TranscriptOfficialStyle)

/// Receives the isolated transcript script's messages; kept apart from the page bridge handler.
@MainActor private final class TranscriptUIHandler: NSObject, WKScriptMessageHandler {
    weak var coordinator: SharedConversationWebView.Coordinator?
    init(coordinator: SharedConversationWebView.Coordinator) { self.coordinator = coordinator }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == TranscriptOfficialStyle.messageHandler, message.world == .defaultClient else { return }
        coordinator?.receiveUI(message)
    }
}

/// Native requests to the rendered transcript, run in the same isolated world as the layer.
@MainActor final class TranscriptCommands {
    weak var webView: WKWebView?
    /// Opens the renderer's own inline editor for a user message (the official "Edit" item).
    func edit(renderedIndex: Int) {
        let script = """
        const turn = Array.from(document.querySelectorAll('.messages > .turn'))[index];
        const button = turn && Array.from(turn.querySelectorAll('.user-message-actions button'))
          .find((b) => ['Edit', '编辑'].includes((b.getAttribute('aria-label') || '').trim()));
        if (!button || button.disabled) return false;
        button.click();
        turn.scrollIntoView({ block: 'nearest' });
        return true;
        """
        Task { _ = try? await webView?.callAsyncJavaScript(script, arguments: ["index": renderedIndex], in: nil, contentWorld: .defaultClient) }
    }
}

struct TranscriptTextSelection: Identifiable { let id = UUID(); let text: String }
struct TranscriptStepsItem: Identifiable { let id = UUID(); let steps: [TranscriptStep] }

/// The generic error state: warning icon, "Something went wrong", "Try again".
struct TranscriptErrorState: View {
    let detail: String
    let retry: () -> Void
    var body: some View {
        VStack(spacing: 12) {
            AppGlyphView(.warningCircle, size: 32).foregroundStyle(Palette.text500)
            Text(L("generic_error_something_went_wrong")).typeStyle(.bodyLargeStrong).foregroundStyle(Palette.text100)
            Text(detail).typeStyle(.body).foregroundStyle(Palette.text500).multilineTextAlignment(.center)
            Button(L("generic_try_again"), action: retry).claudeButton(.secondary, size: .small)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.bg100)
    }
}

extension TranscriptOfficialStyle {
    /// The isolated-world script with its stylesheet and catalogue strings filled in.
    static func script() -> String {
        func json(_ value: Any) -> String {
            (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])).map { String(decoding: $0, as: UTF8.self) } ?? "null"
        }
        let strings = ["share": L("generic_share"), "incomplete": L("chat_response_incomplete"), "retry": L("generic_retry")]
        return scriptTemplate
            .replacingOccurrences(of: "__CLAUDEX_STRINGS__", with: json(strings))
            .replacingOccurrences(of: "__CLAUDEX_CSS__", with: json(css))
    }
}
