import SwiftUI
import UserNotifications
import WidgetKit
import UniformTypeIdentifiers
import UIKit

/// The process-wide exception callback cannot capture the store, so the latest account and consent live here.
enum CrashReports {
    static var directory: URL?
    static var account: String?
    static var consent = false
    static var client = DiagnosticClient(appVersion: "0", platform: "ios", arch: "arm64", osVersion: "iOS")
    static var installed = false
    static func install() {
        guard !installed else { return }
        installed = true
        let handler: @convention(c) (NSException) -> Void = { exception in CrashReports.note(exception) }
        NSSetUncaughtExceptionHandler(handler)
    }
    static func note(_ exception: NSException) {
        guard consent, let directory, let account, !account.isEmpty else { return }
        let queue = DiagnosticQueue()
        let file = DiagnosticQueueFile.location(directory: directory, account: account)
        DiagnosticQueueFile.load(file, queue: queue)
        queue.recordCrash(exception.name.rawValue, frames: exception.callStackSymbols.compactMap(frame), client: client)
        DiagnosticQueueFile.store(file, queue: queue, consent: true)
    }
    private static func frame(_ symbol: String) -> String? {
        guard let match = symbol.range(of: "[A-Za-z0-9_.]+\\.swift:[0-9]{1,6}", options: .regularExpression) else { return nil }
        return String(symbol[match])
    }
}

enum ChatRoute: Hashable { case history, conversation(String) }

enum TopUpResult {
    case browser(URL, Int)
    case qr(String, Int)
    case failed(String)
}

enum RedeemAttempt {
    case redeemed(BillingPolicy.Redeemed)
    case problem(String)
}

enum AccountExportName {
    static func parse(_ disposition: String?) -> String {
        guard let disposition,
              let range = disposition.range(of: #"filename="([A-Za-z0-9._-]{1,80})\.zip""#, options: .regularExpression)
        else { return "claudex-export.zip" }
        let match = disposition[range]
        let name = match.dropFirst("filename=\"".count).dropLast()
        return name.contains("..") ? "claudex-export.zip" : String(name)
    }
}

struct LocalAttachment: Identifiable, Equatable, Codable {
    var id = UUID()
    let name: String
    var url: URL
    let size: Int
    var uploaded: Attachment?
}
@MainActor
final class AppStore: ObservableObject {
    @Published var section: AppSection = .chat {
        didSet {
            if oldValue != section {
                conversationBridgeGeneration = UUID()
                if section == .chat || section == .projects { mode = .chat }
            }
        }
    }
    @Published var sidebarPresented = false
    @Published var chatPath: [ChatRoute] = []
    @Published private(set) var chatSurfaceConversationID: String?
    @Published var snapshot: Snapshot? { didSet { syncReplyBackground(); noteFinishedReplies(); noteApprovals(); publishWidgetChats() } }
    private var replyBackground: UIBackgroundTaskIdentifier = .invalid
    @Published var modelCatalog = ModelCatalogState.loading
    @Published var account: SessionAccount? { didSet { applyPendingLink(); applyPendingFile(); applyPendingShare() } }
    private var pendingLink: AppLink?
    private var pendingFile: URL?
    private var pendingShare = false
    @Published private(set) var isRestoringSession = true
    var authenticationDestination: AuthenticationDestination {
        AuthenticationDestination.resolve(restoring: isRestoringSession, signedIn: account != nil)
    }
    @Published var isLoading = false
    @Published var isSending = false
    @Published private(set) var isSavingCodePermission = false
    @Published private(set) var conversationActions: Set<String> = []
    private var deletedConversationIDs: Set<String> = []
    private var markingRead: Set<String> = []
    private var deletedProjectIDs: Set<String> = []
    @Published private(set) var deletingProjects: Set<String> = []
    @Published var uploadProgress: Double?
    @Published private(set) var isUploading = false
    private var sendGeneration = 0
    @Published var errorMessage: String?
    @Published var connectionStatus = ""
    @Published private(set) var eventsLive = false
    /// The account's online computers and the Code conversation opened on one.
    let devices = DeviceController()
    private struct ConversationModelSelection: Equatable {
        let key: ModelChoice.Key
        let effort: ModelEffort?
    }
    @Published private var conversationModelSelection: ConversationModelSelection?
    @Published private var modelPreferences: [ChatMode: ModelPreference] = [:]
    private let modelDefaults: UserDefaults
    @Published private(set) var isSavingModel = false
    @Published private(set) var accountGeneration = UUID()
    @Published private(set) var toolPolicy: JSONValue?
    @Published private(set) var draftWebSearch = false
    @Published private(set) var draftResearch = false
    /// Knowledge bases the service offers, and the new chat's choice (off by default).
    @Published private(set) var knowledgeBases: [KnowledgeBase] = []
    @Published private(set) var draftKnowledge: [String] = []
    @Published private(set) var draftConnectors: [String: Bool] = [:]
    @Published private(set) var connectorPolicy: JSONValue?
    @Published var mode: ChatMode = .chat { didSet { syncComposerDraftScope() } }
    @Published var composerText = "" {
        didSet {
            guard !applyingComposerDraft, oldValue != composerText else { return }
            composerEditVersions[composerScope, default: 0] += 1
            saveComposerDraft()
        }
    }
    @Published var attachments: [LocalAttachment] = [] {
        didSet { if oldValue != attachments { saveComposerDraft() } }
    }
    private(set) var composerScope: ComposerDraftScope = .new(.chat)
    private var composerArchive = ComposerDraftArchive()
    @Published private var pendingSends: [ComposerDraftScope: PendingComposerSend] = [:]
    var pendingSend: PendingComposerSend? { pendingSends[composerScope] }
    var canRetryPendingSend: Bool {
        pendingSend?.canRetry(currentSupport: snapshot?.host?["capabilities"]["nativeSendReceipts"].bool == true) == true
    }
    private var applyingComposerDraft = false
    private var composerEditVersions: [ComposerDraftScope: Int] = [:]
    private var incognitoComposerScopes: Set<ComposerDraftScope> = []
    private var submittedDraft: (scope: ComposerDraftScope, draft: ComposerDraft)?
    private let composerDraftRoot: URL?
    private var projectComposerID: String? { didSet { syncComposerDraftScope() } }
    @Published private var composerProjectChoice: ComposerProjectChoice?
    @Published var activeConversationID: String? {
        didSet {
            guard oldValue != activeConversationID else { return }
            syncComposerDraftScope()
            conversationModelSelection = nil
            imageCaptures = [:]
            // A first send from the new-chat page keeps the bridge: the transcript mounted
            // under the greeting only ever held the empty draft, so it carries on.
            if keepsDraftBridge { keepsDraftBridge = false } else { conversationBridgeGeneration = UUID() }
            hydrator.select(activeConversationID)
            refreshCodeQueue()
        }
    }
    private var keepsDraftBridge = false
    @Published private(set) var transcriptLoads: [String: TranscriptLoadState] = [:]
    @Published var preparedRepository: RepositoryReference? {
        didSet {
            guard oldValue != preparedRepository, !applyingComposerDraft else { return }
            composerArchive.repository = preparedRepository
            flushComposerDrafts()
        }
    }
    var preparedProjectID: String? {
        guard mode == .chat else { return nil }
        switch composerProjectChoice {
        case .project(let id): return id
        case .some(.none): return nil
        case nil: return projectComposerID
        }
    }
    @Published var presentLogin = false
    @Published var lastRefresh: Date?
    let service: any ClaudexService
    let session: NativeSession?
    let configurationError: String?
    private var reducer = StreamReducer()
    private var mutations = StreamMutationTracker()
    private lazy var hydrator: ConversationHydrator = {
        let service = self.service
        let loader = ConversationHydrator(fetch: { id in try await service.conversationTurns(id) })
        loader.onHydrated = { [weak self] conversation in self?.applyHydratedConversation(conversation) }
        loader.onStateChanged = { [weak self, weak loader] in self?.transcriptLoads = loader?.states ?? [:] }
        loader.onFailure = { [weak self] error in self?.validateSessionError(error) }
        return loader
    }()
    private var connection: EventConnection?
    private var resyncTask: Task<Void, Never>?
    private var recovery = StreamRecovery()
    private var generation = 0
    private var refreshGeneration = 0
    private var refreshTracker = SnapshotRefreshTracker()
    @Published private(set) var conversationBridgeGeneration = UUID()
    @Published private var imageCaptures: [String: TranscriptImageCapture] = [:]
    private var resyncGeneration = 0
    private var isActive = true
    private var sendTask: Task<Void, Never>?
    @Published private(set) var composerQueue = ComposerQueue()
    @Published private var codeQueues: [String: [CodeQueueEntry]] = [:]
    private var codeQueueRead: Task<Void, Never>?
    private var codeQueueRevision = 0
    private var codeQueueRefreshPending = false
    private var pendingCodeSubmissions: [String: CodeQueueSubmission] = [:]
    private var queueTasks: [String: Task<Void, Never>] = [:]
    private var queueTaskEntries: [String: UUID] = [:]
    private var queueFiles: [UUID: [LocalAttachment]] = [:]
    private var runningDraftFiles: Set<URL> = []
    private let serviceOrigin: URL?
    private let updateTransport: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config)
    }()
    private var dismissedUpdate: String?
    private var updateCheck: Task<Void, Never>?
    private let diagnostics = DiagnosticQueue()
    private var diagnosticsAccount: String?
    private var serviceCollectsDiagnostics = false
    private var serviceCollectsFeedback = false
    private var diagnosticsFlagLoaded = false
    /// The newer iOS release listed by the service, shown until the person updates or chooses later.
    @Published private(set) var offeredRelease: StoreRelease?
    init(session: NativeSession, service: any ClaudexService) {
        self.session = session; self.service = service; configurationError = nil; modelDefaults = .standard
        composerDraftRoot = nil
        serviceOrigin = nil
    }
    /// Dependency injection for local service regressions; production uses init().
    init(service: any ClaudexService, modelDefaults: UserDefaults = .standard, composerDraftRoot: URL? = nil) {
        self.service = service; session = nil; configurationError = nil; self.modelDefaults = modelDefaults
        self.composerDraftRoot = composerDraftRoot
        serviceOrigin = nil
    }
    init() {
        CrashReports.install()
        modelDefaults = .standard
        composerDraftRoot = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ComposerDrafts", isDirectory: true)
        let origin = Bundle.main.object(forInfoDictionaryKey: "CLAUDEX_SERVICE_URL") as? String ?? ""
        let resolved = URL(string: origin).flatMap { url in url.scheme == "https" && url.host != nil ? url : nil }
        serviceOrigin = resolved
        if let url = resolved, let host = url.host {
            do {
                let auth = try AuthHTTPClient(baseURL: url)
                let native = NativeSession(http: auth, vault: KeychainVault(service: "\(Bundle.main.bundleIdentifier ?? "Claudex").https://\(host.lowercased()):\(url.port ?? 443)"))
                let tabID = UUID().uuidString
                let rpc = try RPCClient(baseURL: url, tabID: tabID, session: native)
                session = native
                service = RemoteClaudexService(rpc: rpc)
                configurationError = nil
                connection = EventConnection(baseURL: url, session: native, tabID: tabID)
            } catch {
                session = nil; service = UnavailableClaudexService(); configurationError = error.localizedDescription
            }
        } else { session = nil; service = UnavailableClaudexService(); configurationError = ServiceError.configuration.localizedDescription }
        if let remote = service as? RemoteClaudexService { devices.client = DeviceClient(rpc: remote.rpc) }
        connection?.cursor = { [weak self] in self?.reducer.lastSequence }
        connection?.onFrame = { [weak self] in self?.receive($0) }
        connection?.onStatus = { [weak self] status in self?.connectionStatus = status; self?.eventsLive = status == "已连接" }
        connection?.onSignedOut = { [weak self] in self?.invalidateSession(message: L("error_account_session_invalid")); Task { try? await self?.session?.clearLocal() } }
    }
    private func syncReplyBackground() {
        let running = snapshot?.conversations.contains(where: \.isRunning) == true
        let apply = { [weak self] in
            guard let self else { return }
            if running {
                guard replyBackground == .invalid else { return }
                replyBackground = UIApplication.shared.beginBackgroundTask(withName: "claudex-reply") { [weak self] in
                    DispatchQueue.main.async { self?.endReplyBackground() }
                }
            } else { endReplyBackground() }
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }
    private var runningReplies: Set<String>?
    private var scheduleBaseline: [Routine]?
    private var postedApprovals: Set<String> = []
    private var pendingApprovalNotices: Set<String> = []
    private var decidingApprovals: Set<String> = []
    private var replyDelegate: ReplyNotificationDelegate?
    private func publishWidgetChats() {
        guard let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.cn.zecous.claudex") else { return }
        let visible = (snapshot?.conversations ?? []).filter { !$0.archived && !$0.incognito }
        let ordered = visible.filter(\.pinned) + visible.filter { !$0.pinned }.sorted { $0.updatedAt > $1.updatedAt }
        let rows = ordered.prefix(4).map { ["id": $0.id, "title": String($0.title.prefix(80))] }
        if let data = try? JSONSerialization.data(withJSONObject: ["rows": rows]) {
            try? data.write(to: folder.appendingPathComponent("chats.json"), options: .atomic)
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
    private func noteFinishedReplies() {
        let now = Set((snapshot?.conversations ?? []).filter(\.isRunning).map(\.id))
        let previous = runningReplies
        runningReplies = now
        guard let previous, !isActive, UserDefaults.standard.object(forKey: "reply-notifications") as? Bool ?? true else { return }
        for id in previous.subtracting(now) {
            let title = snapshot?.conversations.first { $0.id == id }?.title ?? ""
            ReplyNotifier.post(id: id, conversationTitle: title)
        }
    }
    /// The first list only remembers the runs. A later list announces a run that has since finished or failed.
    func noteSchedules() async {
        guard account != nil, let remote else { return }
        let next: [Routine]
        do { next = try await remote.schedules() } catch { return }
        let previous = scheduleBaseline
        scheduleBaseline = next
        guard let previous, snapshot?.settings.raw["notifySchedules"].bool ?? true else { return }
        for notice in RoutineNotices.completions(previous: previous, next: next) {
            if isActive, activeConversationID == notice.conversationId { continue }
            ScheduleNotifier.post(notice)
        }
    }
    private func approvalKey(_ approval: JSONValue) -> String? {
        if let id = approval["id"].string, !id.isEmpty { return id }
        if let id = approval["id"].integer { return String(id) }
        return nil
    }
    private func noteApprovals() {
        let approvals = snapshot?.approvals ?? []
        let current = Set(approvals.compactMap { approvalKey($0) })
        for id in postedApprovals.subtracting(current) {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["approval-\(id)"])
        }
        postedApprovals.formIntersection(current)
        guard !isActive, UserDefaults.standard.object(forKey: "reply-notifications") as? Bool ?? true else { return }
        for approval in approvals {
            guard let id = approvalKey(approval), !postedApprovals.contains(id), !pendingApprovalNotices.contains(id) else { continue }
            let method = approval["method"].string ?? ""
            let kind = ApprovalPolicy.kind(method)
            let buttons = kind == .command || kind == .fileChange || kind == .permissions
            let conversation = approval["conversationId"].string ?? ""
            let task = scheduleBaseline?.first { $0.raw["conversationId"].string == conversation && ["starting", "running"].contains($0.raw["lastRunStatus"].string ?? "") }
            let title = task.map { String($0.name.prefix(80)) } ?? (snapshot?.conversations.first { $0.id == conversation }?.title ?? "")
            pendingApprovalNotices.insert(id)
            ApprovalNotifier.post(id: id, conversation: conversation, conversationTitle: title, task: task != nil, buttons: buttons) { [weak self] sent in
                DispatchQueue.main.async {
                    self?.pendingApprovalNotices.remove(id)
                    if sent { self?.postedApprovals.insert(id) }
                }
            }
        }
    }
    /// Allow once or Decline from a notification. The answer matches the card, and a second tap waits.
    func decideApproval(id: String, allow: Bool) async {
        guard !decidingApprovals.contains(id) else { return }
        guard let approval = snapshot?.approvals.first(where: { approvalKey($0) == id }) else {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["approval-\(id)"])
            return
        }
        let method = approval["method"].string ?? ""
        let kind = ApprovalPolicy.kind(method)
        guard kind == .command || kind == .fileChange || kind == .permissions, let remote else { return }
        decidingApprovals.insert(id)
        defer { decidingApprovals.remove(id) }
        let response = ApprovalPolicy.response(method: method, params: approval["params"], allow: allow)
        do {
            let _: JSONValue = try await remote.rpc.call("approve", args: [approval["id"], response], as: JSONValue.self)
            await refresh()
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["approval-\(id)"])
        } catch {
            validateSessionError(error)
        }
    }
    private func installReplyNotifications() {
        let allow = UNNotificationAction(identifier: "approval-allow", title: L("tool_approval_button_allow_once"), options: [])
        let decline = UNNotificationAction(identifier: "approval-deny", title: L("tool_approval_button_decline"), options: [.destructive])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "approval", actions: [allow, decline], intentIdentifiers: [], options: []),
        ])
        let delegate = ReplyNotificationDelegate()
        delegate.open = { [weak self] id in DispatchQueue.main.async { self?.openNotifiedConversation(id) } }
        delegate.decide = { [weak self] id, allow, done in
            Task { @MainActor in
                await self?.decideApproval(id: id, allow: allow)
                done()
            }
        }
        replyDelegate = delegate
        UNUserNotificationCenter.current().delegate = delegate
        if UserDefaults.standard.object(forKey: "reply-notifications") as? Bool ?? true {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }
    func open(_ url: URL) {
        if url.isFileURL { pendingFile = url; applyPendingFile(); return }
        if url.scheme == "claudex", url.host == "share" { pendingShare = true; applyPendingShare(); return }
        pendingLink = AppLinks.parse(url.absoluteString)
        applyPendingLink()
    }
    private func applyPendingShare() {
        guard account != nil, pendingShare, let inbox = ShareInbox.take() else { return }
        pendingShare = false
        let inConversation = activeConversationID != nil
        let forceNew = UserDefaults.standard.object(forKey: "share_defaults_to_new_chat") as? Bool ?? false
        if forceNew || !inConversation {
            if forceNew && inConversation { Snackbars.shared.keepThroughNavigation() }
            section = .chat
            sidebarPresented = false
            chatPath = []
            activeConversationID = nil
            mode = .chat
            if forceNew && inConversation { Snackbars.shared.show(L("share_opened_new_chat")) }
        }
        if !inbox.text.isEmpty {
            let text = String(inbox.text.prefix(10_000))
            composerText = composerText.isEmpty ? text : composerText + "\n" + text
        }
        for file in inbox.files { addFile(file) }
        inbox.remove()
    }
    private func applyPendingFile() {
        guard account != nil, let file = pendingFile else { return }
        pendingFile = nil
        section = .chat
        sidebarPresented = false
        mode = .chat
        addFile(file)
    }
    private func applyPendingLink() {
        guard account != nil, let link = pendingLink else { return }
        pendingLink = nil
        switch link {
        case .chat(let id): openNotifiedConversation(id)
        case .project(let id):
            section = .projects
            sidebarPresented = false
            openProjectComposer(id)
        case .composer(let mode, let prompt):
            section = mode == .cowork ? .cowork : mode == .code ? .code : .chat
            self.mode = mode
            sidebarPresented = false
            chatPath = []
            if let prompt, !prompt.isEmpty, composerText.isEmpty { composerText = prompt }
        }
    }
    private func openNotifiedConversation(_ id: String) {
        section = .chat
        sidebarPresented = false
        activeConversationID = id
        if chatPath.isEmpty { chatSurfaceConversationID = id } else { chatPath.append(.conversation(id)) }
    }
    private func endReplyBackground() {
        let task = replyBackground
        replyBackground = .invalid
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
    }
    var conversations: [Conversation] {
        (snapshot?.conversations ?? []).map { TranscriptImageSnapshots.applying(Array(imageCaptures.values), to: $0) }
            .sorted { $0.pinned == $1.pinned ? $0.updatedAt > $1.updatedAt : $0.pinned }
    }
    var activeConversation: Conversation? { conversations.first { $0.id == activeConversationID } }
    var selectedModelID: String { selectedModelKey(mode: mode, conversation: activeConversation)?.modelID ?? "" }
    var selectedProviderID: String { selectedModelKey(mode: mode, conversation: activeConversation)?.providerID ?? "" }
    var selectedProvider: Provider? {
        guard let settings = snapshot?.settings else { return nil }
        let providerID = selectedProviderID.isEmpty ? settings.activeProviderId : selectedProviderID
        return settings.providers.first { $0.id == providerID }
    }
    var modelChoices: [ModelChoice] {
        ModelMenuPolicy.available(providers: snapshot?.settings.providers ?? [], catalog: modelCatalog.catalog)
    }
    func selectedModelKey(mode: ChatMode, conversation: Conversation?) -> ModelChoice.Key? {
        if let conversation {
            if conversation.id == activeConversationID, let selection = conversationModelSelection { return selection.key }
            return .init(providerID: conversation.providerId, modelID: conversation.model)
        }
        return ModelMenuPolicy.initialChoice(modelChoices, catalog: modelCatalog.catalog,
            providerID: snapshot?.settings.activeProviderId ?? "", saved: modelPreferences[mode]?.selected)?.key
    }
    func selectedModel(mode: ChatMode, conversation: Conversation?) -> ModelChoice? {
        let key = selectedModelKey(mode: mode, conversation: conversation)
        return modelChoices.first { $0.key == key }
    }
    func selectedEffort(_ choice: ModelChoice, mode: ChatMode, conversation: Conversation?) -> ModelEffort? {
        let preferred: ModelEffort?
        if let conversation {
            if conversation.id == activeConversationID, let selection = conversationModelSelection, selection.key == choice.key {
                preferred = selection.effort
            } else if conversation.model == choice.model.id, conversation.providerId == choice.providerID {
                preferred = conversation.extensionFields["effort"]?.string.flatMap(ModelEffort.init(rawValue:))
            } else {
                preferred = nil
            }
        } else {
            preferred = modelPreferences[mode]?.efforts[choice.key]
        }
        return choice.effort(preferred: preferred)
    }
    var availableModes: [ChatMode] { [.chat] + (snapshot?.host?["capabilities"]["cloudCowork"].bool == true ? [.cowork] : []) + (snapshot?.host?["capabilities"]["cloudCode"].bool == true ? [.code] : []) }
    var availableModels: [ModelItem] { modelCatalog.catalog?.items ?? [] }
    var webSearchEnabled: Bool { activeConversation?.extensionFields["webSearch"]?.bool ?? (activeConversation == nil ? draftWebSearch : false) }
    var researchEnabled: Bool { (activeConversation?.mode ?? mode) == .chat && (activeConversation?.extensionFields["research"]?.bool ?? (activeConversation == nil ? draftResearch : false)) }
    /// The bases this chat uses, or the new chat's draft.
    var activeKnowledge: [String] { activeConversation.map(\.knowledgeBases) ?? draftKnowledge }
    func loadKnowledgeBases() async {
        guard let direct, account != nil else { return }
        if let data = try? await direct.request("api/v1/claudex/knowledge") { knowledgeBases = KnowledgeBase.list(data) }
    }
    /// Turns a base on or off for the open chat (saved on the conversation), or the new chat's draft.
    func toggleKnowledge(_ id: String) async {
        let next = KnowledgeBase.toggled(activeKnowledge, id)
        if let conversation = activeConversation {
            await update(conversation, patch: .object(["knowledgeBases": .array(next.map(JSONValue.string))]))
        } else { draftKnowledge = next }
    }
    func loadConnectorPolicy() async {
        guard account != nil else { return }
        if let value = try? await accountRequest({ try await $0.rpc.call("clientPolicy", as: JSONValue.self) }) { connectorPolicy = value }
    }
    func connectorRows() -> [ConnectorMenu.Row] {
        guard let policy = connectorPolicy else { return [] }
        let overrides = activeConversation.map { ConnectorMenu.overrides($0.extensionFields["connectorOverrides"] ?? .null) } ?? draftConnectors
        return ConnectorMenu.rows(servers: snapshot?.settings.raw["mcpServers"] ?? .null, policy: policy, overrides: overrides)
    }
    /// Turns one connector on or off for this session. A reply in progress keeps the previous choice.
    func toggleConnector(_ name: String, on: Bool) async {
        guard ConnectorMenu.validName(name) else { return }
        if activeConversation?.isRunning == true { errorMessage = L("connector_busy"); return }
        let current = activeConversation.map { ConnectorMenu.overrides($0.extensionFields["connectorOverrides"] ?? .null) } ?? draftConnectors
        let next = ConnectorMenu.toggled(current, name: name, on: on)
        if let conversation = activeConversation {
            let fields = next.mapValues(JSONValue.bool)
            await update(conversation, patch: .object(["connectorOverrides": .object(fields)]))
            if errorMessage?.contains("Refresh") == true { await refresh() }
        } else { draftConnectors = next }
    }
    var running: Bool { activeConversation?.isRunning == true }
    var composerBusy: Bool { isSending || composerQueue.isSending(activeConversationID ?? "") }
    var queuedMessages: [QueuedComposerMessage] {
        guard let conversation = activeConversation else { return [] }
        if conversation.mode == .code { return (codeQueues[conversation.id] ?? []).map { QueuedComposerMessage(remote: $0, conversation: conversation) } }
        return composerQueue.entries(conversation.id)
    }
    var canSend: Bool { pendingSend == nil && !isSavingCodePermission && !isSavingModel && !composerBusy && !conversationActions.contains(activeConversationID ?? "") && (!composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty) }
    /// Asks the service whether a newer iOS release is listed. A failed check stays quiet unless the person asked.
    func checkForAppUpdate(asked: Bool = false) {
        updateCheck?.cancel()
        let origin = serviceOrigin
        updateCheck = Task { [weak self] in await self?.performUpdateCheck(asked: asked, origin: origin) }
    }
    func dismissAppUpdate() {
        dismissedUpdate = offeredRelease?.version
        offeredRelease = nil
    }
    private func performUpdateCheck(asked: Bool, origin: URL?) async {
        guard let origin else { return }
        do {
            var request = URLRequest(url: origin.appendingPathComponent("api/v1/claudex/apps"))
            request.httpMethod = "GET"
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
            request.setValue("Claudex-iOS/\(version)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await updateTransport.data(for: request)
            try Task.checkCancellation()
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
            let code = body["code"].number
            guard (200..<300).contains(status), code == nil || code == 0 else {
                if asked { Snackbars.shared.toast(L("claudex_update_check_failed")) }
                return
            }
            let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
            guard let release = AppReleasePolicy.release(body, origin: origin.absoluteString), AppReleasePolicy.newer(release.version, than: current) else {
                if asked { Snackbars.shared.toast(L("claudex_update_latest")) }
                return
            }
            if asked || release.version != dismissedUpdate { offeredRelease = release }
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled || !asked { return }
            Snackbars.shared.toast(L("claudex_update_check_failed"))
        }
    }
    func boot() async {
        installReplyNotifications()
        defer { isRestoringSession = false }
        clearGeneratedFiles()
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("ClaudexAttachments", isDirectory: true))
        guard !ProcessInfo.processInfo.arguments.contains("-ui-testing") else { return }
        checkForAppUpdate()
        guard let session else { return }
        isLoading = true; defer { isLoading = false }
        do { if let restored = try await session.restore() { await didLogin(restored) } }
        catch { errorMessage = error.localizedDescription }
    }
    func didLogin(_ account: SessionAccount) async {
        // A successful login is always a new UI/transport generation, even if
        // the account was changed without an intervening explicit sign-out.
        invalidateSession(message: nil)
        hydrator.reset()
        conversationBridgeGeneration = UUID()
        self.account = account; presentLogin = false
        restoreComposerDrafts()
        for mode in ChatMode.allCases {
            if let key = modelPreferenceKey(mode), let data = modelDefaults.data(forKey: key) {
                modelPreferences[mode] = try? JSONDecoder().decode(ModelPreference.self, from: data)
            }
        }
        // The launch screen holds only until the account is back; the lists fill in after.
        isRestoringSession = false
        await refresh(); if isActive { connection?.start() }
    }
    /// Failed turns become category reports. They leave the phone only with consent and while the service is collecting.
    private func reportFailedTurns() async {
        let consent = snapshot?.settings.raw["helpImproveClaudex"].bool == true
        bindDiagnosticsAccount()
        let failures = (snapshot?.conversations ?? []).flatMap { conversation in
            conversation.turns.filter { $0.status == "failed" }.map { FailedTurn(id: $0.id, error: $0.error, model: conversation.model) }
        }
        diagnostics.observe(failures, consent: consent, client: currentDiagnosticClient())
        if consent, account != nil, !diagnosticsFlagLoaded, let direct {
            diagnosticsFlagLoaded = true
            if let data = try? await direct.request("api/v1/claudex/bootstrap") {
                serviceCollectsDiagnostics = DiagnosticPolicy.serviceCollectsDiagnostics(data)
                serviceCollectsFeedback = DiagnosticPolicy.serviceCollectsFeedback(data)
            }
        }
        if let body = diagnostics.payload(consent: consent, serviceEnabled: serviceCollectsDiagnostics), let direct {
            if (try? await direct.request("api/v1/claudex/diagnostics", method: "POST", body: body)) != nil {
                diagnostics.acknowledge(Set(body["reports"].array?.compactMap { $0["id"].string } ?? []))
            } else { diagnostics.postpone() }
        }
        await flushFeedback(consent: consent)
        persistDiagnostics(consent: consent)
    }
    private var diagnosticsDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ClaudexDiagnostics", isDirectory: true)
    }
    private func bindDiagnosticsAccount() {
        guard let email = account?.email, !email.isEmpty, diagnosticsAccount != email else { return }
        diagnostics.forget()
        diagnosticsAccount = email
        diagnosticsFlagLoaded = false
        serviceCollectsDiagnostics = false
        serviceCollectsFeedback = false
        DiagnosticQueueFile.load(DiagnosticQueueFile.location(directory: diagnosticsDirectory, account: email), queue: diagnostics)
    }
    private func persistDiagnostics(consent: Bool) {
        CrashReports.directory = diagnosticsDirectory
        CrashReports.account = account?.email
        CrashReports.consent = consent
        CrashReports.client = currentDiagnosticClient()
        guard let email = account?.email, !email.isEmpty, diagnosticsAccount == email else { return }
        DiagnosticQueueFile.store(DiagnosticQueueFile.location(directory: diagnosticsDirectory, account: email), queue: diagnostics, consent: consent)
    }
    private func currentDiagnosticClient() -> DiagnosticClient {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif
        return DiagnosticClient(appVersion: version, platform: "ios", arch: arch, osVersion: "iOS \(UIDevice.current.systemVersion)")
    }
    private func flushFeedback(consent: Bool) async {
        guard let body = diagnostics.feedbackPayload(consent: consent, serviceEnabled: serviceCollectsFeedback), let direct else { return }
        if (try? await direct.request("api/v1/claudex/feedback", method: "POST", body: body)) != nil {
            diagnostics.acknowledgeFeedback(body["id"].string ?? "")
        } else { diagnostics.postponeFeedback() }
    }
    func refresh() async {
        guard account != nil else { presentLogin = true; return }
        let epoch = generation, streamRevision = refreshTracker.revision
        let observed = recovery.observedSequence
        refreshGeneration += 1; let request = refreshGeneration; isLoading = true
        if case .failed = modelCatalog { modelCatalog = .loading }
        hydrator.invalidateSource()
        defer { if epoch == generation, request == refreshGeneration { isLoading = false } }
        do {
            async let nextSnapshot = service.snapshotCoverage()
            async let nextModels = service.models()
            async let nextPolicy: JSONValue? = try? remote?.schedulePolicy()
            let (state, served) = try await nextSnapshot
            let coveredSequence = served ?? observed
            guard epoch == generation, request == refreshGeneration else { return }
            snapshot = excludingDeleted(refreshTracker.reconcile(state, current: snapshot, since: streamRevision)); reducer.recover(snapshot!, covering: coveredSequence); recovery.recovered()
            await reportFailedTurns()
            hydrator.observe(snapshot!.conversations, snapshotReplacement: true)
            readVisibleConversationIfNeeded()
            reconcileComposerQueues(snapshot?.conversations ?? [])
            refreshCodeQueue()
            if isActive { connection?.start() }
            do {
                let models = try await nextModels
                guard epoch == generation, request == refreshGeneration else { return }
                modelCatalog = .loaded(models)
            } catch {
                guard epoch == generation, request == refreshGeneration else { return }
                if case .loading = modelCatalog { modelCatalog = .failed }
                validateSessionError(error)
            }
            lastRefresh = Date()
            let policy = await nextPolicy
            if epoch == generation, request == refreshGeneration { toolPolicy = policy }
        } catch {
            if epoch == generation, request == refreshGeneration {
                if case .loading = modelCatalog { modelCatalog = .failed }
                handle(error)
            }
        }
    }
    func send() {
        guard canSend else { return }
        guard account != nil else { presentLogin = true; return }
        if let conversation = activeConversation, conversation.isRunning { sendWhileRunning(conversation, selection: conversationModelSelection); return }
        guard activeConversationID != nil || availableModes.contains(mode) else { errorMessage = L("claudex_msg_mode_unavailable"); return }
        let conversation = activeConversation, selectedMode = conversation?.mode ?? mode
        guard let choice = selectedModel(mode: selectedMode, conversation: conversation) else {
            errorMessage = snapshot?.modelUnavailable ?? L("claudex_msg_no_model"); return
        }
        let effort = selectedEffort(choice, mode: selectedMode, conversation: conversation)
        let draft = composerText, picks = attachments, conversationID = activeConversationID, epoch = generation
        let scope = composerScope
        let sentSelection = conversationModelSelection
        let webSearch = webSearchEnabled, research = researchEnabled, knowledge = draftKnowledge, connectors = draftConnectors
        let streamRevision = mutations.revision, presentationLease = conversationBridgeGeneration
        let startsOnChatSurface = conversationID == nil && section == .chat && chatPath.isEmpty
        let projectID = conversationID == nil ? preparedProjectID : activeConversation?.projectId
        let repository = preparedRepository
        isSending = true; isUploading = !picks.isEmpty; sendGeneration += 1
        let operation = sendGeneration
        runningDraftFiles.formUnion(picks.map(\.url))
        submittedDraft = (scope, ComposerDraft(text: draft, files: picks))
        let nextDraft = ComposerDraft(project: composerProjectChoice)
        composerArchive.drafts[scope] = nextDraft
        applyComposerDraft(nextDraft)
        flushComposerDrafts()
        sendTask = Task {
            var uploaded: [Attachment] = []
            var uploadingAttachment = false
            defer {
                if epoch == generation {
                    isSending = false; isUploading = false; uploadProgress = nil; sendTask = nil
                    runningDraftFiles.subtract(picks.map(\.url))
                    deleteUnownedFiles(picks)
                }
            }
            do {
                for pick in picks {
                    try Task.checkCancellation()
                    if pick.uploaded == nil && (AttachmentLimits.isText(name: pick.name) || AttachmentLimits.isImage(name: pick.name)) {
                        try AttachmentLimits.validate(name: pick.name, data: Data(contentsOf: pick.url, options: .mappedIfSafe))
                    }
                }
                for pick in picks {
                    try Task.checkCancellation()
                    if let saved = pick.uploaded { uploaded.append(saved) }
                    else {
                        let data = try Data(contentsOf: pick.url, options: .mappedIfSafe)
                        uploadingAttachment = true
                        let attachment = try await service.upload(name: pick.name, data: data) { value in Task { @MainActor [weak self] in if self?.generation == epoch, self?.sendGeneration == operation, self?.isUploading == true { self?.uploadProgress = value } } }
                        uploadingAttachment = false
                        uploaded.append(attachment)
                        if epoch == generation, submittedDraft?.scope == scope {
                            submittedDraft?.draft.files = savedPicks(picks, uploaded: uploaded)
                            flushComposerDrafts()
                        }
                    }
                }
                try Task.checkCancellation()
                guard epoch == generation else { throw CancellationError() }
                isUploading = false; uploadProgress = nil
                var input = SendInput(conversationId: conversationID, text: draft, mode: selectedMode, projectId: projectID, attachments: uploaded, providerId: choice.providerID, model: choice.model.id, effort: effort, repository: conversationID == nil && selectedMode == .code ? repository : nil, webSearch: conversationID == nil ? webSearch : nil, research: conversationID == nil ? research : nil, knowledgeBases: conversationID == nil && !knowledge.isEmpty ? knowledge : nil, connectorOverrides: conversationID == nil && !connectors.isEmpty ? connectors : nil)
                input.clientRequestId = UUID().uuidString.lowercased()
                pendingSends[scope] = PendingComposerSend(input: input, draft: ComposerDraft(text: draft, files: savedPicks(picks, uploaded: uploaded)), supportsReceipts: snapshot?.host?["capabilities"]["nativeSendReceipts"].bool == true)
                submittedDraft = nil
                if let storage = composerDraftStorage, !incognitoComposerScopes.contains(scope) {
                    try storage.save(persistedComposerArchive)
                }
                let result = try await service.send(input)
                guard epoch == generation else { return }
                upsertMutation(result, since: streamRevision)
                pendingSends.removeValue(forKey: scope)
                submittedDraft = nil
                let stillViewingComposer = presentationLease == conversationBridgeGeneration && scope == composerScope
                if stillViewingComposer, conversationID == nil {
                    let next = ComposerDraftScope.conversation(result.id)
                    if result.incognito { markIncognitoComposer(result.id) }
                    if var followUp = composerArchive.drafts[scope] {
                        followUp.project = nil
                        if !followUp.isEmpty { composerArchive.drafts[next] = followUp }
                        composerArchive.drafts[scope] = ComposerDraft(project: composerProjectChoice)
                    }
                }
                flushComposerDrafts()
                guard stillViewingComposer else { return }
                if conversationID == nil {
                    keepsDraftBridge = startsOnChatSurface && activeConversationID == nil
                    activeConversationID = result.id; section = .chat
                    keepsDraftBridge = false
                    if startsOnChatSurface { chatSurfaceConversationID = result.id }
                    else { chatPath.append(.conversation(result.id)) }
                }
                if conversationModelSelection == sentSelection { conversationModelSelection = nil }
            } catch {
                guard epoch == generation else { return }
                let failedDuringUpload = uploadingAttachment && pendingSends[scope] == nil
                if isDefiniteSendFailure(error), let pending = pendingSends.removeValue(forKey: scope) {
                    submittedDraft = (scope, pending.draft)
                }
                if let submitted = submittedDraft, submitted.scope == scope {
                    let recovered = (composerArchive.drafts[scope] ?? ComposerDraft()).restoring(submitted.draft)
                    composerArchive.drafts[scope] = recovered
                    submittedDraft = nil
                    if composerScope == scope { applyComposerDraft(recovered) }
                    flushComposerDrafts()
                }
                if failedDuringUpload, conversationID == nil, !(error is CancellationError) {
                    var input = SendInput(conversationId: nil, text: draft, mode: selectedMode, projectId: projectID, attachments: uploaded, providerId: choice.providerID, model: choice.model.id, effort: effort, repository: selectedMode == .code ? repository : nil, webSearch: webSearch, research: research, knowledgeBases: knowledge.isEmpty ? nil : knowledge, connectorOverrides: connectors.isEmpty ? nil : connectors)
                    input.clientRequestId = UUID().uuidString.lowercased()
                    pendingSends[scope] = PendingComposerSend(input: input, draft: ComposerDraft(text: draft, files: picks), supportsReceipts: false, uploadFailed: true)
                    flushComposerDrafts()
                }
                if !(error is CancellationError) { handle(error) }
            }
        }
    }
    func retryPendingSend() {
        let scope = composerScope
        guard let pending = pendingSends[scope], !isSending, canRetryPendingSend else { return }
        if pending.uploadFailed == true {
            pendingSends.removeValue(forKey: scope)
            send()
            return
        }
        let input = pending.input
        let epoch = generation, revision = mutations.revision, lease = conversationBridgeGeneration
        isSending = true
        sendTask = Task {
            defer { if epoch == generation { isSending = false; sendTask = nil } }
            do {
                if let storage = composerDraftStorage, !incognitoComposerScopes.contains(scope) {
                    try storage.save(persistedComposerArchive)
                }
                let result = try await service.send(input)
                guard epoch == generation else { return }
                upsertMutation(result, since: revision)
                pendingSends.removeValue(forKey: scope)
                flushComposerDrafts()
                deleteUnownedFiles(pending.draft.files)
                guard lease == conversationBridgeGeneration, scope == composerScope else { return }
                if input.conversationId == nil {
                    let next = ComposerDraftScope.conversation(result.id)
                    if result.incognito { markIncognitoComposer(result.id) }
                    if var followUp = composerArchive.drafts[scope] {
                        followUp.project = nil
                        if !followUp.isEmpty { composerArchive.drafts[next] = followUp }
                        composerArchive.drafts[scope] = ComposerDraft(project: composerProjectChoice)
                    }
                    flushComposerDrafts()
                    keepsDraftBridge = section == .chat && chatPath.isEmpty && activeConversationID == nil
                    activeConversationID = result.id; section = .chat
                    keepsDraftBridge = false
                    if chatPath.isEmpty { chatSurfaceConversationID = result.id }
                    else { chatPath.append(.conversation(result.id)) }
                }
            } catch {
                guard epoch == generation else { return }
                if !(error is CancellationError) { handle(error) }
            }
        }
    }
    private func isDefiniteSendFailure(_ error: Error) -> Bool {
        guard case ServiceError.server(_, let code) = error else { return false }
        return !["CLAUDEX_SEND_OUTCOME_UNKNOWN", "CLAUDEX_WEB_TIMEOUT", "CLAUDEX_WEB_RUNNER_UNAVAILABLE", "CLAUDEX_WEB_HANDLER_FAILED"].contains(code ?? "")
    }
    func editPendingSend() {
        let scope = composerScope
        guard let pending = pendingSends.removeValue(forKey: scope) else { return }
        if pending.uploadFailed == true { flushComposerDrafts(); return }
        let recovered = (composerArchive.drafts[scope] ?? ComposerDraft()).restoring(pending.draft)
        composerArchive.drafts[scope] = recovered
        if composerScope == scope { applyComposerDraft(recovered) }
        flushComposerDrafts()
    }
    func discardPendingSend() {
        let scope = composerScope
        guard let pending = pendingSends.removeValue(forKey: scope) else { return }
        if pending.uploadFailed == true {
            var current = composerArchive.drafts[scope] ?? ComposerDraft()
            if current.text == pending.draft.text {
                current.text = ""
                let failed = Set(pending.draft.files.map(\.id))
                current.files.removeAll { failed.contains($0.id) }
                composerArchive.drafts[scope] = current
                if composerScope == scope { applyComposerDraft(current) }
            }
        }
        flushComposerDrafts()
        deleteUnownedFiles(pending.draft.files)
    }
    func cancelUpload() { sendTask?.cancel() }
    func stopGeneration(_ conversation: Conversation) async {
        let epoch = generation
        do {
            if conversation.mode == .chat || conversation.mode == .code {
                guard let target = ChatStopTarget(conversation) else { return }
                let result = try await service.interruptChat(conversation.id, target: target)
                guard epoch == generation else { return }
                if result == .mismatch { errorMessage = L("generic_error_something_went_wrong_try_again") }
            } else {
                try await service.interrupt(conversation.id)
            }
            if epoch == generation { await refresh() }
        } catch is CancellationError {
        } catch { if epoch == generation { handle(error) } }
    }
    func update(_ conversation: Conversation, patch: JSONValue) async {
        let epoch = generation
        do { let result = try await service.updateConversation(conversation.id, patch: patch); guard epoch == generation else { return }; upsert(result) }
        catch { if epoch == generation { handle(error) } }
    }
    private var generatedFilesFolder: URL { FileManager.default.temporaryDirectory.appendingPathComponent("ClaudexGeneratedFiles", isDirectory: true) }
    private func clearGeneratedFiles() { try? FileManager.default.removeItem(at: generatedFilesFolder) }
    func materializeGeneratedFile(_ file: GeneratedFile) async throws -> (url: URL, data: Data) {
        guard account != nil, let remote else { throw ServiceError.signedOut }
        let epoch = generation
        let data = try await remote.generatedFileData(file)
        try Task.checkCancellation()
        guard epoch == generation, account != nil else { throw CancellationError() }
        let directory = generatedFilesFolder.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        let url = directory.appendingPathComponent(file.safeName)
        do {
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            return (url, data)
        } catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
    private func excludingDeleted(_ state: Snapshot) -> Snapshot {
        DeletionProjection.apply(state, conversations: deletedConversationIDs, projects: deletedProjectIDs)
    }
    func deleteProject(_ id: String) async -> Bool {
        guard account != nil, let remote, !deletingProjects.contains(id), snapshot?.projects.contains(where: { $0.id == id }) == true else { return false }
        let epoch = generation; deletingProjects.insert(id)
        defer { if epoch == generation { deletingProjects.remove(id) } }
        do {
            try await remote.deleteProject(id)
            guard epoch == generation else { return false }
            deletedProjectIDs.insert(id)
            if projectComposerID == id { projectComposerID = nil }
            for scope in Array(composerArchive.drafts.keys) where composerArchive.drafts[scope]?.project == .project(id) {
                composerArchive.drafts[scope]?.project = nil
                if composerScope == scope { composerProjectChoice = nil }
            }
            discardComposerDraft(.project(id))
            if let state = snapshot { snapshot = excludingDeleted(state); reducer.replace(snapshot!); hydrator.observe(snapshot!.conversations, snapshotReplacement: true) }
            return true
        } catch { if epoch == generation { handle(error) }; return false }
    }
    func feedback(conversationID: String, turnID: String) -> ReplyRating? {
        snapshot?.replyFeedback?[ArtifactIndex.identity([conversationID, turnID])]
    }
    private func performConversationAction(_ id: String, requiresIdle: Bool = true, action: (RemoteClaudexService, Conversation) async throws -> Void) async -> Bool {
        guard account != nil, let remote, let conversation = conversations.first(where: { $0.id == id }), !conversationActions.contains(id) else { return false }
        guard !requiresIdle || (!conversation.isRunning && !isSending) else { errorMessage = L("claudex_msg_wait_reply"); return false }
        let epoch = generation
        conversationActions.insert(id)
        defer { if epoch == generation { conversationActions.remove(id) } }
        do { try await action(remote, conversation); try Task.checkCancellation(); return epoch == generation }
        catch is CancellationError { return false }
        catch { if epoch == generation { handle(error) }; return false }
    }
    @discardableResult func retryResponse(conversationID: String, turnID: String) async -> Bool {
        let epoch = generation, streamRevision = mutations.revision
        return await performConversationAction(conversationID) { remote, conversation in
            guard [.chat, .code].contains(conversation.mode), conversation.turns.contains(where: { $0.id == turnID }) else { throw ServiceError.invalidResponse }
            let result = try await remote.retryResponse(conversationID: conversationID, turnID: turnID, providerID: conversation.providerId, model: conversation.model)
            guard epoch == generation else { return }; upsertMutation(result, since: streamRevision)
        }
    }
    func editPrompt(conversationID: String, turnID: String, text: String) async -> Bool {
        let epoch = generation, streamRevision = mutations.revision
        return await performConversationAction(conversationID) { remote, conversation in
            guard conversation.mode == .chat, conversation.turns.contains(where: { $0.id == turnID }) else { throw ServiceError.invalidResponse }
            let result = try await remote.editPrompt(conversationID: conversationID, turnID: turnID, text: text, providerID: conversation.providerId, model: conversation.model)
            guard epoch == generation else { return }; upsertMutation(result, since: streamRevision)
        }
    }
    @discardableResult func selectVersion(conversationID: String, turnID: String, versionTurnID: String, prompt: Bool) async -> Bool {
        let epoch = generation, streamRevision = mutations.revision
        return await performConversationAction(conversationID) { remote, conversation in
            guard conversation.mode == .chat, let turn = conversation.turns.first(where: { $0.id == turnID }), ConversationVersions.versions(conversation, turn: turn, prompt: prompt).contains(where: { $0.turnID == versionTurnID }) else { throw ServiceError.invalidResponse }
            let result = try await remote.selectVersion(conversationID: conversationID, turnID: turnID, versionTurnID: versionTurnID, prompt: prompt)
            guard epoch == generation else { return }; upsertMutation(result, since: streamRevision)
        }
    }
    @discardableResult func rateReply(conversationID: String, turnID: String, rating: ReplyRating?) async -> Bool {
        let epoch = generation
        return await performConversationAction(conversationID, requiresIdle: false) { remote, conversation in
            guard conversation.turns.contains(where: { $0.id == turnID && $0.status == "completed" }) else { throw ServiceError.invalidResponse }
            let ratings = try await remote.setReplyFeedback(conversationID: conversationID, turnID: turnID, rating: rating)
            guard epoch == generation else { return }
            snapshot?.replyFeedback = ReplyFeedbackProjection.merging(ratings, into: snapshot?.replyFeedback ?? [:], conversationID: conversationID, turnID: turnID); refreshTracker.recordField("replyFeedback"); if let snapshot { reducer.replace(snapshot) }
            let consent = snapshot?.settings.raw["helpImproveClaudex"].bool == true
            bindDiagnosticsAccount()
            if let rating, consent {
                diagnostics.recordFeedback(rating.rawValue, model: conversation.model, client: currentDiagnosticClient())
            }
            await flushFeedback(consent: consent)
            persistDiagnostics(consent: consent)
        }
    }
    func deleteConversation(_ id: String) async {
        let epoch = generation
        _ = await performConversationAction(id) { remote, _ in
            try await remote.deleteConversation(id)
            guard epoch == generation else { return }
            deletedConversationIDs.insert(id)
            queueTasks[id]?.cancel(); queueTasks[id] = nil; queueTaskEntries[id] = nil; composerQueue.removeConversation(id)
            codeQueues[id] = nil; pendingCodeSubmissions[id] = nil; codeQueueRevision += 1; pruneQueueFiles()
            if let state = snapshot { snapshot = excludingDeleted(state) }
            if activeConversationID == id { newConversation() }
            discardComposerDraft(.conversation(id))
            chatPath.removeAll { $0 == .conversation(id) }
            if let snapshot { reducer.replace(snapshot); hydrator.observe(snapshot.conversations, snapshotReplacement: true) }
        }
    }
    private var accountIdentity: String? {
        guard let account else { return nil }
        let identity = account.raw["id"].integer.map(String.init) ?? account.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return identity.isEmpty ? nil : identity
    }
    private func modelPreferenceKey(_ mode: ChatMode) -> String? {
        guard let identity = accountIdentity, let origin = remote?.rpc.baseURL else { return nil }
        return ModelPreference.storageKey(origin: origin, account: identity, mode: mode)
    }
    private func saveModelPreference(_ preference: ModelPreference, mode: ChatMode) {
        modelPreferences[mode] = preference
        if let key = modelPreferenceKey(mode), let data = try? JSONEncoder().encode(preference) {
            modelDefaults.set(data, forKey: key)
        }
    }
    func setEffort(_ effort: ModelEffort, mode: ChatMode, conversation: Conversation?) async -> Bool {
        guard account != nil, !isSavingModel, let choice = selectedModel(mode: mode, conversation: conversation),
              choice.efforts.contains(effort) else { return false }
        if let conversation {
            guard let current = activeConversation, conversation.id == current.id else { return false }
            if choice.model.id == current.model, choice.providerID == current.providerId {
                let epoch = generation, revision = mutations.revision
                isSavingModel = true
                defer { if epoch == generation { isSavingModel = false } }
                do {
                    let result = try await service.updateConversation(current.id, patch: .object(["effort": .string(effort.rawValue)]))
                    guard epoch == generation else { return false }
                    upsertMutation(result, since: revision)
                    guard current.id == activeConversationID else { return false }
                    conversationModelSelection = current.isRunning ? .init(key: choice.key, effort: effort) : nil
                } catch { if epoch == generation { handle(error) }; return false }
            } else {
                conversationModelSelection = .init(key: choice.key, effort: effort)
            }
        } else {
            var preference = modelPreferences[mode] ?? ModelPreference()
            preference.selected = choice.key
            preference.efforts[choice.key] = effort
            saveModelPreference(preference, mode: mode)
        }
        return true
    }
    func selectModel(_ choice: ModelChoice, mode: ChatMode, conversation: Conversation?) -> Bool {
        guard account != nil, !isSavingModel, let available = modelChoices.first(where: { $0.key == choice.key }) else { return false }
        if let conversation {
            guard conversation.id == activeConversationID else { return false }
            if selectedModelKey(mode: mode, conversation: conversation) != choice.key {
                let effort = selectedEffort(available, mode: mode, conversation: conversation)
                conversationModelSelection = .init(key: choice.key, effort: effort)
            }
        }
        var preference = modelPreferences[mode] ?? ModelPreference()
        preference.selected = choice.key
        saveModelPreference(preference, mode: mode)
        return true
    }
    /// Code session menu "Change model": the session's model from its next message on (a running turn is not
    /// interrupted); the account's own model choice stays. False when saving failed.
    func changeConversationModel(_ conversation: Conversation, to choice: ModelChoice) async -> Bool {
        guard account != nil, !isSavingModel, modelChoices.contains(where: { $0.key == choice.key }) else { return false }
        if conversation.providerId == choice.providerID && conversation.model == choice.model.id { return true }
        let epoch = generation
        isSavingModel = true
        defer { if epoch == generation { isSavingModel = false } }
        do {
            let result = try await service.updateConversation(conversation.id, patch: .object(["providerId": .string(choice.providerID), "model": .string(choice.model.id)]))
            guard epoch == generation else { return false }
            upsert(result)
            if activeConversationID == conversation.id { conversationModelSelection = .init(key: choice.key, effort: choice.defaultEffort) }
            return true
        } catch is CancellationError { return false }
        catch { if epoch == generation { errorMessage = L("ccr_model_save_failed") }; return false }
    }
    func beginNewChat() {
        if composerScope == .new(.chat) {
            if submittedDraft?.scope == composerScope { submittedDraft = nil }
            pendingSends.removeValue(forKey: composerScope)
            flushComposerDrafts()
        }
        newConversation()
        chatPath = []; section = .chat; sidebarPresented = false
    }
    func newConversation() {
        chatSurfaceConversationID = nil
        conversationBridgeGeneration = UUID()
        projectComposerID = nil
        mode = .chat
        activeConversationID = nil
        draftWebSearch = false; draftResearch = false; draftKnowledge = []; draftConnectors = [:]
    }
    private var composerDraftStorage: ComposerDraftStorage? {
        guard let root = composerDraftRoot, let origin = remote?.rpc.baseURL, let account = accountIdentity else { return nil }
        return ComposerDraftStorage(root: root, origin: origin, account: account)
    }

    private func syncComposerDraftScope() {
        guard !applyingComposerDraft else { return }
        let next = activeConversationID.map(ComposerDraftScope.conversation)
            ?? projectComposerID.map(ComposerDraftScope.project)
            ?? .new(mode)
        guard next != composerScope else { return }
        composerScope = next
        if activeConversationID == nil { conversationBridgeGeneration = UUID() }
        applyComposerDraft(composerArchive.drafts[next] ?? ComposerDraft())
    }

    private func applyComposerDraft(_ draft: ComposerDraft) {
        applyingComposerDraft = true
        composerText = draft.text
        attachments = draft.files
        composerProjectChoice = draft.project
        applyingComposerDraft = false
    }

    private func saveComposerDraft() {
        guard !applyingComposerDraft else { return }
        if activeConversation?.incognito == true, let id = activeConversationID {
            markIncognitoComposer(id)
        }
        composerArchive.drafts[composerScope] = ComposerDraft(
            text: composerText, files: attachments, project: composerProjectChoice)
        if !incognitoComposerScopes.contains(composerScope) { flushComposerDrafts() }
    }

    private func markIncognitoComposer(_ id: String) {
        let scope = ComposerDraftScope.conversation(id)
        if incognitoComposerScopes.insert(scope).inserted { flushComposerDrafts() }
    }

    private var persistedComposerArchive: ComposerDraftArchive {
        var saved = composerArchive
        saved.drafts = saved.drafts.filter { !incognitoComposerScopes.contains($0.key) && !$0.value.isEmpty }
        saved.pendingCodeSubmissions = pendingCodeSubmissions
        saved.pendingSends = pendingSends.filter { !incognitoComposerScopes.contains($0.key) }
        if let submitted = submittedDraft, !incognitoComposerScopes.contains(submitted.scope) {
            saved.drafts[submitted.scope] = (saved.drafts[submitted.scope] ?? ComposerDraft()).restoring(submitted.draft)
        }
        return saved
    }

    private func flushComposerDrafts() {
        guard let storage = composerDraftStorage, !applyingComposerDraft else { return }
        do { try storage.save(persistedComposerArchive) }
        catch { errorMessage = L("generic_error_something_went_wrong_try_again") }
    }

    private func restoreComposerDrafts() {
        guard let storage = composerDraftStorage else { return }
        do {
            composerArchive = try storage.load()
            pendingSends = composerArchive.pendingSends ?? [:]
            pendingCodeSubmissions = composerArchive.pendingCodeSubmissions ?? [:]
            applyComposerDraft(composerArchive.drafts[composerScope] ?? ComposerDraft())
            applyingComposerDraft = true
            preparedRepository = composerArchive.repository
            applyingComposerDraft = false
        } catch { errorMessage = L("generic_error_something_went_wrong_try_again") }
    }

    private func discardComposerDraft(_ scope: ComposerDraftScope) {
        if submittedDraft?.scope == scope { submittedDraft = nil }
        let discarded = (composerArchive.drafts.removeValue(forKey: scope)?.files ?? []) + (pendingSends.removeValue(forKey: scope)?.draft.files ?? [])
        if composerScope == scope { applyComposerDraft(ComposerDraft()) }
        flushComposerDrafts()
        deleteUnownedFiles(discarded)
    }

    func openProjectComposer(_ id: String) {
        projectComposerID = id
        mode = .chat
        activeConversationID = nil
    }

    func closeProjectComposer(_ id: String) {
        if projectComposerID == id { projectComposerID = nil }
    }

    func selectComposerProject(_ id: String?) {
        composerProjectChoice = id == projectComposerID ? nil : id.map(ComposerProjectChoice.project) ?? .some(.none)
        saveComposerDraft()
    }

    func scheduleDraftPrompt(_ scope: ScheduleDraftScope) -> String? { composerArchive.schedulePrompts[scope] }

    func setScheduleDraftPrompt(_ prompt: String?, scope: ScheduleDraftScope) {
        composerArchive.schedulePrompts[scope] = prompt
        flushComposerDrafts()
    }

    var codePermissionContextID: Int { generation }
    var hasRunningTask: Bool { snapshot?.conversations.contains(where: \.isRunning) == true }
    var codePermissionForm: CloudPermissionForm {
        CloudPermissionForm(host: snapshot?.host, settings: snapshot?.settings, loading: isLoading, changing: isSavingCodePermission)
    }
    func setCodePermission(_ mode: CloudPermissionMode, confirmed: Bool = false) async -> Bool {
        guard account != nil, !isSavingCodePermission, !isSending, !hasRunningTask, let settings = snapshot?.settings else { return false }
        let epoch = generation
        do {
            // Revalidate the current server list after any confirmation dialog.
            let next = try CloudPermissionContract.selecting(mode, host: snapshot?.host, settings: settings, loading: isLoading, confirmed: confirmed)
            errorMessage = nil; isSavingCodePermission = true
            defer { if epoch == generation { isSavingCodePermission = false } }
            let saved = try await accountRequest { try await $0.saveSettings(next) }
            guard epoch == generation else { return false }
            guard let acknowledged = CloudPermissionContract.selected(saved) else { throw ServiceError.invalidResponse }
            snapshot?.settings = saved; refreshTracker.recordField("settings")
            if let snapshot { reducer.replace(snapshot) }
            guard acknowledged == mode else { errorMessage = L("generic_error_something_went_wrong_try_again"); return false }
            return true
        } catch is CancellationError { return false }
        catch { if epoch == generation { handle(error) }; return false }
    }
    var remote: RemoteClaudexService? { service as? RemoteClaudexService }
    func accountRequest<T: Sendable>(_ operation: (RemoteClaudexService) async throws -> T) async throws -> T {
        guard account != nil, let remote else { throw ServiceError.signedOut }
        try Task.checkCancellation()
        let epoch = generation
        do {
            let value = try await operation(remote)
            try Task.checkCancellation()
            guard epoch == generation, account != nil else { throw CancellationError() }
            return value
        } catch {
            guard epoch == generation, account != nil else { throw CancellationError() }
            throw error
        }
    }
    var direct: DirectServiceClient? { remote.map { DirectServiceClient(rpc: $0.rpc) } }
    /// Ready for review: the Code sessions whose pull request waits for a reviewer (SessionList.swift), asked of the service.
    @Published private(set) var reviewReady: Set<String> = []
    private lazy var sessionReview = SessionReview { [weak self] refs in await self?.pullVerdicts(refs) }
    private func pullVerdicts(_ refs: [PullRef]) async -> [PullVerdict]? {
        guard let direct, let answer = try? await direct.request(SessionReviewPolicy.path, method: "POST", body: SessionReviewPolicy.request(refs)) else { return nil }
        return SessionReviewPolicy.verdicts(answer)
    }
    func loadReview(force: Bool = false) async {
        let epoch = generation
        let ready = await sessionReview.load(conversations, force: force)
        if epoch == generation, ready != reviewReady { reviewReady = ready }
    }
    func activate(_ conversation: Conversation) {
        if activeConversationID != conversation.id {
            draftWebSearch = false; draftResearch = false; draftKnowledge = []; draftConnectors = [:]
        }
        if conversation.incognito { markIncognitoComposer(conversation.id) }
        activeConversationID = conversation.id
        readVisibleConversationIfNeeded()
    }
    // Reuse the existing scoped mutation when a remote unread mark arrives on
    // the foreground conversation. A deferred check observes completed navigation
    // and rejects work queued before an account or visibility change.
    private func readVisibleConversationIfNeeded() {
        let epoch = generation
        Task {
            guard epoch == generation, isActive, section == .chat, account != nil,
                  let conversation = activeConversation, conversation.unread,
                  !conversation.incognito else { return }
            // An ID left behind during history navigation is not a visible chat.
            let visibleID: String?
            if case .some(.conversation(let id)) = chatPath.last { visibleID = id }
            else { visibleID = chatPath.isEmpty ? chatSurfaceConversationID : nil }
            guard visibleID == conversation.id else { return }
            await markRead(conversation.id)
        }
    }
    private func markRead(_ id: String) async {
        guard account != nil, !markingRead.contains(id) else { return }
        let epoch = generation, streamRevision = mutations.revision
        markingRead.insert(id)
        defer { if epoch == generation { markingRead.remove(id) } }
        do {
            let result = try await service.updateConversation(id, patch: .object(["unread": .bool(false)]))
            guard epoch == generation else { return }
            upsertMutation(result, since: streamRevision)
        } catch { if epoch == generation { handle(error) } }
    }
    func retryTranscript(_ id: String) { hydrator.retry(id) }
    func deactivateConversation(_ id: String) { if activeConversationID == id { activeConversationID = nil } }
    func lifecycle(active: Bool) {
        isActive = active
        if active { readVisibleConversationIfNeeded(); Task { await noteSchedules() } } else { flushComposerDrafts(); noteApprovals() }
        hydrator.select(active ? activeConversationID : nil)
        if active && account != nil { connection?.start() } else { connection?.stop() }
    }
    /// Deletes the account on the service, then clears this phone's session, drafts and cached files.
    /// "unavailable" means an administrator account cannot be deleted here.
    func deleteAccount() async -> String {
        guard let direct else { errorMessage = L("generic_error_something_went_wrong_try_again"); return "failed" }
        do {
            _ = try await direct.request("api/v1/claudex/account", method: "DELETE")
        } catch let error as ServiceError {
            if case .server(_, let code) = error, code == "CLAUDEX_ACCOUNT_ADMIN" { return "unavailable" }
            errorMessage = error.localizedDescription
            return "failed"
        } catch {
            errorMessage = error.localizedDescription
            return "failed"
        }
        if let email = account?.email, !email.isEmpty {
            try? FileManager.default.removeItem(at: DiagnosticQueueFile.location(directory: diagnosticsDirectory, account: email))
        }
        invalidateSession(message: nil, discardDrafts: true)
        try? await session?.signOut()
        return "deleted"
    }
    /// Downloads this account's export. The file stays in the app until the next export.
    func exportAccountData() async -> URL? {
        guard let remote = service as? RemoteClaudexService else { errorMessage = L("claudex_export_failed"); return nil }
        let generation = await remote.rpc.session.sessionGeneration()
        let email = account?.email
        let endpoint = remote.rpc.baseURL.appendingPathComponent("api/v1/claudex/web/downloads/export")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 120
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        func fetch(_ token: String) async throws -> (URL, HTTPURLResponse) {
            var request = URLRequest(url: endpoint)
            request.httpMethod = "GET"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(remote.rpc.tabID, forHTTPHeaderField: "X-Claudex-Web-Tab")
            let (temp, response) = try await session.download(for: request)
            guard let http = response as? HTTPURLResponse, http.url?.host == endpoint.host else {
                try? FileManager.default.removeItem(at: temp)
                throw ServiceError.invalidResponse
            }
            return (temp, http)
        }
        do {
            var token = try await remote.rpc.session.accessToken()
            var (temp, http) = try await fetch(token)
            if http.statusCode == 401 {
                try? FileManager.default.removeItem(at: temp)
                token = try await remote.rpc.session.refreshAccessToken()
                (temp, http) = try await fetch(token)
            }
            let still = await remote.rpc.session.sessionGeneration()
            guard still == generation, account?.email == email else {
                try? FileManager.default.removeItem(at: temp)
                throw CancellationError()
            }
            guard (200..<300).contains(http.statusCode) else {
                try? FileManager.default.removeItem(at: temp)
                throw ServiceError.server(L("claudex_export_failed"), nil)
            }
            let size = (try? FileManager.default.attributesOfItem(atPath: temp.path)[.size] as? NSNumber)?.int64Value ?? 0
            let handle = try FileHandle(forReadingFrom: temp)
            let magic = try handle.read(upToCount: 4) ?? Data()
            try handle.close()
            let zip = magic.starts(with: Data([0x50, 0x4B, 0x03, 0x04])) || magic.starts(with: Data([0x50, 0x4B, 0x05, 0x06]))
            guard size > 0, size <= 512 * 1024 * 1024, zip else {
                try? FileManager.default.removeItem(at: temp)
                throw ServiceError.server(L("claudex_export_failed"), nil)
            }
            let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ClaudexExports", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            if let old = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) {
                for item in old { try? FileManager.default.removeItem(at: item) }
            }
            let name = AccountExportName.parse(http.value(forHTTPHeaderField: "Content-Disposition"))
            let saved = folder.appendingPathComponent(name)
            try FileManager.default.moveItem(at: temp, to: saved)
            return saved
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = L("claudex_export_failed")
            return nil
        }
    }
    /// This account's monthly cap. A service that has no spend limit returns nil.
    func readSpendLimit() async -> BillingPolicy.Spend? {
        guard let direct else { return nil }
        do { return BillingPolicy.spend(try await direct.request("api/v1/claudex/spend-limit")) }
        catch { return nil }
    }
    /// Saves the cap. Nil means no cap. A failure is already shown.
    func saveSpendLimit(_ amount: Double?) async -> BillingPolicy.Spend? {
        guard let direct else { errorMessage = L("spend_limit_save_error"); return nil }
        let limit: JSONValue = amount.map { .number($0) } ?? .null
        do {
            let saved = BillingPolicy.spend(try await direct.request("api/v1/claudex/spend-limit", method: "PUT", body: .object(["limit_usd": limit])))
            if saved == nil { errorMessage = L("spend_limit_save_error") }
            return saved
        } catch {
            errorMessage = L("spend_limit_save_error")
            return nil
        }
    }
    /// Redeems a code for this account. The string is a problem key the billing page translates.
    func redeemCode(_ raw: String) async -> RedeemAttempt {
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard BillingPolicy.acceptsCode(code), let direct else { return .problem("invalid") }
        do {
            guard let redeemed = BillingPolicy.redeemed(try await direct.request("api/v1/redeem", method: "POST", body: .object(["code": .string(code)]))) else { return .problem("other") }
            return .redeemed(redeemed)
        } catch let error as ServiceError {
            if case .server(_, let reason) = error, let problem = BillingPolicy.redeemProblem(reason ?? "") { return .problem(problem) }
            return .problem("other")
        } catch { return .problem("other") }
    }
    /// Payment methods for adding funds, or nil when this service is not taking payments.
    func loadCheckout() async -> BillingPolicy.Checkout? {
        guard let direct else { return nil }
        var desktop = false
        var enabled = false
        if let bootstrap = try? await direct.request("api/v1/claudex/bootstrap") {
            let features = bootstrap["features"]
            desktop = features["desktop_checkout"].bool == true
            if features["payment"].bool == true { enabled = true }
            else if features != .null { enabled = false }
            else if let config = try? await direct.request("api/v1/payment/config") { enabled = config["enabled"].bool == true }
        } else if let config = try? await direct.request("api/v1/payment/config") {
            enabled = config["enabled"].bool == true
        }
        guard enabled, let info = try? await direct.request("api/v1/payment/checkout-info") else { return nil }
        return BillingPolicy.checkout(info, desktopCheckout: desktop)
    }
    /// Creates a balance top-up and returns where to pay it. An unpayable order is cancelled.
    func startTopUp(method: String, amount: Double) async -> TopUpResult {
        guard let remote = service as? RemoteClaudexService, let direct else { return .failed("unknown") }
        let origin = remote.rpc.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let back = origin + "/payment/result"
        guard BillingPolicy.httpsUrl(back) != nil else { return .failed("unknown") }
        let desktop = (try? await direct.request("api/v1/claudex/bootstrap")).map { $0["features"]["desktop_checkout"].bool == true } ?? false
        do {
            let created = try await direct.request("api/v1/payment/orders", method: "POST", body: .object([
                "payment_type": .string(method), "order_type": .string("balance"), "amount": .number(amount),
                "return_url": .string(back), "payment_source": .string("hosted_redirect"), "is_mobile": .bool(true),
            ]))
            switch BillingPolicy.launch(created, desktopCheckout: desktop) {
            case .open(let page):
                guard let url = URL(string: page), let orderId = created["order_id"].integer else { return .failed("insecure") }
                return .browser(url, orderId)
            case .qr(let code): return .qr(code, created["order_id"].integer ?? 0)
            case .checkout(let orderId, let resume, let secret, let intent, let currency, let country, let env):
                let link = try await direct.request("api/v1/claudex/payment/checkout-links", method: "POST", body: .object([
                    "order_id": .number(Double(orderId)), "resume_token": .string(resume), "client_secret": .string(secret),
                    "intent_id": .string(intent), "currency": .string(currency), "country_code": .string(country), "payment_env": .string(env),
                ]))
                guard let token = link["token"].string, let page = BillingPolicy.desktopPay(origin: origin, token: token), let url = URL(string: page) else {
                    _ = try? await direct.request("api/v1/payment/orders/\(orderId)/cancel", method: "POST")
                    return .failed("desktop")
                }
                return .browser(url, orderId)
            case .unavailable(let reason, _):
                if let orderId = created["order_id"].integer { _ = try? await direct.request("api/v1/payment/orders/\(orderId)/cancel", method: "POST") }
                return .failed(reason)
            }
        } catch { return .failed("unknown") }
    }
    /// Reads the order until it settles, or for about a minute.
    func followPayment(_ id: Int) async -> String? {
        guard let direct, id > 0 else { return nil }
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if Task.isCancelled { return nil }
            guard let data = try? await direct.request("api/v1/payment/orders/\(id)"), let status = data["status"].string else { continue }
            if !["PENDING", "PAID", "RECHARGING"].contains(status) { return status }
        }
        return nil
    }
    func cancelPayment(_ id: Int) async -> Bool {
        guard let direct, id > 0 else { return false }
        do { _ = try await direct.request("api/v1/payment/orders/\(id)/cancel", method: "POST"); return true } catch { return false }
    }
    func signOut() async {
        invalidateSession(message: nil, discardDrafts: true)
        do { try await session?.signOut() } catch { errorMessage = L("generic_error_something_went_wrong_try_again") }
    }
    func addFile(_ source: URL, displayName: String? = nil) {
        do {
            guard attachments.count < AttachmentLimits.maximumCount else { throw ServiceError.server(L("chat_input_attachment_limit_reached_toast", AttachmentLimits.maximumCount), nil) }
            let chosenName = displayName ?? source.lastPathComponent
            guard chosenName.count <= 240 else { throw ServiceError.server(L("chat_input_file_name_too_long"), nil) }
            let accessed = source.startAccessingSecurityScopedResource(); defer { if accessed { source.stopAccessingSecurityScopedResource() } }
            let values = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true else { throw ServiceError.server(L("generic_error_something_went_wrong_try_again"), nil) }
            guard (values.fileSize ?? 0) <= AttachmentLimits.clientMaximum else { throw ServiceError.tooLarge }
            let storage = incognitoComposerScopes.contains(composerScope) ? nil : composerDraftStorage
            try storage?.prepareDirectory()
            let folder = storage?.attachmentsDirectory
                ?? FileManager.default.temporaryDirectory.appendingPathComponent("ClaudexAttachments", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            let target = folder.appendingPathComponent(UUID().uuidString + "-" + source.lastPathComponent)
            try FileManager.default.copyItem(at: source, to: target)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
            attachments.append(LocalAttachment(name: displayName ?? source.lastPathComponent, url: target, size: values.fileSize ?? 0))
        } catch { handle(error) }
    }
    func addPhoto(_ data: Data, extension suffix: String) {
        do {
            guard data.count <= AttachmentLimits.clientMaximum else { throw ServiceError.tooLarge }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(suffix)
            try data.write(to: url, options: [.atomic, .completeFileProtection]); defer { try? FileManager.default.removeItem(at: url) }
            addFile(url, displayName: NativeConversationDetails.photoName(ordinal: attachments.count + 1, suffix: suffix))
        } catch { handle(error) }
    }
    func removeAttachment(_ id: UUID) {
        guard let removed = attachments.first(where: { $0.id == id }) else { return }
        attachments.removeAll { $0.id == id }
        deleteUnownedFiles([removed])
    }
    private func upsertMutation(_ response: Conversation, since revision: UInt64) {
        let current = snapshot?.conversations.first { $0.id == response.id }
        upsert(mutations.reconcile(response, current: current, since: revision))
    }
    private func upsert(_ incoming: Conversation) {
        var conversation = incoming
        if deletedProjectIDs.contains(conversation.projectId ?? "") { conversation.projectId = nil }
        guard !deletedConversationIDs.contains(conversation.id) else { return }
        if let i = snapshot?.conversations.firstIndex(where: { $0.id == conversation.id }) {
            if (snapshot?.conversations[i].updatedAt ?? 0) <= conversation.updatedAt { snapshot?.conversations[i] = conversation }
        } else { snapshot?.conversations.insert(conversation, at: 0) }
        if let snapshot {
            refreshTracker.recordConversation(conversation.id)
            reducer.replace(snapshot)
            hydrator.observe(snapshot.conversations, changedIDs: [conversation.id])
            reconcileComposerQueues(snapshot.conversations)
        }
    }
    private func applyHydratedConversation(_ conversation: Conversation) {
        guard account != nil, activeConversationID == conversation.id,
              let index = snapshot?.conversations.firstIndex(where: { $0.id == conversation.id }),
              snapshot?.conversations[index].slim == true else { return }
        snapshot?.conversations[index] = conversation
        // Update both state owners atomically so the next WS turn cannot restore the slim copy.
        if let snapshot { reducer.replace(snapshot) }
        reconcileComposerQueues(snapshot?.conversations ?? [])
    }
    func receive(_ frame: JSONValue) {
        if let event = DeviceStreamEvent(frame: frame) { devices.receive(event) }
        if frame["event"]["type"].string == "signed-out" { invalidateSession(message: frame["event"]["message"].string); Task { try? await session?.clearLocal() }; return }
        if frame["t"].string == "ready", frame["resumed"].bool == false {
            recovery.reset()
        }
        if resyncTask != nil && frame["t"].string == "event" {
            recovery.buffer(frame)
            return
        }
        do {
            let effect = try reducer.apply(frame)
            recovery.observe(frame)
            switch effect {
            case .changed:
                if frame["t"].string == "snapshot" {
                    resyncGeneration += 1; resyncTask?.cancel(); resyncTask = nil; recovery.reset(); recovery.observe(frame)
                }
                mutations.record(frame, snapshot: reducer.snapshot)
                refreshTracker.record(frame, snapshot: reducer.snapshot)
                snapshot = reducer.snapshot.map(excludingDeleted)
                if let snapshot { reducer.replace(snapshot) }
                let event = frame["event"]
                let changedID = event["conversationId"].string ?? event["conversation"]["id"].string
                hydrator.observe(snapshot?.conversations ?? [],
                                 snapshotReplacement: frame["t"].string == "snapshot",
                                 changedIDs: changedID.map { Set([$0]) } ?? [],
                                 requestSelected: frame["t"].string == "snapshot" || event["type"].string == "conversation")
                readVisibleConversationIfNeeded()
                reconcileComposerQueues(snapshot?.conversations ?? [])
                if frame["t"].string == "snapshot" || (event["type"].string == "conversation" && changedID == activeConversationID) { refreshCodeQueue() }
            case .signedOut(let message): invalidateSession(message: message); Task { try? await session?.clearLocal() }
            case .schedules: Task { await noteSchedules() }
            case .resync:
                hydrator.invalidateSource()
                scheduleRecovery()
            case .none: break
            }
        } catch { errorMessage = error.localizedDescription }
    }
    private func scheduleRecovery() {
        guard resyncTask == nil else { return }
        guard recovery.begin() else {
            errorMessage = L("generic_error_something_went_wrong_try_again")
            return
        }
        resyncGeneration += 1
        let epoch = generation, syncEpoch = resyncGeneration
        resyncTask = Task {
            do {
                // Give an ordered socket snapshot precedence on a fresh connection.
                try await Task.sleep(for: .milliseconds(600))
                let observed = recovery.beginRead(), streamRevision = refreshTracker.revision
                // The service says which event the snapshot covers; without it, only what
                // was seen before the read started counts as covered.
                let (state, served) = try await service.snapshotCoverage()
                let coveredSequence = served ?? observed
                guard epoch == generation, syncEpoch == resyncGeneration, !Task.isCancelled else { return }
                snapshot = excludingDeleted(refreshTracker.reconcile(state, current: snapshot, since: streamRevision))
                reducer.recover(snapshot!, covering: coveredSequence); lastRefresh = Date()
                hydrator.observe(snapshot!.conversations, snapshotReplacement: true)
                readVisibleConversationIfNeeded()
                reconcileComposerQueues(snapshot?.conversations ?? [])
                let overflowed = recovery.overflowed, pending = recovery.drain()
                resyncTask = nil
                if overflowed { scheduleRecovery(); return }
                for event in pending { receive(event) }
                if resyncTask == nil && !recovery.blocked { recovery.recovered() }
            } catch {
                guard epoch == generation, syncEpoch == resyncGeneration else { return }
                resyncTask = nil; recovery.failed()
                if !(error is CancellationError) { handle(error) }
                // Keep the healthy socket. Repeated frames must not create a
                // ticket/connection storm; manual refresh or a socket snapshot can recover.
            }
        }
    }
    func validateSessionError(_ error: Error) { if error as? ServiceError == .signedOut { handle(error) } }
    private func handle(_ error: Error) {
        if error as? ServiceError == .signedOut { invalidateSession(message: error.localizedDescription); Task { try? await session?.clearLocal() } }
        else { errorMessage = error.localizedDescription }
    }
    private func invalidateSession(message: String?, discardDrafts: Bool = false) {
        scheduleBaseline = nil
        ScheduleNotifier.clear()
        diagnostics.forget()
        diagnosticsAccount = nil
        CrashReports.consent = false
        CrashReports.account = nil
        var resetMessage = message
        if discardDrafts {
            do { try composerDraftStorage?.remove() }
            catch { resetMessage = L("generic_error_something_went_wrong_try_again") }
        } else {
            flushComposerDrafts()
        }
        let oldFiles = Set(composerArchive.drafts.values.flatMap(\.files).map(\.url)
            + runningDraftFiles + queueFiles.values.flatMap { $0.map(\.url) } + pendingSends.values.flatMap { $0.draft.files.map(\.url) } + attachments.map(\.url))
        let saved = persistedComposerArchive
        let retained = discardDrafts ? [] : saved.drafts.values.flatMap(\.files).map(\.url) + (saved.pendingSends?.values.flatMap { $0.draft.files.map(\.url) } ?? [])
        applyingComposerDraft = true
        devices.reset()
        imageCaptures = [:]
        hydrator.reset()
        for task in queueTasks.values { task.cancel() }; queueTasks = [:]; queueTaskEntries = [:]
        codeQueueRead?.cancel(); codeQueueRead = nil; codeQueueRefreshPending = false; codeQueues = [:]; pendingCodeSubmissions = [:]; codeQueueRevision += 1
        queueFiles = [:]; runningDraftFiles = []; composerQueue.reset()
        conversationActions = []; markingRead = []; deletedConversationIDs = []; deletedProjectIDs = []; deletingProjects = []; clearGeneratedFiles()
        accountGeneration = UUID(); toolPolicy = nil; draftWebSearch = false; draftResearch = false
        reviewReady = []; Task { [sessionReview] in await sessionReview.clear() }
        isSavingCodePermission = false
        generation += 1; refreshGeneration += 1; conversationBridgeGeneration = UUID(); refreshTracker.reset(); connection?.stop(); resyncTask?.cancel(); resyncTask = nil; recovery.reset(); sendTask?.cancel(); sendTask = nil
        section = .chat; sidebarPresented = false; projectComposerID = nil; composerProjectChoice = nil; preparedRepository = nil; mode = .chat; knowledgeBases = []; draftKnowledge = []; draftConnectors = [:]; connectorPolicy = nil; uploadProgress = nil; isUploading = false; sendGeneration += 1; chatPath = []; chatSurfaceConversationID = nil; snapshot = nil; modelCatalog = .loading; account = nil; activeConversationID = nil; modelPreferences = [:]; isSavingModel = false; composerText = ""; isLoading = false; isSending = false; reducer.reset(); mutations.reset()
        attachments = []
        composerArchive = ComposerDraftArchive()
        pendingSends = [:]
        composerScope = .new(.chat)
        composerEditVersions = [:]
        incognitoComposerScopes = []
        submittedDraft = nil
        applyingComposerDraft = false
        for url in oldFiles.subtracting(retained) { try? FileManager.default.removeItem(at: url) }
        errorMessage = resetMessage; connectionStatus = ""; eventsLive = false
    }
}


extension AppStore {
    private func sendWhileRunning(_ conversation: Conversation, selection: ConversationModelSelection?) {
        let draft = composerText, picks = attachments, epoch = generation
        let scope = composerScope, editVersion = composerEditVersions[composerScope, default: 0]
        let presentation = conversationBridgeGeneration, revision = mutations.revision
        let search = toolPolicy?["webSearch"].bool == true && conversation.extensionFields["webSearch"]?.bool == true
        isSending = true; isUploading = !picks.isEmpty; sendGeneration += 1
        let operation = sendGeneration
        runningDraftFiles.formUnion(picks.map(\.url))
        sendTask = Task {
            var uploaded: [Attachment] = []
            defer {
                if epoch == generation {
                    isSending = false; isUploading = false; uploadProgress = nil; sendTask = nil
                    runningDraftFiles.subtract(picks.map(\.url)); deleteUnownedFiles(picks)
                }
            }
            do {
                for pick in picks {
                    try Task.checkCancellation()
                    if pick.uploaded == nil && (AttachmentLimits.isText(name: pick.name) || AttachmentLimits.isImage(name: pick.name)) {
                        try AttachmentLimits.validate(name: pick.name, data: Data(contentsOf: pick.url, options: .mappedIfSafe))
                    }
                }
                for pick in picks {
                    try Task.checkCancellation()
                    let file: Attachment
                    if let saved = pick.uploaded { file = saved }
                    else {
                        let data = try Data(contentsOf: pick.url, options: .mappedIfSafe)
                        file = try await service.upload(name: pick.name, data: data) { value in
                            Task { @MainActor [weak self] in
                                if self?.generation == epoch, self?.sendGeneration == operation, self?.isUploading == true { self?.uploadProgress = value }
                            }
                        }
                    }
                    uploaded.append(file)
                    if scope == composerScope, let index = attachments.firstIndex(where: { $0.id == pick.id }) {
                        attachments[index].uploaded = file
                    } else if var draft = composerArchive.drafts[scope], let index = draft.files.firstIndex(where: { $0.id == pick.id }) {
                        draft.files[index].uploaded = file
                        composerArchive.drafts[scope] = draft
                        flushComposerDrafts()
                    }
                }
                try Task.checkCancellation()
                guard epoch == generation else { return }
                isUploading = false; uploadProgress = nil
                if conversation.mode == .code {
                    let choice = selection.map { CodeQueueChoice(providerId: $0.key.providerID, model: $0.key.modelID, effort: $0.effort) }
                    let candidate = CodeQueueSubmission(eventId: UUID(), text: draft, attachmentIds: uploaded.map(\.id), priority: "later", choice: choice)
                    let submission: CodeQueueSubmission
                    if let existing = pendingCodeSubmissions[conversation.id], existing.text == candidate.text, existing.attachmentIds == candidate.attachmentIds, existing.choice == candidate.choice {
                        submission = existing
                    } else { submission = candidate }
                    pendingCodeSubmissions[conversation.id] = submission
                    try composerDraftStorage?.save(persistedComposerArchive)
                    let result = try await service.queueCodeMessage(conversation.id, submission: submission)
                    guard epoch == generation, !deletedConversationIDs.contains(conversation.id) else { return }
                    pendingCodeSubmissions[conversation.id] = nil
                    setCodeQueue(result, conversationID: conversation.id)
                    queueFiles[submission.eventId] = savedPicks(picks, uploaded: uploaded)
                    if var sentDraft = composerArchive.drafts[scope] {
                        if composerEditVersions[scope, default: 0] == editVersion { sentDraft.text = "" }
                        let ids = Set(picks.map(\.id))
                        sentDraft.files.removeAll { ids.contains($0.id) }
                        composerArchive.drafts[scope] = sentDraft
                        if scope == composerScope { applyComposerDraft(sentDraft) }
                    }
                    flushComposerDrafts()
                    return
                }
                let result = if selection == nil {
                    try await service.steerTurn(conversation.id, text: draft, attachmentIDs: uploaded.map(\.id))
                } else { nil as SteerResult? }
                guard epoch == generation, !deletedConversationIDs.contains(conversation.id) else { return }
                let entry = QueuedComposerMessage(text: draft, attachments: uploaded, conversation: conversation,
                    webSearch: search, state: result == nil ? .queued : .steered, messageID: result?.messageId,
                    model: selection?.key, effort: selection?.effort)
                composerQueue.add(entry, conversationID: conversation.id)
                queueFiles[entry.id] = savedPicks(picks, uploaded: uploaded)
                if var sentDraft = composerArchive.drafts[scope] {
                    if composerEditVersions[scope, default: 0] == editVersion { sentDraft.text = "" }
                    let ids = Set(picks.map(\.id))
                    sentDraft.files.removeAll { ids.contains($0.id) }
                    composerArchive.drafts[scope] = sentDraft
                    if scope == composerScope { applyComposerDraft(sentDraft) }
                    flushComposerDrafts()
                }
                if let result { upsertMutation(result.conversation, since: revision) }
                reconcileComposerQueues(snapshot?.conversations ?? [])
            } catch is CancellationError {
            } catch {
                guard epoch == generation else { return }
                // If navigation replaced the draft meanwhile, retain the failed
                // original in its own queue, blocked until an explicit edit/removal.
                if conversation.mode != .code && (presentation != conversationBridgeGeneration || composerEditVersions[scope, default: 0] != editVersion || Set(composerArchive.drafts[scope]?.files.map(\.id) ?? []) != Set(picks.map(\.id))), !deletedConversationIDs.contains(conversation.id) {
                    var entry = QueuedComposerMessage(text: draft, attachments: uploaded, conversation: conversation,
                        webSearch: search, state: .queued, model: selection?.key, effort: selection?.effort)
                    entry.error = error.localizedDescription
                    composerQueue.add(entry, conversationID: conversation.id)
                    queueFiles[entry.id] = savedPicks(picks, uploaded: uploaded)
                }
                handle(error)
            }
        }
    }
    private func setCodeQueue(_ result: CodeQueueSnapshot, conversationID: String) {
        guard !deletedConversationIDs.contains(conversationID) else { return }
        codeQueueRevision += 1
        codeQueues[conversationID] = result.entries
    }
    private func refreshCodeQueue() {
        guard account != nil, let conversation = activeConversation, conversation.mode == .code else { return }
        if codeQueueRead != nil { codeQueueRefreshPending = true; return }
        let epoch = generation, revision = codeQueueRevision, id = conversation.id
        codeQueueRead = Task {
            defer {
                if epoch == generation {
                    codeQueueRead = nil
                    if codeQueueRefreshPending { codeQueueRefreshPending = false; refreshCodeQueue() }
                }
            }
            do {
                let result = try await service.codeQueue(id)
                guard epoch == generation, revision == codeQueueRevision, !deletedConversationIDs.contains(id) else { return }
                codeQueues[id] = result.entries
            } catch { if epoch == generation { validateSessionError(error) } }
        }
    }
    private func savedPicks(_ picks: [LocalAttachment], uploaded: [Attachment]) -> [LocalAttachment] {
        picks.enumerated().map { index, original in
            var pick = original
            if index < uploaded.count { pick.uploaded = uploaded[index] }
            return pick
        }
    }
    private func deleteUnownedFiles(_ files: [LocalAttachment]) {
        let owned = Set((composerArchive.drafts.values.flatMap(\.files) + queueFiles.values.flatMap { $0 } + pendingSends.values.flatMap { $0.draft.files }).map(\.url)).union(runningDraftFiles)
        for file in files where !owned.contains(file.url) { try? FileManager.default.removeItem(at: file.url) }
    }
    private func pruneQueueFiles() {
        let live = Set(composerQueue.allEntries.map(\.id) + codeQueues.values.flatMap { $0.map(\.eventId) })
        for id in Array(queueFiles.keys) where !live.contains(id) {
            let files = queueFiles.removeValue(forKey: id) ?? []; deleteUnownedFiles(files)
        }
    }
    private func reconcileComposerQueues(_ conversations: [Conversation]) {
        guard account != nil else { return }
        for conversation in conversations where composerQueue.conversationIDs.contains(conversation.id) {
            composerQueue.reconcile(conversation)
            guard isActive, let lease = composerQueue.beginNext(conversation) else { continue }
            let epoch = generation, revision = mutations.revision
            queueTaskEntries[conversation.id] = lease.entry.id
            queueTasks[conversation.id] = Task {
                defer {
                    if epoch == generation, queueTaskEntries[conversation.id] == lease.entry.id { queueTasks[conversation.id] = nil; queueTaskEntries[conversation.id] = nil }
                }
                do {
                    guard epoch == generation, account != nil, !Task.isCancelled else { return }
                    guard isActive else { composerQueue.releaseBeforeDispatch(lease); return }
                    let result = try await service.send(lease.entry.input(conversationID: conversation.id))
                    guard epoch == generation, composerQueue.complete(lease) else { return }
                    pruneQueueFiles(); upsertMutation(result, since: revision)
                } catch {
                    guard epoch == generation, composerQueue.complete(lease, error: error.localizedDescription) else { return }
                    handle(error)
                }
            }
        }
        pruneQueueFiles()
    }
    func removeQueuedMessage(_ entry: QueuedComposerMessage) {
        guard let id = activeConversationID, entry.state == .queued else { return }
        if activeConversation?.mode == .code {
            let epoch = generation
            Task { do { let result = try await service.cancelCodeMessage(id, eventID: entry.id); guard epoch == generation else { return }; setCodeQueue(result, conversationID: id); pruneQueueFiles() } catch { if epoch == generation { handle(error) } } }
            return
        }
        if composerQueue.remove(entry.id, conversationID: id) { pruneQueueFiles(); reconcileComposerQueues(snapshot?.conversations ?? []) }
    }
    func editQueuedMessage(_ entry: QueuedComposerMessage) {
        guard let id = activeConversationID, entry.state == .queued, !composerQueue.isSending(id) else { return }
        if activeConversation?.mode == .code {
            let epoch = generation, scope = composerScope
            guard entry.attachments.count + attachments.count <= AttachmentLimits.maximumCount else { errorMessage = L("chat_input_attachment_limit_reached_toast", AttachmentLimits.maximumCount); return }
            Task {
                var created: [LocalAttachment] = []
                do {
                    let picks: [LocalAttachment]
                    if let existing = queueFiles[entry.id] { picks = existing }
                    else if entry.attachments.isEmpty { picks = [] }
                    else {
                        guard let directory = composerDraftStorage?.attachmentsDirectory else { throw ServiceError.invalidResponse }
                        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                        for attachment in entry.attachments {
                            let data = try await service.codeQueueAttachment(id, attachmentID: attachment.id)
                            let url = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension((attachment.name as NSString).pathExtension)
                            try data.write(to: url)
                            created.append(LocalAttachment(name: attachment.name, url: url, size: attachment.size, uploaded: attachment))
                        }
                        picks = created
                    }
                    let result = try await service.cancelCodeMessage(id, eventID: entry.id)
                    guard epoch == generation, !deletedConversationIDs.contains(id) else { deleteUnownedFiles(created); return }
                    setCodeQueue(result, conversationID: id)
                    var draft = composerArchive.drafts[scope] ?? ComposerDraft()
                    draft.text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? entry.text : entry.text + "\n" + draft.text
                    draft.files = picks + draft.files
                    composerArchive.drafts[scope] = draft; queueFiles[entry.id] = nil
                    if scope == composerScope {
                        applyComposerDraft(draft)
                        if entry.startsNextTurn {
                            conversationModelSelection = .init(key: .init(providerID: entry.providerID, modelID: entry.model), effort: entry.effort)
                        }
                    }
                    flushComposerDrafts()
                } catch { deleteUnownedFiles(created); if epoch == generation { handle(error) } }
            }
            return
        }
        let picks = queueFiles[entry.id] ?? []
        let restoredIDs = Set(picks.map(\.id))
        let merged = picks + attachments.filter { !restoredIDs.contains($0.id) }
        guard merged.count <= AttachmentLimits.maximumCount else { errorMessage = L("chat_input_attachment_limit_reached_toast", AttachmentLimits.maximumCount); return }
        guard composerQueue.remove(entry.id, conversationID: id) else { return }
        composerText = composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? entry.text : entry.text + "\n" + composerText
        attachments = merged; queueFiles[entry.id] = nil
        reconcileComposerQueues(snapshot?.conversations ?? [])
    }
    func sendQueuedNow(_ entry: QueuedComposerMessage) {
        if account != nil, let id = activeConversationID, activeConversation?.mode == .code {
            let epoch = generation, target = activeConversation.flatMap(ChatStopTarget.init)
            Task { do { let result = try await service.sendQueuedCodeMessage(id, eventID: entry.id, target: target); guard epoch == generation else { return }; setCodeQueue(result, conversationID: id) } catch { if epoch == generation { handle(error) } } }
            return
        }
        guard account != nil, !entry.startsNextTurn, let id = activeConversationID,
              let lease = composerQueue.beginManualSteer(entry.id, conversationID: id) else { return }
        if (queueFiles[entry.id] ?? []).contains(where: { $0.uploaded == nil }) {
            composerQueue.complete(lease, error: L("claudex_msg_queued_not_sent")); return
        }
        let epoch = generation, revision = mutations.revision
        queueTaskEntries[id] = lease.entry.id
        queueTasks[id] = Task {
            defer { if epoch == generation, queueTaskEntries[id] == lease.entry.id { queueTasks[id] = nil; queueTaskEntries[id] = nil } }
            do {
                guard epoch == generation, account != nil, !Task.isCancelled else { return }
                let result = try await service.steerTurn(id, text: entry.text, attachmentIDs: entry.attachments.map(\.id))
                guard epoch == generation else { return }
                if let result {
                    guard composerQueue.completeSteer(lease, messageID: result.messageId) else { return }
                    upsertMutation(result.conversation, since: revision)
                } else { composerQueue.complete(lease, error: L("claudex_msg_queued_not_sent")) }
            } catch {
                guard epoch == generation, composerQueue.complete(lease, error: error.localizedDescription) else { return }
                handle(error)
            }
        }
    }
}

extension AppStore {
    func imageSnapshotKey(_ conversationID: String) -> String {
        let current = snapshot?.conversations.first { $0.id == conversationID }
        return conversationBridgeGeneration.uuidString + (current.map { TranscriptImageSnapshots.observations($0).map(\.revisionKey).joined(separator: "|") } ?? "")
    }
    func captureTranscriptImages(_ conversationID: String, generation expected: UUID) async {
        guard account != nil, expected == conversationBridgeGeneration, activeConversationID == conversationID,
              let current = snapshot?.conversations.first(where: { $0.id == conversationID }) else { return }
        let observations = TranscriptImageSnapshots.observations(current)
        imageCaptures = imageCaptures.filter { observations.contains($0.value.observation) }
        for observation in observations {
            do {
                try Task.checkCancellation()
                guard expected == conversationBridgeGeneration, activeConversationID == conversationID, account != nil,
                      let current = snapshot?.conversations.first(where: { $0.id == conversationID }),
                      TranscriptImageSnapshots.isCurrent(observation, in: current) else { return }
                if imageCaptures[observation.key]?.observation == observation { continue }
                let captured = try await accountRequest { remote in try await remote.transcriptImageSnapshot(observation) }
                try Task.checkCancellation()
                guard expected == conversationBridgeGeneration, activeConversationID == conversationID, account != nil,
                      let current = snapshot?.conversations.first(where: { $0.id == conversationID }) else { return }
                guard TranscriptImageSnapshots.isCurrent(observation, in: current), let captured else { continue }
                imageCaptures[observation.key] = captured
            } catch is CancellationError { return }
            catch { guard expected == conversationBridgeGeneration else { return }; validateSessionError(error) }
        }
    }
    func validateSharedExport(_ file: GeneratedFile, conversationID: String, generation expected: UUID) throws {
        guard account != nil, conversationBridgeGeneration == expected, activeConversationID == conversationID,
              let current = conversations.first(where: { $0.id == conversationID }) else { throw CancellationError() }
        guard SharedConversationResolver.containsFile(file, conversation: current) else {
            throw ServiceError.server(L("claudex_msg_file_changed"), "EXPORT_SOURCE_CHANGED")
        }
    }
    /// Resolve every action against the *current* native state. The WebView never
    /// supplies a provider, RPC name, trusted file path, credentials or a snapshot.
    func dispatchSharedConversationAction(_ action: SharedConversationAction, conversationID: String,
                                          generation expected: UUID,
                                          present: (SharedConversationDestination) -> Void,
                                          export: (GeneratedFile) async throws -> String?) async throws -> JSONValue {
        try Task.checkCancellation()
        guard account != nil, conversationBridgeGeneration == expected, activeConversationID == conversationID,
              let conversation = conversations.first(where: { $0.id == conversationID }) else { throw CancellationError() }
        let payload = action.payload
        if let claimed = payload["conversationId"].string, claimed != conversationID { throw SharedConversationProtocolError.staleSession }
        func checkedTurn() throws -> Turn {
            guard let id = payload["turnId"].string, let turn = SharedConversationResolver.turn(id, conversation: conversation), (turn.extensionFields["compaction"] == nil || turn.extensionFields["compaction"] == .null) else { throw ServiceError.invalidResponse }
            return turn
        }
        func requireIdle() throws {
            guard SharedConversationResolver.canMutate(conversation, sending: isSending), !conversationActions.contains(conversationID) else { throw ServiceError.server(L("claudex_msg_wait_reply"), nil) }
        }
        func requireSuccess(_ value: Bool) throws {
            guard value else { throw ServiceError.server(L("error_unknown"), nil) }
        }
        switch action.type {
        case .copyText:
            let text = payload["text"].string ?? ""
            guard SharedConversationResolver.containsText(text, conversation: conversation) else { throw ServiceError.invalidResponse }
            UIPasteboard.general.string = text
        case .editPrompt:
            try requireIdle(); let turn = try checkedTurn()
            try requireSuccess(await editPrompt(conversationID: conversationID, turnID: turn.id, text: payload["text"].string ?? ""))
        case .retryResponse:
            try requireIdle(); let turn = try checkedTurn()
            try requireSuccess(await retryResponse(conversationID: conversationID, turnID: turn.id))
        case .selectVersion:
            try requireIdle(); let turn = try checkedTurn()
            guard SharedConversationResolver.canSelectVersion(payload, conversation: conversation) else { throw ServiceError.invalidResponse }
            try requireSuccess(await selectVersion(conversationID: conversationID, turnID: turn.id, versionTurnID: payload["versionId"].string ?? "", prompt: payload["prompt"].bool == true))
        case .replyFeedback:
            let turn = try checkedTurn()
            guard conversation.mode != .code, turn.status == "completed" else { throw ServiceError.invalidResponse }
            try requireSuccess(await rateReply(conversationID: conversationID, turnID: turn.id, rating: payload["rating"].string.flatMap(ReplyRating.init(rawValue:))))
        case .continueResponse:
            try requireIdle()
            guard conversation.mode == .chat, conversation.turns.last?.stopReason == "length" else { throw ServiceError.invalidResponse }
            let epoch = generation, streamRevision = mutations.revision
            let completed = await performConversationAction(conversationID) { remote, current in
                guard current.turns.last?.stopReason == "length" else { throw ServiceError.invalidResponse }
                let next = try await remote.send(SendInput(conversationId: current.id, text: "Continue", mode: current.mode, projectId: current.projectId, attachments: [], providerId: current.providerId, model: current.model))
                guard epoch == generation else { throw CancellationError() }
                upsertMutation(next, since: streamRevision)
            }
            try requireSuccess(completed)
        case .quoteReply:
            let text = payload["text"].string ?? ""
            guard let quote = SharedConversationResolver.quoteForComposer(text, conversation: conversation) else { throw ServiceError.invalidResponse }
            composerText += (composerText.isEmpty ? "" : "\n\n") + quote
        case .openAttachment:
            guard let attachment = SharedConversationResolver.attachment(payload["attachmentId"].string ?? "", conversation: conversation) else { throw ServiceError.invalidResponse }
            present(.attachment(attachment))
        case .openArtifact:
            guard let file = SharedConversationResolver.file(payload, conversation: conversation), file.isReady else { throw ServiceError.invalidResponse }
            present(.file(file))
        case .downloadArtifact:
            guard let file = SharedConversationResolver.file(payload, conversation: conversation), file.isReady else { throw ServiceError.invalidResponse }
            let savedName = try await export(file)
            try Task.checkCancellation()
            guard conversationBridgeGeneration == expected, activeConversationID == conversationID, account != nil else { throw CancellationError() }
            return savedName.map(JSONValue.string) ?? .null
        case .downloadArtifacts:
            guard let identities = payload["files"].array, (1...32).contains(identities.count) else { throw ServiceError.invalidResponse }
            guard identities.allSatisfy({ $0["conversationId"].string == conversationID && SharedConversationResolver.file($0, conversation: conversation)?.isReady == true }) else { throw ServiceError.invalidResponse }
            var progress = try SharedConversationBatchProgress(total: identities.count)
            for (index, identity) in identities.enumerated() {
                try Task.checkCancellation()
                guard conversationBridgeGeneration == expected, activeConversationID == conversationID, account != nil,
                      let current = conversations.first(where: { $0.id == conversationID }) else { throw CancellationError() }
                guard let file = SharedConversationResolver.file(identity, conversation: current), file.isReady else {
                    throw ServiceError.server(L("claudex_msg_saved_partial", progress.saved, L("claudex_msg_file_changed")), "EXPORT_SOURCE_CHANGED")
                }
                let savedName: String?
                do { savedName = try await export(file) }
                catch is CancellationError { throw CancellationError() }
                catch {
                    validateSessionError(error)
                    guard conversationBridgeGeneration == expected, account != nil else { throw CancellationError() }
                    throw ServiceError.server(L("claudex_msg_saved_partial", progress.saved, error.localizedDescription), "EXPORT_PARTIAL_FAILURE")
                }
                try Task.checkCancellation()
                guard conversationBridgeGeneration == expected, activeConversationID == conversationID, account != nil else { throw CancellationError() }
                guard progress.complete(index: index, didSave: savedName != nil) else { throw ServiceError.invalidResponse }
                if progress.cancelled { return progress.result }
            }
            return progress.result
        case .openLink:
            let text = payload["url"].string ?? ""
            guard let url = SharedConversationProtocol.safeLink(text), SharedConversationResolver.containsLink(text, conversation: conversation) else { throw ServiceError.invalidResponse }
            present(.link(url))
        case .loadRemoteImage:
            throw ServiceError.server(L("generic_error_something_went_wrong_try_again"), "UNSUPPORTED_REMOTE_IMAGE")
        case .openChanges: present(.changes(conversation))
        case .openWorkflow, .openAgent, .openPlan:
            throw ServiceError.server(L("generic_error_something_went_wrong_try_again"), "UNSUPPORTED_NATIVE_DETAIL")
        }
        try Task.checkCancellation()
        guard conversationBridgeGeneration == expected, activeConversationID == conversationID, account != nil else { throw CancellationError() }
        return .null
    }
}

extension AppStore {
    /// Sends an artifact comment to the artifact's chat (the official "Artifact comment sent to Claude"); false after saying why.
    @MainActor func sendArtifactComment(_ conversation: Conversation, text: String) async -> Bool {
        guard account != nil else { presentLogin = true; return false }
        guard !isSending, !conversation.isRunning else { Snackbars.shared.show(L("claudex_artifact_comment_busy")); return false }
        let epoch = generation, revision = mutations.revision
        isSending = true
        defer { if epoch == generation { isSending = false } }
        do {
            let result = try await service.send(SendInput(conversationId: conversation.id, text: text, mode: conversation.mode, projectId: conversation.projectId,
                                                          attachments: [], providerId: conversation.providerId, model: conversation.model))
            guard epoch == generation else { return false }
            upsertMutation(result, since: revision)
            return true
        } catch is CancellationError { return false } catch {
            if epoch == generation { handle(error) }
            return false
        }
    }
}

private final class ReplyNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    var open: ((String) -> Void)?
    var decide: ((String, Bool, @escaping () -> Void) -> Void)?
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == "approval-allow" || response.actionIdentifier == "approval-deny",
           let id = response.notification.request.content.userInfo["approval"] as? String {
            decide?(id, response.actionIdentifier == "approval-allow", completionHandler)
            return
        }
        if let id = response.notification.request.content.userInfo["conversation"] as? String { open?(id) }
        completionHandler()
    }
}

private enum ShareInbox {
    static func take() -> (text: String, files: [URL], remove: () -> Void)? {
        guard let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.cn.zecous.claudex")?.appendingPathComponent("share", isDirectory: true),
              let data = try? Data(contentsOf: folder.appendingPathComponent("inbox.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let text = object["text"] as? String ?? ""
        let names = object["files"] as? [String] ?? []
        let files = names.filter { !$0.contains("/") && $0 != ".." }.map { folder.appendingPathComponent($0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
        return (text, files, { try? FileManager.default.removeItem(at: folder) })
    }
}

private enum ReplyNotifier {
    static func post(id: String, conversationTitle: String) {
        let title = L("chat_completion_notification_posted")
        let body = conversationTitle.isEmpty ? L("chat_completion_notification_settings_description") : conversationTitle
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.userInfo = ["conversation": id]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "reply-\(id)", content: content, trigger: nil))
        }
    }
}

private enum ApprovalNotifier {
    static func post(id: String, conversation: String, conversationTitle: String, task: Bool, buttons: Bool, done: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { done(false); return }
            done(true)
            let content = UNMutableNotificationContent()
            content.title = L(task ? "scheduled_task_needs_approval" : "claudex_approval_waiting")
            content.body = conversationTitle.isEmpty ? L(task ? "scheduled_task_fallback" : "generic_untitled") : conversationTitle
            content.userInfo = ["approval": id, "conversation": conversation]
            if buttons { content.categoryIdentifier = "approval" }
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "approval-\(id)", content: content, trigger: nil))
        }
    }
}

private enum ScheduleNotifier {
    static func post(_ notice: RoutineNotice) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = L(notice.completed ? "scheduled_task_completed" : "scheduled_task_failed")
            content.body = notice.body.isEmpty ? L("scheduled_task_fallback") : notice.body
            content.userInfo = ["conversation": notice.conversationId]
            if !notice.completed { content.sound = .default }
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "schedule-\(notice.conversationId)", content: content, trigger: nil))
        }
    }
    static func clear() {
        UNUserNotificationCenter.current().getDeliveredNotifications { notes in
            let ids = notes.map(\.request.identifier).filter { $0.hasPrefix("schedule-") }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        }
    }
}
