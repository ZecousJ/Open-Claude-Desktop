import SwiftUI
import UniformTypeIdentifiers
import UIKit

enum ChatRoute: Hashable { case history, conversation(String) }

struct LocalAttachment: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let url: URL
    let size: Int
    var uploaded: Attachment?
}
@MainActor
final class AppStore: ObservableObject {
    @Published var section: AppSection = .chat
    @Published var sidebarPresented = false
    @Published var chatPath: [ChatRoute] = []
    @Published private(set) var chatSurfaceConversationID: String?
    @Published var snapshot: Snapshot?
    @Published var catalog: ModelCatalog?
    @Published var account: SessionAccount?
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
    private var isUploading = false
    private var sendGeneration = 0
    @Published var errorMessage: String?
    @Published var connectionStatus = ""
    /// The account's online computers and the Code conversation opened on one.
    let devices = DeviceController()
    @Published var selectedModelID = ""
    @Published var selectedProviderID = ""
    @Published private(set) var isSavingModel = false
    @Published private(set) var accountGeneration = UUID()
    @Published private(set) var toolPolicy: JSONValue?
    @Published private(set) var draftWebSearch = false
    @Published private(set) var draftResearch = false
    @Published var mode: ChatMode = .chat
    @Published var composerText = ""
    @Published var attachments: [LocalAttachment] = []
    @Published var activeConversationID: String? {
        didSet {
            guard oldValue != activeConversationID else { return }
            imageCaptures = [:]
            // A first send from the new-chat page keeps the bridge: the transcript mounted
            // under the greeting only ever held the empty draft, so it carries on.
            if keepsDraftBridge { keepsDraftBridge = false } else { conversationBridgeGeneration = UUID() }
            hydrator.select(activeConversationID)
        }
    }
    private var keepsDraftBridge = false
    @Published private(set) var transcriptLoads: [String: TranscriptLoadState] = [:]
    @Published var preparedRepository: RepositoryReference?
    @Published var preparedProjectID: String?
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
    private var queueTasks: [String: Task<Void, Never>] = [:]
    private var queueTaskEntries: [String: UUID] = [:]
    private var queueFiles: [UUID: [LocalAttachment]] = [:]
    private var runningDraftFiles: Set<URL> = []
    init(session: NativeSession, service: any ClaudexService) {
        self.session = session; self.service = service; configurationError = nil
    }
    /// Dependency injection for local service regressions; production uses init().
    init(service: any ClaudexService) {
        self.service = service; session = nil; configurationError = nil
    }
    init() {
        let origin = Bundle.main.object(forInfoDictionaryKey: "CLAUDEX_SERVICE_URL") as? String ?? ""
        if let url = URL(string: origin), url.scheme == "https", let host = url.host {
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
        connection?.onStatus = { [weak self] in self?.connectionStatus = $0 }
        connection?.onSignedOut = { [weak self] in self?.invalidateSession(message: L("error_account_session_invalid")); Task { try? await self?.session?.clearLocal() } }
    }
    var conversations: [Conversation] {
        (snapshot?.conversations ?? []).map { TranscriptImageSnapshots.applying(Array(imageCaptures.values), to: $0) }
            .sorted { $0.pinned == $1.pinned ? $0.updatedAt > $1.updatedAt : $0.pinned }
    }
    var selectedModel: ModelItem? { catalog?.items.first { $0.id == selectedModelID } }
    var activeConversation: Conversation? { conversations.first { $0.id == activeConversationID } }
    var selectedProvider: Provider? { snapshot?.settings.providers.first { $0.id == (selectedProviderID.isEmpty ? (activeConversation?.providerId ?? snapshot?.settings.activeProviderId) : selectedProviderID) } }
    var availableModes: [ChatMode] { [.chat] + (snapshot?.host?["capabilities"]["cloudCowork"].bool == true ? [.cowork] : []) + (snapshot?.host?["capabilities"]["cloudCode"].bool == true ? [.code] : []) }
    var availableModels: [ModelItem] { catalog?.items ?? (selectedProvider?.models ?? []).enumerated().map { index, id in ModelItem(id: id, displayName: id, description: L("claudex_model_assigned"), badges: [], sort: index, hidden: false, isDefault: selectedProvider?.model == id, usageHint: "", efforts: nil, defaultEffort: nil, contextWindow: nil) } }
    var webSearchEnabled: Bool { activeConversation?.extensionFields["webSearch"]?.bool ?? (activeConversation == nil ? draftWebSearch : false) }
    var researchEnabled: Bool { (activeConversation?.mode ?? mode) == .chat && (activeConversation?.extensionFields["research"]?.bool ?? (activeConversation == nil ? draftResearch : false)) }
    var running: Bool { activeConversation?.isRunning == true }
    var composerBusy: Bool { isSending || composerQueue.isSending(activeConversationID ?? "") }
    var queuedMessages: [QueuedComposerMessage] { activeConversationID.map(composerQueue.entries) ?? [] }
    var canSend: Bool { !isSavingCodePermission && !composerBusy && !conversationActions.contains(activeConversationID ?? "") && (!composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty) }
    func boot() async {
        defer { isRestoringSession = false }
        clearGeneratedFiles()
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("ClaudexAttachments", isDirectory: true))
        guard !ProcessInfo.processInfo.arguments.contains("-ui-testing"), let session else { return }
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
        // The launch screen holds only until the account is back; the lists fill in after.
        isRestoringSession = false
        await refresh(); if isActive { connection?.start() }
    }
    func refresh() async {
        guard account != nil else { presentLogin = true; return }
        let epoch = generation, streamRevision = refreshTracker.revision
        let observed = recovery.observedSequence
        refreshGeneration += 1; let request = refreshGeneration; isLoading = true
        hydrator.invalidateSource()
        defer { if epoch == generation, request == refreshGeneration { isLoading = false } }
        do {
            async let nextSnapshot = service.snapshotCoverage()
            async let nextModels: ModelCatalog? = try? service.models()
            async let nextPolicy: JSONValue? = try? remote?.schedulePolicy()
            let (state, served) = try await nextSnapshot
            let coveredSequence = served ?? observed
            let models = await nextModels
            guard epoch == generation, request == refreshGeneration else { return }
            snapshot = excludingDeleted(refreshTracker.reconcile(state, current: snapshot, since: streamRevision)); reducer.recover(snapshot!, covering: coveredSequence); recovery.recovered()
            hydrator.observe(snapshot!.conversations, snapshotReplacement: true)
            readVisibleConversationIfNeeded()
            reconcileComposerQueues(snapshot?.conversations ?? [])
            catalog = models; lastRefresh = Date()
            if selectedModelID.isEmpty, activeConversation == nil, let key = SavedModelChoice.key(account: account?.email ?? ""),
               let saved = SavedModelChoice.restore(UserDefaults.standard.string(forKey: key), providers: state.settings.providers) {
                selectedProviderID = saved.providerID; selectedModelID = saved.modelID
            }
            if !state.settings.providers.contains(where: { $0.id == selectedProviderID }) { selectedProviderID = activeConversation?.providerId ?? state.settings.activeProviderId }
            if isActive { connection?.start() }
            let assigned = Set(selectedProvider?.models ?? [])
            if !assigned.contains(selectedModelID) { selectedModelID = selectedProvider?.model ?? models?.defaultModel.flatMap { assigned.contains($0) ? $0 : nil } ?? "" }
            let policy = await nextPolicy
            if epoch == generation, request == refreshGeneration { toolPolicy = policy }
        } catch { if epoch == generation, request == refreshGeneration { handle(error) } }
    }
    func send() {
        guard canSend else { return }
        guard account != nil else { presentLogin = true; return }
        if let conversation = activeConversation, conversation.isRunning { sendWhileRunning(conversation); return }
        guard activeConversationID != nil || availableModes.contains(mode) else { errorMessage = L("claudex_msg_mode_unavailable"); return }
        guard let provider = selectedProvider, provider.models.contains(selectedModelID) else { errorMessage = snapshot?.modelUnavailable ?? L("claudex_msg_no_model"); return }
        let draft = composerText, picks = attachments, conversationID = activeConversationID, selectedMode = activeConversation?.mode ?? mode, model = selectedModelID, epoch = generation
        let webSearch = webSearchEnabled, research = researchEnabled
        let streamRevision = mutations.revision, presentationLease = conversationBridgeGeneration
        let startsOnChatSurface = conversationID == nil && section == .chat && chatPath.isEmpty
        let projectID = activeConversation?.projectId ?? preparedProjectID, repository = preparedRepository
        isSending = true; isUploading = !picks.isEmpty; sendGeneration += 1
        let operation = sendGeneration
        // Official: the box empties as soon as Send is tapped (the "Sending…" hint shows);
        // the text comes back if the send fails or is cancelled.
        composerText = ""
        let restoreDraft = { [weak self] in
            guard let self, epoch == self.generation, self.composerText.isEmpty else { return }
            self.composerText = draft
        }
        sendTask = Task {
            defer { if epoch == generation { isSending = false; isUploading = false; uploadProgress = nil; sendTask = nil } }
            do {
                var uploaded: [Attachment] = []
                for pick in picks {
                    try Task.checkCancellation()
                    if let saved = pick.uploaded { uploaded.append(saved) }
                    else {
                        let data = try Data(contentsOf: pick.url, options: .mappedIfSafe)
                        let attachment = try await service.upload(name: pick.name, data: data) { value in Task { @MainActor [weak self] in if self?.generation == epoch, self?.sendGeneration == operation, self?.isUploading == true { self?.uploadProgress = value } } }
                        uploaded.append(attachment)
                        if let i = attachments.firstIndex(where: { $0.id == pick.id }) { attachments[i].uploaded = attachment }
                    }
                }
                try Task.checkCancellation()
                guard epoch == generation else { throw CancellationError() }
                isUploading = false; uploadProgress = nil
                let result = try await service.send(SendInput(conversationId: conversationID, text: draft, mode: selectedMode, projectId: projectID, attachments: uploaded, providerId: provider.id, model: model, repository: conversationID == nil && selectedMode == .code ? repository : nil, webSearch: conversationID == nil ? webSearch : nil, research: conversationID == nil ? research : nil))
                guard epoch == generation else { return }
                upsertMutation(result, since: streamRevision)
                guard presentationLease == conversationBridgeGeneration else { return }
                keepsDraftBridge = startsOnChatSurface && conversationID == nil && activeConversationID == nil
                activeConversationID = result.id; section = .chat
                keepsDraftBridge = false
                if startsOnChatSurface { chatSurfaceConversationID = result.id }
                else if conversationID == nil { chatPath.append(.conversation(result.id)) }
                if composerText == draft { composerText = "" }
                for pick in picks { removeAttachment(pick.id) }
            } catch is CancellationError { restoreDraft() } catch { restoreDraft(); if epoch == generation { handle(error) } }
        }
    }
    func cancelUpload() { sendTask?.cancel() }
    func stopGeneration() async {
        guard let id = activeConversationID else { sendTask?.cancel(); return }
        do { try await service.interrupt(id); await refresh() } catch { handle(error) }
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
            if preparedProjectID == id { preparedProjectID = nil }
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
            guard conversation.mode == .chat, conversation.turns.contains(where: { $0.id == turnID }) else { throw ServiceError.invalidResponse }
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
        }
    }
    func deleteConversation(_ id: String) async {
        let epoch = generation
        _ = await performConversationAction(id) { remote, _ in
            try await remote.deleteConversation(id)
            guard epoch == generation else { return }
            deletedConversationIDs.insert(id)
            queueTasks[id]?.cancel(); queueTasks[id] = nil; queueTaskEntries[id] = nil; composerQueue.removeConversation(id); pruneQueueFiles()
            if let state = snapshot { snapshot = excludingDeleted(state) }
            if activeConversationID == id { newConversation() }
            chatPath.removeAll { $0 == .conversation(id) }
            if let snapshot { reducer.replace(snapshot); hydrator.observe(snapshot.conversations, snapshotReplacement: true) }
        }
    }
    func setEffort(_ effort: String) async {
        guard account != nil, !isSavingModel, let settings = snapshot?.settings, ModelMenuPolicy.efforts(selectedModel).contains(effort) else { return }
        let epoch = generation
        isSavingModel = true
        defer { if epoch == generation { isSavingModel = false } }
        do { let saved = try await service.saveSettings(settings.replacingEffort(effort, mode: mode)); guard epoch == generation else { return }; snapshot?.settings = saved; refreshTracker.recordField("settings"); if let snapshot { reducer.replace(snapshot) } }
        catch { if epoch == generation { handle(error) } }
    }
    func selectModel(_ choice: ModelChoice) async -> Bool {
        guard account != nil, !isSavingModel, let settings = snapshot?.settings else { return false }
        let epoch = generation, conversationID = activeConversationID
        isSavingModel = true
        defer { if epoch == generation { isSavingModel = false } }
        do {
            let next = try settings.replacingSelectedModel(providerID: choice.providerID, modelID: choice.model.id)
            let saved = try await service.saveSettings(next)
            guard epoch == generation else { return false }
            snapshot?.settings = saved; refreshTracker.recordField("settings")
            if let snapshot { reducer.replace(snapshot) }
            if activeConversationID == conversationID { selectedProviderID = choice.providerID; selectedModelID = choice.model.id }
            if let key = SavedModelChoice.key(account: account?.email ?? "") {
                UserDefaults.standard.set(SavedModelChoice.encode(providerID: choice.providerID, modelID: choice.model.id), forKey: key)
            }
            return true
        } catch { if epoch == generation { handle(error) }; return false }
    }
    /// Code session menu "Change model": the session's model from its next message on (a running turn is not
    /// interrupted); the account's own model choice stays. False when saving failed.
    func changeConversationModel(_ conversation: Conversation, to choice: ModelChoice) async -> Bool {
        guard account != nil, !isSavingModel else { return false }
        if conversation.providerId == choice.providerID && conversation.model == choice.model.id { return true }
        let epoch = generation
        isSavingModel = true
        defer { if epoch == generation { isSavingModel = false } }
        do {
            let result = try await service.updateConversation(conversation.id, patch: .object(["providerId": .string(choice.providerID), "model": .string(choice.model.id)]))
            guard epoch == generation else { return false }
            upsert(result)
            if activeConversationID == conversation.id { selectedProviderID = choice.providerID; selectedModelID = choice.model.id }
            return true
        } catch is CancellationError { return false }
        catch { if epoch == generation { errorMessage = L("ccr_model_save_failed") }; return false }
    }
    func beginNewChat() {
        newConversation(); mode = .chat; chatPath = []; section = .chat; sidebarPresented = false
    }
    func newConversation() { chatSurfaceConversationID = nil; conversationBridgeGeneration = UUID(); draftWebSearch = false; draftResearch = false; activeConversationID = nil; composerText = ""; preparedRepository = nil; preparedProjectID = nil; for attachment in attachments where !runningDraftFiles.contains(attachment.url) { try? FileManager.default.removeItem(at: attachment.url) }; attachments = [] }
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
        if activeConversationID != conversation.id { newConversation() }
        activeConversationID = conversation.id; selectedProviderID = conversation.providerId; selectedModelID = conversation.model; mode = conversation.mode
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
        if active { readVisibleConversationIfNeeded() }
        hydrator.select(active ? activeConversationID : nil)
        if active && account != nil { connection?.start() } else { connection?.stop() }
    }
    func signOut() async {
        invalidateSession(message: nil)
        do { try await session?.signOut() } catch { errorMessage = L("generic_error_something_went_wrong_try_again") }
    }
    func addFile(_ source: URL, displayName: String? = nil) {
        do {
            guard attachments.count < AttachmentLimits.maximumCount else { throw ServiceError.server(L("chat_input_attachment_limit_reached_toast", AttachmentLimits.maximumCount), nil) }
            let accessed = source.startAccessingSecurityScopedResource(); defer { if accessed { source.stopAccessingSecurityScopedResource() } }
            let values = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true else { throw ServiceError.server(L("generic_error_something_went_wrong_try_again"), nil) }
            guard (values.fileSize ?? 0) <= AttachmentLimits.clientMaximum else { throw ServiceError.tooLarge }
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ClaudexAttachments", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let target = folder.appendingPathComponent(UUID().uuidString + "-" + source.lastPathComponent)
            try FileManager.default.copyItem(at: source, to: target)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: target.path)
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
        if let local = attachments.first(where: { $0.id == id }), !runningDraftFiles.contains(local.url) { try? FileManager.default.removeItem(at: local.url) }
        attachments.removeAll { $0.id == id }
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
            case .signedOut(let message): invalidateSession(message: message); Task { try? await session?.clearLocal() }
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
    private func invalidateSession(message: String?) {
        devices.reset()
        imageCaptures = [:]
        hydrator.reset()
        for task in queueTasks.values { task.cancel() }; queueTasks = [:]; queueTaskEntries = [:]
        for file in queueFiles.values.flatMap({ $0 }) { try? FileManager.default.removeItem(at: file.url) }
        for url in runningDraftFiles { try? FileManager.default.removeItem(at: url) }
        queueFiles = [:]; runningDraftFiles = []; composerQueue.reset()
        conversationActions = []; markingRead = []; deletedConversationIDs = []; deletedProjectIDs = []; deletingProjects = []; clearGeneratedFiles()
        accountGeneration = UUID(); toolPolicy = nil; draftWebSearch = false; draftResearch = false
        reviewReady = []; Task { [sessionReview] in await sessionReview.clear() }
        isSavingCodePermission = false
        generation += 1; refreshGeneration += 1; conversationBridgeGeneration = UUID(); refreshTracker.reset(); connection?.stop(); resyncTask?.cancel(); resyncTask = nil; recovery.reset(); sendTask?.cancel(); sendTask = nil
        section = .chat; sidebarPresented = false; preparedProjectID = nil; preparedRepository = nil; uploadProgress = nil; isUploading = false; sendGeneration += 1; chatPath = []; chatSurfaceConversationID = nil; snapshot = nil; catalog = nil; account = nil; activeConversationID = nil; selectedModelID = ""; selectedProviderID = ""; isSavingModel = false; composerText = ""; isLoading = false; isSending = false; reducer.reset(); mutations.reset()
        for attachment in attachments { try? FileManager.default.removeItem(at: attachment.url) }; attachments = []
        errorMessage = message; connectionStatus = ""
    }
}


extension AppStore {
    private func sendWhileRunning(_ conversation: Conversation) {
        let draft = composerText, picks = attachments, epoch = generation
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
                    if let index = attachments.firstIndex(where: { $0.id == pick.id }) { attachments[index].uploaded = file }
                }
                try Task.checkCancellation()
                guard epoch == generation else { return }
                isUploading = false; uploadProgress = nil
                let result = try await service.steerTurn(conversation.id, text: draft, attachmentIDs: uploaded.map(\.id))
                guard epoch == generation, !deletedConversationIDs.contains(conversation.id) else { return }
                let entry = QueuedComposerMessage(text: draft, attachments: uploaded, conversation: conversation,
                    webSearch: search, state: result == nil ? .queued : .steered, messageID: result?.messageId)
                composerQueue.add(entry, conversationID: conversation.id)
                queueFiles[entry.id] = savedPicks(picks, uploaded: uploaded)
                // A late reply belongs to the original queue, never the newly opened composer.
                if presentation == conversationBridgeGeneration, activeConversationID == conversation.id {
                    if composerText == draft { composerText = "" }
                    let ids = Set(picks.map(\.id)); attachments.removeAll { ids.contains($0.id) }
                }
                if let result { upsertMutation(result.conversation, since: revision) }
                reconcileComposerQueues(snapshot?.conversations ?? [])
            } catch is CancellationError {
            } catch {
                guard epoch == generation else { return }
                // If navigation replaced the draft meanwhile, retain the failed
                // original in its own queue, blocked until an explicit edit/removal.
                if (presentation != conversationBridgeGeneration || composerText != draft || Set(attachments.map(\.id)) != Set(picks.map(\.id))), !deletedConversationIDs.contains(conversation.id) {
                    var entry = QueuedComposerMessage(text: draft, attachments: uploaded, conversation: conversation,
                        webSearch: search, state: .queued)
                    entry.error = error.localizedDescription
                    composerQueue.add(entry, conversationID: conversation.id)
                    queueFiles[entry.id] = savedPicks(picks, uploaded: uploaded)
                }
                handle(error)
            }
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
        let owned = Set((attachments + queueFiles.values.flatMap { $0 }).map(\.url)).union(runningDraftFiles)
        for file in files where !owned.contains(file.url) { try? FileManager.default.removeItem(at: file.url) }
    }
    private func pruneQueueFiles() {
        let live = Set(composerQueue.allEntries.map(\.id))
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
        if composerQueue.remove(entry.id, conversationID: id) { pruneQueueFiles(); reconcileComposerQueues(snapshot?.conversations ?? []) }
    }
    func editQueuedMessage(_ entry: QueuedComposerMessage) {
        guard let id = activeConversationID, entry.state == .queued, !composerQueue.isSending(id) else { return }
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
        guard account != nil, let id = activeConversationID,
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
