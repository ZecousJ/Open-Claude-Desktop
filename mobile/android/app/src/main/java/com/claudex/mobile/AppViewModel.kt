package com.claudex.mobile

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.claudex.core.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File

class AppViewModel internal constructor(app: Application, apiFactory: AppNativeApiFactory): AndroidViewModel(app) {
    constructor(app: Application): this(app, AppNativeApiFactory { application ->
        NativeApi(BuildConfig.SERVER_ORIGIN, SessionVault(application, BuildConfig.SERVER_ORIGIN))
    })

    init { UserText.install(app) }
    private val prefs = app.getSharedPreferences("preferences", 0)
    val api = apiFactory.create(app)
    val repository: ClaudexRepository = if (BuildConfig.DEMO_MODE) DemoRepository(viewModelScope) else RemoteRepository(api, viewModelScope)
    val snapshot = repository.snapshot
    val connection = repository.connection
    val error = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)
    val conversationActions = MutableStateFlow<Set<String>>(emptySet())
    private val conversationActionLocks = ConversationActionLocks()
    /** The Code sessions whose pull request waits for a reviewer, for the Ready for review filter (SessionList.kt). */
    internal val sessionReview = SessionReview({ refs -> (repository as? RemoteRepository)?.pullVerdicts(refs) })
    /** Cowork's first-use page was dismissed (`cowork_starter_seen`, the official preference of the same name). */
    val coworkStarterSeen = MutableStateFlow(prefs.getBoolean("cowork_starter_seen", false))
    fun markCoworkStarterSeen() { prefs.edit().putBoolean("cowork_starter_seen", true).apply(); coworkStarterSeen.value = true }
    val draft = MutableStateFlow("")
    val attachments = MutableStateFlow<List<Attachment>>(emptyList())
    val selectedModel = MutableStateFlow<String?>(null)
    val selectedProvider = MutableStateFlow<String?>(null)
    val mode = MutableStateFlow(Mode.CHAT)
    val selectedRepository = MutableStateFlow<RepositoryChoice?>(null)
    val theme = MutableStateFlow(prefs.getString("theme", "system") ?: "system")
    val effort = MutableStateFlow("medium")
    val instructions = MutableStateFlow(prefs.getString("instructions", "") ?: "")
    val email = MutableStateFlow("")
    val authStage = MutableStateFlow("password")
    val signedIn = MutableStateFlow(BuildConfig.DEMO_MODE || api.session != null)
    val resendSeconds = MutableStateFlow(0)
    /** The account's online computers and the Code conversation opened on one (RemoteDevices.kt). */
    val devices = DeviceController(viewModelScope) { if (BuildConfig.DEMO_MODE || !signedIn.value) null else DeviceClient(api) }
    private var temporaryToken: String? = null
    private val localFiles = mutableMapOf<String, File>()
    internal val pendingSend = MutableStateFlow<PendingSend?>(null)
    internal val queuedComposer = QueuedComposer(api, repository, viewModelScope) { signedIn.value }
    private var sendJob: Job? = null
    private var operationGeneration = 0
    private var draftKey = DraftScopePolicy.key(null, null, Mode.CHAT)
    private val drafts = mutableMapOf<String, Pair<String, List<Attachment>>>()
    private var pickerJob: Job? = null
    private var sendingRpc = false
    fun switchDraft(conversationId: String?, projectId: String?, draftMode: Mode = Mode.CHAT) {
        val next = DraftScopePolicy.key(conversationId, projectId, draftMode)
        mode.value = if (conversationId == null) draftMode else snapshot.value.conversations.find { it.id == conversationId }?.mode ?: draftMode
        if (next == draftKey) return
        drafts[draftKey] = draft.value to attachments.value
        draftKey = next; operationGeneration++
        val restored = drafts[next]
        draft.value = restored?.first.orEmpty(); attachments.value = restored?.second.orEmpty()
    }
    fun resetNewDraft() {
        if (pendingSend.value != null && busy.value) cancelUpload()
        pendingSend.value = null
        val chatKey = DraftScopePolicy.key(null, null, Mode.CHAT)
        drafts.remove(chatKey)
        if (draftKey == chatKey) {
            draft.value = ""; attachments.value = emptyList(); operationGeneration++
        }
        mode.value = Mode.CHAT; selectedRepository.value = null
    }
    fun cancelVerification() { api.cancelAuthentication(); temporaryToken = null; authStage.value = "password" }
    init {
        if (!BuildConfig.DEMO_MODE) viewModelScope.launch { (repository as RemoteRepository).deviceEvents.collect { devices.receive(it) } }
        viewModelScope.launch { signedIn.collect { if (!it) devices.reset() } }
        if (!BuildConfig.DEMO_MODE) viewModelScope.launch { api.authenticated.collect { valid -> signedIn.value = valid; if (!valid) { (repository as RemoteRepository).clearLocalSession(); queuedComposer.clear(); conversationActionLocks.clear(); conversationActions.value = emptySet(); sendJob?.cancel(); pickerJob?.cancel(); temporaryToken = null; authStage.value = "password"; pendingSend.value = null; drafts.clear(); sessionReview.clear(); selectedModel.value = null; selectedProvider.value = null; attachments.value = emptyList(); draft.value = ""; localFiles.values.forEach { it.delete() }; localFiles.clear(); app.cacheDir.resolve("generated").listFiles()?.forEach { it.delete() } } } }
        if (!BuildConfig.DEMO_MODE) viewModelScope.launch { snapshot.collect { instructions.value = it.instructions; if (selectedModel.value == null) { val key = NativeDetailPolicy.modelKey(BuildConfig.SERVER_ORIGIN, api.session?.accountLabel.orEmpty()); NativeDetailPolicy.savedModel(key?.let { k -> prefs.getString(k, null) }, it.models)?.let { model -> selectedModel.value = model.id; selectedProvider.value = model.providerId } }; WireCodec.rawSettings?.optString(if (mode.value == Mode.CODE) "codeEffort" else "effort")?.takeIf { value -> value in ModelMenuPolicy.efforts }?.let { value -> effort.value = value } } }
        // Local attachment cache is bounded by age; never leaves app storage without user sending.
        app.cacheDir.resolve("attachments").listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 7 * 86_400_000L }?.forEach { it.delete() }
    }
    fun work(block: suspend () -> Unit) { viewModelScope.launch { try { block() } catch (c: CancellationException) { throw c } catch (e: Exception) { error.value = e.message ?: UserText.get(R.string.error_unknown) } } }
    fun model(): ModelOption? = snapshot.value.models.find { it.id == selectedModel.value && (selectedProvider.value == null || it.providerId == selectedProvider.value) } ?: snapshot.value.models.find { it.id == snapshot.value.selectedModel } ?: snapshot.value.models.firstOrNull()
    fun selectModel(model: ModelOption) {
        selectedModel.value = model.id
        selectedProvider.value = model.providerId
        NativeDetailPolicy.modelKey(BuildConfig.SERVER_ORIGIN, if (BuildConfig.DEMO_MODE) "demo" else api.session?.accountLabel.orEmpty())?.let { key -> prefs.edit().putString(key, org.json.JSONObject().put("model", model.id).put("provider", model.providerId).toString()).apply() }
        clampEffort(model)
    }
    private fun clampEffort(model: ModelOption) { if (effort.value !in model.efforts) effort.value = model.defaultEffort.takeIf { it in model.efforts } ?: model.efforts.firstOrNull() ?: "medium" }
    /** Code session menu "Change model": the session's own model from its next message on; the new-chat choice stays. */
    fun changeConversationModel(c: Conversation, model: ModelOption, done: () -> Unit = {}) {
        if (c.model == model.id && c.providerId == model.providerId) { done(); return }
        viewModelScope.launch {
            try { repository.setConversationModel(c.id, model.providerId, model.id); clampEffort(model); done() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { error.value = UserText.get(R.string.ccr_model_save_failed) }
        }
    }
    fun setTheme(value: String) { theme.value = value; prefs.edit().putString("theme", value).apply() }
    fun saveInstructions(value: String) = work {
        if (!BuildConfig.DEMO_MODE) { val settings = org.json.JSONObject(WireCodec.rawSettings?.toString() ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))); settings.put("instructions", value); (repository as RemoteRepository).rpc("saveSettings", settings); repository.refresh() }
        instructions.value = value; prefs.edit().putString("instructions", value).apply()
    }
    fun setEffort(value: String) = work {
        require(value in model()?.efforts.orEmpty()) { UserText.get(R.string.claudex_msg_effort_unavailable) }
        if (!BuildConfig.DEMO_MODE) { val settings = org.json.JSONObject(WireCodec.rawSettings?.toString() ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))); settings.put(if (mode.value == Mode.CODE) "codeEffort" else "effort", value); (repository as RemoteRepository).rpc("saveSettings", settings); repository.refresh() }
        effort.value = value
    }
    fun refresh() = work { repository.refresh() }
    fun pick(uri: Uri?) { if (uri != null) pickMany(listOf(uri)) }
    /** Photos and Files pick several at once (official multi-select); they are read one after another. */
    fun pickMany(uris: List<Uri>) {
        if (uris.isEmpty() || busy.value) return
        val expected = operationGeneration
        pickerJob = viewModelScope.launch {
            busy.value = true
            try { for (uri in uris) { if (expected != operationGeneration) break; importAttachment(uri, expected) } }
            finally { busy.value = false }
        }
    }
    private suspend fun importAttachment(uri: Uri, expected: Int) {
            try {
                val file = withContext(Dispatchers.IO) {
                    val resolver = getApplication<Application>().contentResolver
                    var name = UserText.get(R.string.claudex_attachment_default_name); var size = -1L
                    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) { val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME); val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE); if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn)?.takeIf { it.isNotBlank() } ?: name; if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn) } }
                    val mime = resolver.getType(uri) ?: "application/octet-stream"
                    name = PhotoAttachmentName.display(name, mime, uri.authority == "media" && uri.path?.let { it.startsWith("/picker/") || it.startsWith("/picker_get_content/") } == true, attachments.value.count { it.kind == "image" } + 1)
                    if (size > 0) AttachmentPolicy.validate(name, size, attachments.value.size)
                    if (attachments.value.size >= AttachmentPolicy.MAX_COUNT) throw AttachmentRejection(AttachmentRejection.Reason.COUNT)
                    val folder = getApplication<Application>().cacheDir.resolve("attachments").apply { mkdirs() }
                    val destination = File(folder, newId())
                    try {
                        resolver.openInputStream(uri)?.use { input -> destination.outputStream().use { output ->
                            val buffer = ByteArray(64 * 1024); var total = 0L
                            while (true) { ensureActive(); val read = input.read(buffer); if (read < 0) break; total += read; if (total > AttachmentPolicy.MAX_BYTES) throw AttachmentRejection(AttachmentRejection.Reason.SIZE); output.write(buffer, 0, read) }
                        } } ?: error(UserText.get(R.string.claudex_msg_file_unreadable))
                        AttachmentPolicy.validate(name, destination.length(), attachments.value.size)
                        val item = Attachment(newId(), name, destination.absolutePath, if (mime.startsWith("image/")) "image" else "document", destination.length(), mime)
                        item to destination
                    } catch (e: Exception) { destination.delete(); throw e }
                }
                if (expected == operationGeneration) { localFiles[file.first.id] = file.second; attachments.update { it + file.first } } else file.second.delete()
            } catch (e: CancellationException) { throw e } catch (e: Exception) { error.value = if (e is AttachmentRejection) AttachmentText.of(e.reason) else e.message ?: UserText.get(R.string.claudex_msg_file_unreadable) }
    }
    fun localFile(id: String): File? = localFiles[id]?.takeIf { it.exists() }
    fun findAttachment(id: String): Attachment? = attachments.value.find { it.id == id } ?: snapshot.value.conversations.flatMap { it.turns }.flatMap { it.attachments }.find { it.id == id }
    fun removeAttachment(id: String) { attachments.update { it.filterNot { a -> a.id == id } }; localFiles.remove(id)?.delete() }
    /** Resolve at tap time: the turn or draft can change since the last composed frame. */
    fun submitComposer(conversationId: String?, projectId: String?, pending: ((String) -> Unit)?, open: (String) -> Unit) {
        if (busy.value) { cancelUpload(); return }
        val current = snapshot.value.conversations.find { it.id == conversationId }
        if (conversationId != null && current == null) { error.value = UserText.get(R.string.claudex_msg_wait_loading); return }
        if (current?.turns?.any { it.status == TurnStatus.IN_PROGRESS } == true) {
            if (draft.value.isNotBlank() || attachments.value.isNotEmpty()) sendWhileRunning(current.id)
            else interrupt(current.id)
        } else send(conversationId, projectId, pending, open)
    }
    fun send(conversationId: String?, projectId: String? = null, pending: ((String) -> Unit)? = null, open: (String) -> Unit) {
        if (busy.value || sendJob?.isActive == true || conversationId in conversationActions.value || queuedComposer.submitting(conversationId)) return
        if (!signedIn.value) { error.value = UserText.get(R.string.error_account_session_invalid); return }
        val conversation = snapshot.value.conversations.find { it.id == conversationId }
        if (!BuildConfig.DEMO_MODE && conversationId == null && ((mode.value == Mode.CODE && !snapshot.value.cloudCode) || (mode.value == Mode.COWORK && !snapshot.value.cloudCowork))) { error.value = UserText.get(R.string.claudex_msg_mode_unavailable); return }
        val model = conversation?.let { c -> snapshot.value.models.find { it.id == c.model && it.providerId == c.providerId } ?: ModelOption(c.model, c.model, UserText.get(R.string.claudex_current_chat_model), c.providerId) } ?: model() ?: run { error.value = UserText.get(R.string.claudex_msg_no_model); return }
        val text = draft.value
        if (text.isBlank() && attachments.value.isEmpty()) return
        val local = attachments.value.toList(); val generation = operationGeneration
        val sendMode = conversation?.mode ?: mode.value
        busy.value = true
        // Official: the box empties as soon as Send is tapped ("Sending…" placeholder); the text comes back if it fails.
        val key = draftKey
        draft.value = ""
        fun restoreText() {
            if (generation != operationGeneration) return
            if (draftKey == key) { if (draft.value.isBlank()) draft.value = text }
            else drafts[key]?.let { (t, a) -> if (t.isBlank()) drafts[key] = text to a }
        }
        val pendingId = if (conversationId == null && pending != null) newId() else null
        if (pendingId != null) { pendingSend.value = PendingSend(pendingId, text, local.map { it.name }); pending?.invoke(pendingId) }
        sendJob = viewModelScope.launch {
            try {
                api.withCurrentSession {
                val uploaded = local.map { a ->
                    val bytes = withContext(Dispatchers.IO) { localFiles[a.id]?.readBytes() ?: error(UserText.get(R.string.claudex_msg_attachment_unavailable)) }
                    val remote = repository.attach(a.name, a.mime, bytes)
                    localFiles[a.id]?.let { localFiles[remote.id] = it }
                    remote
                }
                sendingRpc = true
                val id = repository.send(SendInput(conversationId, text, sendMode, model, uploaded, projectId, if (conversationId == null && mode.value == Mode.CODE) selectedRepository.value else null))
                if (generation == operationGeneration) { draft.value = ""; attachments.value = emptyList(); if (pendingId != null) pendingSend.update { it?.takeIf { item -> item.id == pendingId }?.copy(resultId = id) }; open(id) }
                }
            } catch (c: CancellationException) { restoreText(); throw c } catch (e: Exception) { restoreText(); val message = e.message ?: UserText.get(R.string.claudex_msg_send_unconfirmed); error.value = message; if (pendingId != null) pendingSend.update { it?.takeIf { item -> item.id == pendingId }?.copy(failure = message) } }
            finally { busy.value = false; sendingRpc = false }
        }
    }
    /** Sends an artifact comment to the artifact's chat (the official "Artifact comment sent to Claude"); a refusal says why in [error]. */
    fun sendArtifactComment(conversationId: String, text: String, sent: () -> Unit) {
        if (busy.value || sendJob?.isActive == true || conversationId in conversationActions.value || queuedComposer.submitting(conversationId)) { error.value = UserText.get(R.string.claudex_artifact_comment_busy); return }
        if (!signedIn.value) { error.value = UserText.get(R.string.error_account_session_invalid); return }
        val chat = snapshot.value.conversations.find { it.id == conversationId } ?: run { error.value = UserText.get(R.string.claudex_artifact_comment_unavailable); return }
        if (chat.slim) { error.value = UserText.get(R.string.claudex_msg_wait_loading); return }
        if (chat.turns.any { it.status == TurnStatus.IN_PROGRESS }) { error.value = UserText.get(R.string.claudex_artifact_comment_busy); return }
        val model = snapshot.value.models.find { it.id == chat.model && it.providerId == chat.providerId } ?: ModelOption(chat.model, chat.model, "当前对话模型", chat.providerId)
        val input = SendInput(chat.id, text, chat.mode, model, emptyList(), chat.projectId,
            webSearch = runCatching { org.json.JSONObject(chat.rawJson ?: "{}").optBoolean("webSearch") }.getOrDefault(false))
        busy.value = true
        sendJob = viewModelScope.launch {
            try { api.withCurrentSession { sendingRpc = true; repository.send(input) }; sent() }
            catch (cancelled: CancellationException) { throw cancelled } catch (e: Exception) { error.value = e.message ?: UserText.get(R.string.claudex_msg_send_unconfirmed) }
            finally { busy.value = false; sendingRpc = false }
        }
    }
    fun sendWhileRunning(id: String) {
        if (busy.value || !signedIn.value || queuedComposer.submitting(id) || id in conversationActions.value) return
        val c = snapshot.value.conversations.find { it.id == id } ?: return
        if (c.slim) { error.value = UserText.get(R.string.claudex_msg_wait_loading); return }
        if (c.turns.none { it.status == TurnStatus.IN_PROGRESS }) { send(c.id, c.projectId) { }; return }
        val text = draft.value
        val files = attachments.value.toList()
        if (text.isBlank() && files.isEmpty()) return
        val key = DraftScopePolicy.key(c.id, c.projectId, c.mode)
        if (key != draftKey) return
        val generation = api.sessionGeneration
        fun restore() {
            if (!signedIn.value || api.sessionGeneration != generation) return
            val current = if (draftKey == key) draft.value to attachments.value else drafts[key] ?: ("" to emptyList())
            val restored = restoreQueuedDraft(QueuedDraft(text, files), QueuedDraft(current.first, current.second))
            if (draftKey == key) { draft.value = restored.text; attachments.value = restored.attachments }
            else drafts[key] = restored.text to restored.attachments
        }
        draft.value = ""; attachments.value = emptyList()
        val input = SendInput(c.id, text, c.mode, ModelOption(c.model, c.model, "", c.providerId), files, c.projectId,
            webSearch = runCatching { org.json.JSONObject(c.rawJson ?: "{}").optBoolean("webSearch") }.getOrDefault(false))
        val accepted = queuedComposer.submit(input, upload = {
            files.map { a ->
                val file = localFiles[a.id]
                if (file == null) a else {
                    val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                    val remote = repository.attach(a.name, a.mime, bytes)
                    localFiles[remote.id] = file
                    remote
                }
            }
        }, failed = { message -> restore(); error.value = message })
        if (!accepted) { restore(); error.value = UserText.get(R.string.claudex_msg_queue_full) }
    }
    fun editQueuedMessage(conversationId: String, id: String) {
        val c = snapshot.value.conversations.find { it.id == conversationId } ?: return
        if (draftKey != DraftScopePolicy.key(c.id, c.projectId, c.mode)) return
        val entry = queuedComposer.remove(conversationId, id) ?: return
        draft.value = if (draft.value.isBlank()) entry.input.text else "${entry.input.text}\n${draft.value}"
        attachments.value = (entry.input.attachments + attachments.value).distinctBy { it.id }
    }
    fun interrupt(id: String) = work { repository.interrupt(id) }
    fun cancelUpload() { pendingSend.update { it?.copy(failure = UserText.get(R.string.claudex_msg_wait_stopped_unconfirmed)) }; val uncertain = sendingRpc; sendJob?.cancel(); pickerJob?.cancel(); busy.value = false; error.value = if (uncertain) UserText.get(R.string.claudex_msg_wait_stopped_unconfirmed) else UserText.get(R.string.claudex_msg_wait_stopped) }
    fun conversationAction(id: String, block: suspend () -> Unit) {
        if (id in conversationActions.value || busy.value || queuedComposer.submitting(id)) return
        val owner = conversationActionLocks.start(id) ?: return
        conversationActions.value = conversationActionLocks.ids
        work { try { block() } finally { conversationActionLocks.finish(id, owner); conversationActions.value = conversationActionLocks.ids } }
    }
    fun retryResponse(c: Conversation, turn: Turn) = conversationAction(c.id) { repository.retryResponse(c.id, turn.id, c.providerId, c.model) }
    internal fun continueFailedResponse(c: Conversation, turnId: String) = conversationAction(c.id) {
        api.withCurrentSession {
            val current = snapshot.value.conversations.find { it.id == c.id } ?: error(UserText.get(R.string.claudex_msg_chat_gone))
            val notice = ReplyFailurePresentation.notice(current, false)
            require(notice?.turnId == turnId && notice.continuable) { UserText.get(R.string.claudex_msg_reply_changed) }
            repository.send(SendInput(current.id, "Continue", current.mode, ModelOption(current.model, current.model, "", current.providerId), emptyList(), current.projectId))
        }
    }

    fun editPrompt(c: Conversation, turn: Turn, text: String, done: () -> Unit) = conversationAction(c.id) { repository.editPrompt(c.id, turn.id, text, c.providerId, c.model); done() }
    fun selectVersion(c: Conversation, turn: Turn, version: TurnVersion, prompt: Boolean) = conversationAction(c.id) { repository.selectVersion(c.id, turn.id, version.turnId, prompt) }
    fun rate(c: Conversation, turn: Turn, rating: String) = conversationAction(c.id) { repository.setReplyFeedback(c.id, turn.id, rating.takeUnless { snapshot.value.replyFeedback[feedbackKey(c.id, turn.id)] == rating }) }
    fun deleteConversation(c: Conversation, done: () -> Unit) = conversationAction(c.id) {
        repository.deleteConversation(c.id)
        drafts.remove(c.id)
        if (draftKey == c.id) { draft.value = ""; attachments.value = emptyList(); operationGeneration++ }
        done()
    }
    fun findGeneratedFile(conversationId: String, id: String): GeneratedFile? = snapshot.value.conversations.find { it.id == conversationId }?.turns?.flatMap { it.items }?.flatMap { it.generatedFiles }?.find { it.id == id }
        ?: snapshot.value.artifacts.find { it.originConversationId == conversationId && it.generatedFile?.id == id }?.generatedFile
    private var conversationLease: ConversationLease? = null
    private val conversationDownloadLock = Mutex()
    internal fun beginConversationBridge(id: String): ConversationLease = ConversationLease(newId(), id, api.sessionGeneration).also { conversationLease = it }
    internal fun endConversationBridge(lease: ConversationLease) { if (conversationLease == lease) conversationLease = null }
    internal fun acceptsConversationBridge(lease: ConversationLease): Boolean = conversationLease == lease && signedIn.value && api.sessionGeneration == lease.generation
    internal suspend fun dispatchConversationDocumentAction(lease: ConversationLease, document: ConversationDocument, action: ConversationAction, host: ConversationNativeActions): Any? {
        fun current(): Conversation {
            require(acceptsConversationBridge(lease) && action.sessionId == lease.id) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
            val sourceConversation = snapshot.value.conversations.find { it.id == lease.conversationId }
            if (document.source != null) require(findGeneratedFile(lease.conversationId, document.source.id) == document.source) { UserText.get(R.string.claudex_msg_file_changed) }
            else {
                val artifact = document.artifact ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
                val currentArtifact = sourceConversation?.let { ConversationBridgePolicy.fenceArtifact(it, artifact.id) }
                    ?: snapshot.value.artifacts.find { it.id == artifact.id && it.originConversationId == artifact.originConversationId }
                require(currentArtifact == artifact) { UserText.get(R.string.claudex_msg_file_changed) }
            }
            return Conversation("document", "", providerId = "", model = "", turns = listOf(Turn("document", "", items = listOf(Item("document", "agentMessage", document.content)))))
        }
        val c = current(); val payload = action.payload
        return api.withCurrentSession {
            when (action.type) {
                ConversationActionType.COPY -> { val text = ConversationBridgePolicy.text(payload); require(document.content.replace("\r\n", "\n").contains(text.replace("\r\n", "\n").trim())) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }; host.copy(text); null }
                ConversationActionType.LINK -> { val url = ConversationBridgePolicy.requireCurrentLink(c, payload.getString("url")); host.confirmOrDecline(UserText.get(R.string.external_link_dialog_title), url); ConversationBridgePolicy.requireCurrentLink(current(), url); host.openLink(url); null }
                ConversationActionType.LOAD_IMAGE -> { val url = ConversationBridgePolicy.requireRemoteImageUrl(c, payload.getString("url")); val repo = repository as? RemoteRepository ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again)); val data = repo.rpc("loadRemoteImage", url) as? String ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again)); require(data.length <= 14 * 1024 * 1024 && Regex("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$").matches(data)); current(); data }
                else -> error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
            }
        }
    }
    /** Called only after exact-origin/main-frame checks. Resolve IDs again after every suspension/confirmation. */
    internal suspend fun dispatchConversationAction(lease: ConversationLease, action: ConversationAction, host: ConversationNativeActions): Any? {
        fun current(): Conversation {
            require(acceptsConversationBridge(lease) && action.sessionId == lease.id) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
            val p = action.payload
            if (action.type !in setOf(ConversationActionType.COPY, ConversationActionType.LINK, ConversationActionType.LOAD_IMAGE)) require(ConversationBridgePolicy.id(p, "conversationId") == lease.conversationId) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
            return snapshot.value.conversations.find { it.id == lease.conversationId } ?: error(UserText.get(R.string.claudex_msg_chat_gone))
        }
        val payload = action.payload
        var c = current()
        val mutation = action.type in setOf(ConversationActionType.EDIT, ConversationActionType.RETRY, ConversationActionType.VERSION, ConversationActionType.FEEDBACK, ConversationActionType.CONTINUE)
        var operationToken: String? = null
        if (mutation) {
            ConversationBridgePolicy.requireIdle(c, busy.value || c.id in conversationActions.value || queuedComposer.submitting(c.id))
            require(action.type in setOf(ConversationActionType.FEEDBACK, ConversationActionType.CONTINUE) || c.mode == Mode.CHAT) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
            if (action.type == ConversationActionType.RETRY) ConversationBridgePolicy.requireEditable(c, ConversationBridgePolicy.turn(c, payload), false)
            operationToken = conversationActionLocks.start(c.id) ?: error(UserText.get(R.string.claudex_msg_wait_reply))
            conversationActions.value = conversationActionLocks.ids
        }
        try {
            return api.withCurrentSession {
                c = current()
                when (action.type) {
                    ConversationActionType.COPY -> { val text = ConversationBridgePolicy.text(payload); ConversationBridgePolicy.requireCurrentText(c, text); host.copy(text); null }
                    ConversationActionType.LINK -> { val url = ConversationBridgePolicy.requireCurrentLink(c, payload.getString("url")); host.confirmOrDecline(UserText.get(R.string.external_link_dialog_title), url); ConversationBridgePolicy.requireCurrentLink(current(), url); host.openLink(url); null }
                    ConversationActionType.LOAD_IMAGE -> {
                        val url = ConversationBridgePolicy.requireRemoteImageUrl(c, payload.getString("url"))
                        val repo = repository as? RemoteRepository ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
                        val data = repo.rpc("loadRemoteImage", url) as? String ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
                        require(data.length <= 14 * 1024 * 1024 && Regex("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$").matches(data)) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
                        ConversationBridgePolicy.requireCurrentLink(current(), url)
                        data
                    }
                    ConversationActionType.QUOTE -> { val text = ConversationBridgePolicy.text(payload); ConversationBridgePolicy.requireQuotedText(c, text); require(!busy.value); switchDraft(c.id, c.projectId); draft.value += (if (draft.value.isBlank()) "" else "\n\n") + text.lines().joinToString("\n") { "> $it" } + "\n\n"; null }
                    ConversationActionType.EDIT -> { val t = ConversationBridgePolicy.turn(c, payload); ConversationBridgePolicy.requireEditable(c, t, false); repository.editPrompt(c.id, t.id, ConversationBridgePolicy.text(payload), c.providerId, c.model); null }
                    ConversationActionType.RETRY -> { val t = ConversationBridgePolicy.turn(c, payload); ConversationBridgePolicy.requireEditable(c, t, false); repository.retryResponse(c.id, t.id, c.providerId, c.model); null }
                    ConversationActionType.VERSION -> { val t = ConversationBridgePolicy.turn(c, payload); ConversationBridgePolicy.requireEditable(c, t, false); val prompt = payload.getBoolean("prompt"); val versionId = ConversationBridgePolicy.id(payload, "versionId"); val version = TurnVersions.versions(c, t, prompt).find { it.turnId == versionId } ?: error(UserText.get(R.string.claudex_msg_version_unavailable)); repository.selectVersion(c.id, t.id, version.turnId, prompt); null }
                    ConversationActionType.FEEDBACK -> { val t = ConversationBridgePolicy.turn(c, payload); ConversationBridgePolicy.requireIdle(c, false); require(c.mode != Mode.CODE && !t.compaction && t.status == TurnStatus.COMPLETED); require(payload.has("rating")); val rating = if (payload.isNull("rating")) null else payload.getString("rating"); require(rating == null || rating in setOf("up", "down")); repository.setReplyFeedback(c.id, t.id, rating); null }
                    ConversationActionType.CONTINUE -> { ConversationBridgePolicy.requireContinuable(c, false); repository.send(SendInput(c.id, "Continue", c.mode, ModelOption(c.model, c.model, UserText.get(R.string.claudex_current_chat_model), c.providerId), emptyList(), c.projectId)); null }
                    ConversationActionType.ATTACHMENT -> { val id = ConversationBridgePolicy.id(payload, "attachmentId"); require(c.turns.any { t -> t.attachments.any { it.id == id } }) { UserText.get(R.string.claudex_msg_attachment_unavailable) }; host.navigate("attachment/${Uri.encode(id)}"); null }
                    ConversationActionType.DOWNLOAD, ConversationActionType.DOWNLOADS -> conversationDownloadLock.withLock {
                        suspend fun save(identity: org.json.JSONObject): String? {
                            val owner = current()
                            require(ConversationBridgePolicy.id(identity, "conversationId") == owner.id) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
                            val file = ConversationBridgePolicy.generatedFile(owner, identity)
                            return if (file != null) {
                                GeneratedFilePolicy.validate(file)
                                val bytes = repository.readGeneratedFile(file)
                                require(ConversationBridgePolicy.generatedFile(current(), identity) == file) { UserText.get(R.string.claudex_msg_file_changed) }
                                host.download(GeneratedFilePolicy.exportName(file.name), fileMime(file), bytes)
                            } else {
                                val artifactId = ConversationBridgePolicy.id(identity, "artifactId")
                                val artifact = ConversationBridgePolicy.fenceArtifact(owner, artifactId) ?: snapshot.value.artifacts.find { it.id == artifactId && it.originConversationId == owner.id } ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
                                val bytes = artifact.content.toByteArray(Charsets.UTF_8)
                                require(bytes.size <= GeneratedFilePolicy.MAX_BYTES) { UserText.get(R.string.claudex_msg_file_too_large) }
                                host.download(GeneratedFilePolicy.exportName(artifact.name), "text/plain", bytes)
                            }
                        }
                        if (action.type == ConversationActionType.DOWNLOAD) save(payload)
                        else {
                            val identities = ConversationBridgePolicy.downloadIdentities(current(), payload)
                            var saved = 0; var cancelled = false
                            for (identity in identities) {
                                currentCoroutineContext().ensureActive()
                                try {
                                    if (save(identity) == null) { cancelled = true; break }
                                    saved++
                                } catch (cancelled: CancellationException) { throw cancelled }
                                catch (error: Exception) { throw IllegalStateException(UserText.get(R.string.claudex_msg_saved_partial, saved, error.message ?: UserText.get(R.string.claudex_msg_try_again)), error) }
                            }
                            org.json.JSONObject().put("saved", saved).put("cancelled", cancelled)
                        }
                    }
                    ConversationActionType.ARTIFACT -> {
                        val file = ConversationBridgePolicy.generatedFile(c, payload)
                        if (file != null) { GeneratedFilePolicy.validate(file); host.navigate("generated/${Uri.encode(c.id)}/${Uri.encode(file.id)}") }
                        else { val artifactId = ConversationBridgePolicy.id(payload, "artifactId"); val artifact = ConversationBridgePolicy.fenceArtifact(c, artifactId) ?: snapshot.value.artifacts.find { it.id == artifactId && it.originConversationId == c.id } ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again)); host.navigate("conversationArtifact/${Uri.encode(c.id)}/${Uri.encode(artifact.id)}") }
                        null
                    }
                    ConversationActionType.CHANGES -> { require(c.turns.any { t -> t.items.any { it.changes.isNotEmpty() } }); host.navigate("diff/${Uri.encode(c.id)}"); null }
                    ConversationActionType.WORKFLOW, ConversationActionType.PLAN -> { require(c.mode != Mode.CHAT) { UserText.get(R.string.claudex_msg_no_task_details) }; host.navigate("task/${Uri.encode(c.id)}"); null }
                    ConversationActionType.AGENT -> error(UserText.get(R.string.claudex_msg_agent_unsupported))
                }
            }.also { if (!acceptsConversationBridge(lease)) throw CancellationException("对话视图已更改") }
        } finally { operationToken?.let { conversationActionLocks.finish(lease.conversationId, it); conversationActions.value = conversationActionLocks.ids } }
    }
    fun markConversationRead(c: Conversation) = work { if (c.unread) repository.updateConversation(c.id, unread = false) }
    fun updateConversation(c: Conversation, title: String? = null, pinned: Boolean? = null, archived: Boolean? = null) = work { repository.updateConversation(c.id, title, pinned, archived) }
    /** Chat menu "Add to project / Change project / Remove from project"; [done] runs once the service confirmed it. */
    fun moveConversation(c: Conversation, projectId: String?, done: () -> Unit) = work { repository.moveConversation(c.id, projectId); done() }
    fun deleteProject(p: Project, done: () -> Unit) = conversationAction("project:${p.id}") {
        repository.deleteProject(p.id)
        drafts.remove("new:${p.id}")
        if (draftKey == "new:${p.id}") { draft.value = ""; attachments.value = emptyList(); operationGeneration++ }
        done()
    }
    fun saveProject(p: Project) = work { repository.saveProject(p) }
    fun login(password: String, onSuccess: () -> Unit) = work {
        busy.value = true
        try {
            val data = api.login(email.value.trim(), password)
            if (data.optBoolean("requires_2fa")) { temporaryToken = data.getString("temp_token"); authStage.value = "twoFactor" }
            else completeLogin(onSuccess)
        } finally { busy.value = false }
    }
    fun verify(code: String, password: String, onSuccess: () -> Unit) = work {
        busy.value = true
        try {
            if (authStage.value == "twoFactor") api.twoFactor(temporaryToken ?: error(UserText.get(R.string.error_account_session_invalid)), code, email.value)
            else api.register(email.value.trim(), password, code)
            temporaryToken = null; completeLogin(onSuccess)
        } finally { busy.value = false }
    }
    fun sendCode() = work {
        busy.value = true
        try {
            resendSeconds.value = api.sendVerification(email.value.trim())
            authStage.value = "register"
            viewModelScope.launch { while (resendSeconds.value > 0) { delay(1000); resendSeconds.value-- } }
        } finally { busy.value = false }
    }
    private suspend fun completeLogin(onSuccess: () -> Unit) { signedIn.value = true; authStage.value = "password"; onSuccess(); (repository as? RemoteRepository)?.start() }
    fun logout(onDone: () -> Unit) = work {
        operationGeneration++; queuedComposer.clear(); sendJob?.cancelAndJoin(); temporaryToken = null; authStage.value = "password"
        try { repository.signOut() } finally { pendingSend.value = null; api.clear(); signedIn.value = false; attachments.value = emptyList(); draft.value = ""; localFiles.values.forEach { it.delete() }; localFiles.clear(); onDone() }
    }
    fun demoReconnect() = work { (repository as? DemoRepository)?.simulateDisconnect() }
    fun demoFailNext() { (repository as? DemoRepository)?.failNextSend = true; error.value = "下一条发送将模拟失败，草稿会保留" }
    fun onBackground() { (repository as? RemoteRepository)?.stopEvents() }
    fun onForeground() { if (signedIn.value) work { (repository as? RemoteRepository)?.resumeEvents() } }
}
