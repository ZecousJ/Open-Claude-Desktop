package com.claudex.mobile

import java.util.Base64
import com.claudex.core.*
import com.claudex.core.Connection
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

class RemoteRepository(val api: NativeApi, private val scope: CoroutineScope): ClaudexRepository {
    /** device-event and devices-changed from the account's stream (RemoteDevices.kt). */
    val deviceEvents = kotlinx.coroutines.flow.MutableSharedFlow<DeviceStreamEvent>(extraBufferCapacity = 64)
    private val state = MutableStateFlow(Snapshot())
    private val featureRevision = MutableStateFlow(0L)
    val featureUpdates = featureRevision.asStateFlow()
    override val snapshot = state.asStateFlow()
    private val link = MutableStateFlow<Connection>(Connection.Offline)
    override val connection = link.asStateFlow()
    private val epoch = SessionEpoch()
    // All conversation writes and hydration acceptance checks share this lock. Network I/O
    // is always outside it; local revisions are necessary because hydration has no revision.
    private val contentLock = Any()
    private var hiddenArtifacts = emptySet<String>()
    private val deletedConversations = mutableSetOf<String>()
    private var snapshotRevision = 0L
    private var nextViewLease = 0L
    private var viewed: ViewedConversation? = null
    private val conversationRevisions = mutableMapOf<String, Long>()
    private val attemptedVersions = mutableMapOf<String, ContentVersion>()
    private val queuedContentVersions = mutableMapOf<String, ContentVersion>()
    private val contentRequests = mutableMapOf<String, ContentRequest>()
    private val contentState = MutableStateFlow<Map<String, ContentLoadState>>(emptyMap())
    val contentLoads = contentState.asStateFlow()
    private data class ViewedConversation(val id: String, val lease: Long)
    private data class ContentVersion(val epoch: Long, val snapshot: Long, val conversation: Long)
    private class ContentRequest(val id: String, val version: ContentVersion, var viewLease: Long) {
        lateinit var job: Job
    }
    private val cursor = EventCursor()
    private val resyncBudget = EventResyncBudget()
    private var resyncJob: Job? = null
    private val refreshMutex = Mutex()
    private val eventMutex = Mutex()
    private val lifecycleMutex = Mutex()
    private var socket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var heartbeat: Job? = null
    private var enabled = false
    @Volatile private var socketGeneration = 0L
    private var attempt = 0
    private var catalog: JSONObject? = null
    // Written from the HTTP response callback, read while processing frames.
    @Volatile private var snapshotEventSequence: Long? = null
    suspend fun start() = lifecycleMutex.withLock { resetContentSession(); socketGeneration++; socket?.cancel(); heartbeat?.cancel(); reconnectJob?.cancel(); WireCodec.clear(); cursor.reset(null); enabled = true; refreshThenConnect() }
    suspend fun rpc(method: String, vararg args: Any?): Any? {
        require(method.matches(Regex("[a-zA-Z][a-zA-Z0-9]{0,63}")))
        val result = api.request("/api/v1/claudex/web/rpc/$method", JSONObject().put("args", JSONArray(args.toList())), true, responseSequence = if (method == "snapshot") ({ sequence -> snapshotEventSequence = sequence }) else null)
        if (!result.optBoolean("ok")) {
            val error = result.optJSONObject("error") ?: JSONObject()
            val code = error.optString("code", "RPC_ERROR")
            throw ApiException(code, CapacityErrorPresentation.message(code, error.optString("message", UserText.get(R.string.error_unknown)), error.optJSONObject("metadata")?.optString("scope")))
        }
        return result.opt("value")
    }
    internal suspend fun searchStoredHistory(query: String, archived: Boolean): List<StoredHistoryHit> {
        val expected = api.sessionGeneration
        require(query.codePointCount(0, query.length) <= 200) { UserText.get(R.string.claudex_msg_search_too_long) }
        val value = rpc("searchConversations", query, JSONObject().put("includeArchived", archived).put("limit", 50)) as? JSONObject ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
        check(api.sessionGeneration == expected) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        val results = value.optJSONArray("results") ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
        return (0 until minOf(results.length(), 50)).mapNotNull { index ->
            val hit = results.optJSONObject(index) ?: return@mapNotNull null
            val id = hit.optString("conversationId"); if (!id.matches(Regex("[A-Za-z0-9_.:-]{1,64}")) || hit.optBoolean("archived") != archived) null
            else StoredHistoryHit(id, hit.optString("title"), hit.optString("snippet").take(800), archived)
        }.distinctBy { it.id }
    }
    override suspend fun refresh() = eventMutex.withLock { refreshSnapshot() }
    private suspend fun refreshSnapshot(requestEpoch: Long? = null) = refreshMutex.withLock {
        val expected = synchronized(contentLock) { epoch.value }
        if (requestEpoch != null && requestEpoch != expected) return@withLock
        val raw = rpc("snapshot") as? JSONObject ?: throw ApiException("BAD_SNAPSHOT", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        // The account's name is read once per session; failing to read it only leaves the fallback label.
        val accountName = state.value.accountName.ifBlank {
            try { SidebarPolicy.accountName(api.request("/api/v1/auth/me", authorized = true, method = "GET").optJSONObject("data"), api.session?.accountLabel.orEmpty()) }
            catch (e: Exception) { if (e is CancellationException) throw e; "" }
        }
        // Model catalog may be unavailable; assigned provider models remain usable.
        catalog = try { rpc("modelCatalog") as? JSONObject } catch (_: ApiException) { null }
        if (epoch.accepts(expected)) hiddenArtifacts = raw.optJSONArray("artifactShares")?.objects()?.filter { !it.optBoolean("showInList", true) }?.map { it.optString("identity") }?.toSet().orEmpty()
        if (epoch.accepts(expected)) {
            installSnapshot(WireCodec.snapshot(raw, catalog).copy(accountName = accountName), expected)
            cursor.reset(SnapshotEventSequence.covered(cursor.lastSequence, snapshotEventSequence)); resyncBudget.succeeded()
        }
    }
    override suspend fun send(input: SendInput): String {
        val expected = epoch.value
        val payload = JSONObject().put("text", input.text).put("mode", input.mode.wire).put("providerId", input.model.providerId).put("model", input.model.id).put("attachments", JSONArray(input.attachments.map(WireCodec::attachment)))
        ComposerFeaturePolicy.newSendPayload(payload, input.conversationId, ComposerFeatures(input.webSearch, input.research))
        input.repository?.let { payload.put("repository", JSONObject().put("url", it.cloneUrl).put("ref", it.branch)) };
        input.conversationId?.let { payload.put("conversationId", it) }; input.projectId?.let { payload.put("projectId", it) }
        val result = rpc("send", payload) as? JSONObject ?: throw ApiException("SEND_UNKNOWN", UserText.get(R.string.claudex_msg_send_unconfirmed))
        val c = WireCodec.conversation(result)
        replace(c, expected)
        return c.id
    }
    override suspend fun steerTurn(conversationId: String, text: String, attachments: List<Attachment>): SteerResult? {
        val expected = epoch.value
        val before = synchronized(contentLock) { state.value.conversations.find { it.id == conversationId } }
        val result = rpc("steerTurn", conversationId, text, JSONArray(attachments.map { it.id }))
        if (result == null || result == JSONObject.NULL) return null
        val response = result as? JSONObject ?: throw ApiException("STEER_UNKNOWN", UserText.get(R.string.claudex_msg_steer_unconfirmed))
        val messageId = response.getString("messageId").also { require(it.isNotBlank()) }
        val returned = WireCodec.conversation(response.getJSONObject("conversation"))
        require(returned.id == conversationId)
        synchronized(contentLock) {
            val current = state.value.conversations.find { it.id == conversationId }
            val merged = WireCodec.preserveObservedMetadata(before, current, returned, ConversationMutationReconciler.merge(before, current, returned))
            replace(merged, expected)
        }
        return SteerResult(messageId, returned)
    }
    override suspend fun interrupt(conversationId: String) { rpc("interrupt", conversationId); refresh() }
    override suspend fun attach(name: String, mime: String, bytes: ByteArray): Attachment = api.withCurrentSession {
        AttachmentPolicy.validate(name, bytes.size.toLong(), 0)
        val data = uploadReference(name, mime, bytes)
        WireCodec.attachment(rpc("addAttachmentData", name, data) as JSONObject).copy(mime = mime)
    }
    suspend fun uploadReference(name: String, mime: String, bytes: ByteArray): JSONObject = api.withCurrentSession {
        AttachmentPolicy.validate(name, bytes.size.toLong(), 0)
        if (bytes.size <= AttachmentPolicy.INLINE_BYTES) JSONObject().put("\$bytes", Base64.getEncoder().encodeToString(bytes)) else {
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val created = api.request("/api/v1/claudex/web/uploads", JSONObject().put("name", name).put("size", bytes.size).put("type", mime).put("sha256", digest), true)
            if (!created.optBoolean("ok")) throw ApiException("UPLOAD_FAILED", created.optJSONObject("error")?.optString("message") ?: UserText.get(R.string.chat_input_upload_failed))
            val id = created.getJSONObject("value").getString("id")
            require(id.matches(Regex("[A-Za-z0-9_-]+")))
            for (index in 0 until AttachmentPolicy.chunks(bytes.size.toLong())) {
                currentCoroutineContext().ensureActive()
                val start = index * AttachmentPolicy.CHUNK_BYTES
                val response = api.request("/api/v1/claudex/web/uploads/$id/chunks/$index", authorized = true, method = "PUT", raw = bytes.copyOfRange(start, minOf(bytes.size, start + AttachmentPolicy.CHUNK_BYTES)))
                if (response.has("ok") && !response.optBoolean("ok")) throw ApiException("UPLOAD_FAILED", UserText.get(R.string.chat_input_upload_failed))
            }
            val completed = api.request("/api/v1/claudex/web/uploads/$id/complete", JSONObject(), true)
            if (!completed.optBoolean("ok")) throw ApiException("UPLOAD_FAILED", UserText.get(R.string.chat_input_upload_failed))
            JSONObject().put("\$upload", id)
        }
    }
    override suspend fun updateConversation(id: String, title: String?, pinned: Boolean?, archived: Boolean?, unread: Boolean?) {
        val patch = JSONObject(); title?.let { patch.put("title", it) }; pinned?.let { patch.put("pinned", it) }; archived?.let { patch.put("archived", it) }; unread?.let { patch.put("unread", it) }
        val expected = epoch.value
        val result = WireCodec.conversation(rpc("updateConversation", id, patch) as JSONObject)
        replace(result, expected)
    }
    override suspend fun setConversationModel(id: String, providerId: String, model: String) {
        val expected = epoch.value
        val result = WireCodec.conversation(rpc("updateConversation", id, JSONObject().put("providerId", providerId).put("model", model)) as JSONObject)
        replace(result, expected)
    }
    override suspend fun moveConversation(id: String, projectId: String?) {
        val expected = epoch.value
        val result = WireCodec.conversation(rpc("updateConversation", id, JSONObject().put("projectId", projectId ?: JSONObject.NULL)) as JSONObject)
        replace(result, expected)
    }
    /** Which pull requests wait for a reviewer (SessionList.kt); null when GitHub is not connected or the service cannot say. */
    internal suspend fun pullVerdicts(refs: List<PullRef>): List<PullVerdict>? =
        try { SessionReviewPolicy.verdicts(api.request(SessionReviewPolicy.PATH, SessionReviewPolicy.request(refs), true)) } catch (c: CancellationException) { throw c } catch (_: Exception) { null }
    override suspend fun retryResponse(id: String, turnId: String, providerId: String, model: String) { mutateConversation("retryResponse", id, turnId, providerId, model) }
    override suspend fun editPrompt(id: String, turnId: String, text: String, providerId: String, model: String) { require(text.isNotBlank()); mutateConversation("editPrompt", id, turnId, text, providerId, model) }
    override suspend fun selectVersion(id: String, turnId: String, versionTurnId: String, prompt: Boolean) { mutateConversation(if (prompt) "selectPromptVersion" else "selectReplyVersion", id, turnId, versionTurnId) }
    private suspend fun mutateConversation(method: String, vararg args: Any?) {
        val expected = epoch.value
        val id = args.firstOrNull() as? String
        val before = synchronized(contentLock) { state.value.conversations.find { it.id == id } }
        val result = rpc(method, *args) as? JSONObject ?: throw ApiException("MUTATION_UNKNOWN", UserText.get(R.string.claudex_msg_action_unconfirmed))
        synchronized(contentLock) {
            val returned = WireCodec.conversation(result)
            val current = state.value.conversations.find { it.id == returned.id }
            // A turn event can outrun the RPC's initial response. Keep its newer text.
            val merged = WireCodec.preserveObservedMetadata(before, current, returned, ConversationMutationReconciler.merge(before, current, returned))
            replace(merged, expected)
        }
    }
    override suspend fun setReplyFeedback(id: String, turnId: String, rating: String?) {
        require(rating == null || rating in listOf("up", "down"))
        val expected = epoch.value
        val value = rpc("setReplyFeedback", id, turnId, rating) as? JSONObject ?: throw ApiException("BAD_FEEDBACK", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        val key = feedbackKey(id, turnId)
        val confirmed = WireCodec.feedback(value)[key]
        synchronized(contentLock) { if (epoch.accepts(expected) && id !in deletedConversations) state.update { it.copy(replyFeedback = if (confirmed == null) it.replyFeedback - key else it.replyFeedback + (key to confirmed)) } }
    }
    override suspend fun deleteConversation(id: String) {
        val expected = epoch.value
        rpc("deleteConversation", id)
        synchronized(contentLock) {
            if (!epoch.accepts(expected)) return
            deletedConversations += id
            contentRequests.remove(id)?.job?.cancel(); attemptedVersions.remove(id); queuedContentVersions.remove(id)
            if (viewed?.id == id) viewed = null
            conversationRevisions[id] = (conversationRevisions[id] ?: 0L) + 1
            contentState.update { it - id }
            state.update { it.copy(conversations = it.conversations.filterNot { c -> c.id == id }, artifacts = it.artifacts.filterNot { a -> a.generatedFile != null && a.originConversationId == id }, replyFeedback = it.replyFeedback.filterKeys { key -> runCatching { JSONArray(key).optString(0) != id }.getOrDefault(true) }) }
        }
    }
    /** Batch current transcript descriptors once; no renderer-supplied filesystem paths. */
    internal suspend fun captureToolImages(conversationId: String, requests: List<ImageToolRequest>) {
        val expected = epoch.value
        fun observed(request: ImageToolRequest): Boolean = state.value.conversations.find { it.id == conversationId }?.turns?.flatMap { it.items }?.any { ImageToolSnapshotPolicy.matches(it, request) } == true
        val files = mutableListOf<Pair<ImageToolRequest, GeneratedFile>>()
        for (request in requests.distinct().takeLast(12)) {
            if (!epoch.accepts(expected) || !observed(request)) continue
            try {
                val raw = (if (request.viewed) rpc("viewedImageSnapshot", conversationId, request.path) else rpc("imageGenerationSnapshot", request.path)) as? JSONObject ?: continue
                val file = ImageToolSnapshotPolicy.descriptor(request, raw) ?: continue
                files += request to file
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Missing/unsupported files remain unavailable. */ }
        }
        synchronized(contentLock) {
            if (!epoch.accepts(expected) || conversationId in deletedConversations || files.isEmpty()) return
            state.update { snapshot -> withGeneratedFiles(snapshot.copy(conversations = snapshot.conversations.map { c ->
                if (c.id != conversationId) c else c.copy(turns = c.turns.map { t -> t.copy(items = t.items.map { item ->
                    val captured = files.find { ImageToolSnapshotPolicy.matches(item, it.first) }
                    if (captured == null) item else item.copy(generatedFiles = item.generatedFiles.filterNot { it.path == captured.first.path } + captured.second)
                }) })
            })) }
        }
    }

    override suspend fun readGeneratedFile(file: GeneratedFile): ByteArray {
        GeneratedFilePolicy.validate(file)
        if (!file.blob) return file.content?.toByteArray()?.also { require(it.size <= GeneratedFilePolicy.MAX_BYTES) } ?: throw ApiException("MISSING_CONTENT", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        val encoded = rpc("readGeneratedFile", file.digest) as? String ?: throw ApiException("BAD_FILE", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        return withContext(Dispatchers.Default) { GeneratedFilePolicy.decode(file, encoded) }
    }
    override suspend fun deleteProject(id: String) {
        val expected = epoch.value
        rpc("deleteProject", id)
        synchronized(contentLock) { if (epoch.accepts(expected)) state.update { it.copy(projects = it.projects.filterNot { p -> p.id == id }, conversations = it.conversations.map { c -> if (c.projectId == id) c.copy(projectId = null) else c }) } }
    }
    override suspend fun saveProject(project: Project) { rpc("saveProject", WireCodec.project(project)); refresh() }
    override suspend fun signOut() {
        enabled = false; socketGeneration++; resetContentSession(); reconnectJob?.cancel(); heartbeat?.cancel(); socket?.close(1000, "signed out"); socket = null
        cursor.reset(null); WireCodec.clear(); link.value = Connection.Offline
        api.logout()
    }
    fun stopEvents() { enabled = false; socketGeneration++; reconnectJob?.cancel(); heartbeat?.cancel(); socket?.close(1000, "background"); socket = null; link.value = Connection.Offline }
    suspend fun resumeEvents() = lifecycleMutex.withLock { if (api.session != null && socket == null && reconnectJob?.isActive != true) { enabled = true; refreshThenConnect() } }
    private suspend fun refreshThenConnect() {
        try { refresh() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { connect(); throw error }
        connect()
    }
    private suspend fun connect() {
        if (!enabled) return
        val connectionGeneration = ++socketGeneration
        val expected = epoch.value
        link.value = Connection.Connecting
        try {
            val data = api.request("/api/v1/claudex/mobile/events-ticket", JSONObject().put("tabId", api.tabId), true).getJSONObject("data")
            if (!epoch.accepts(expected) || !enabled || connectionGeneration != socketGeneration) return
            require(data.getString("ticket").matches(Regex("[A-Za-z0-9_-]{43}"))) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
            val request = Request.Builder().url(api.origin.trimEnd('/').replaceFirst("https://", "wss://") + "/api/v1/claudex/web/events").header("Sec-WebSocket-Protocol", "claudex.v1, ticket.${data.getString("ticket")}").build()
            socket = api.client.newWebSocket(request, object: WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    if (!epoch.accepts(expected) || !enabled || connectionGeneration != socketGeneration) { ws.cancel(); return }
                    if (response.header("Sec-WebSocket-Protocol") != "claudex.v1") { enabled = false; link.value = Connection.Error(UserText.get(R.string.generic_error_something_went_wrong_try_again)); ws.close(4400, "protocol mismatch"); return }
                    val hello = EventMessages.hello(api.tabId, cursor.lastSequence)
                    ws.send(hello.toString()); ws.send(EventMessages.presence(true, true).toString())
                    heartbeat?.cancel(); heartbeat = scope.launch { while (isActive) { delay(25_000); ws.send("{\"t\":\"ping\"}") } }
                }
                override fun onMessage(ws: WebSocket, text: String) { scope.launch { if (epoch.accepts(expected) && enabled && connectionGeneration == socketGeneration) runCatching { receiveFrame(JSONObject(text), expected, connectionGeneration) }.onFailure { if (acceptsFrame(expected, connectionGeneration) && enabled) { scheduleSnapshotResync(expected, connectionGeneration) } } } }
                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { scope.launch { if (epoch.accepts(expected) && enabled && connectionGeneration == socketGeneration) recover() } }
                override fun onClosed(ws: WebSocket, code: Int, reason: String) { scope.launch {
                    if (!epoch.accepts(expected) || !enabled || connectionGeneration != socketGeneration) return@launch
                    if (code == 4008 || code == 4003) { expireSession() } else if (code == 4400) { enabled = false; link.value = Connection.Error(UserText.get(R.string.generic_error_something_went_wrong_try_again)) } else recover()
                } }
            })
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            if (!epoch.accepts(expected) || !enabled || connectionGeneration != socketGeneration) return
            if (e is ApiException && e.httpStatus in listOf(401, 403, 404)) {
                enabled = false
                link.value = Connection.Error(when (e.httpStatus) { 404 -> UserText.get(R.string.generic_error_something_went_wrong_try_again); 403 -> UserText.get(R.string.generic_error_something_went_wrong_try_again); else -> UserText.get(R.string.error_account_session_invalid) })
                if (e.httpStatus == 401) api.clear()
            } else recover()
        }
    }
    /** One serialized ingress for the real socket and deterministic protocol tests. */
    internal suspend fun receiveFrame(j: JSONObject, expectedEpoch: Long? = null, expectedSocket: Long? = null) = eventMutex.withLock {
        val ingressEpoch = expectedEpoch ?: synchronized(contentLock) { epoch.value }
        if (!acceptsFrame(ingressEpoch, expectedSocket)) return@withLock
        frame(j, ingressEpoch, expectedSocket)
    }

    private fun acceptsFrame(ingressEpoch: Long, expectedSocket: Long?): Boolean = synchronized(contentLock) {
        epoch.accepts(ingressEpoch) && (expectedSocket == null || expectedSocket == socketGeneration)
    }

    private suspend fun frame(j: JSONObject, ingressEpoch: Long, expectedSocket: Long?) {
        when (j.optString("t")) {
            "ready" -> {
                if (j.optInt("v", -1) != 1 || !j.has("seq") || j.getDouble("seq") < 0 || j.getDouble("seq") % 1.0 != 0.0) {
                    enabled = false; link.value = Connection.Error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
                    socket?.close(4400, "protocol mismatch"); return
                }
                if (!j.optBoolean("resumed")) {
                    val sequence = EventMessages.sequence(j)
                    // A fresh server may restart its counter; ready establishes this stream's cursor.
                    cursor.reset(sequence)
                    if (snapshotEventSequence != sequence) scheduleSnapshotResync(ingressEpoch, expectedSocket)
                }
                resyncBudget.succeeded()
                attempt = 0; link.value = Connection.Connected
            }
            "snapshot" -> {
                val sequence = EventMessages.sequence(j)
                hiddenArtifacts = j.getJSONObject("snapshot").optJSONArray("artifactShares")?.objects()?.filter { !it.optBoolean("showInList", true) }?.map { it.optString("identity") }?.toSet().orEmpty()
                installSnapshot(WireCodec.snapshot(j.getJSONObject("snapshot"), catalog), ingressEpoch)
                if (acceptsFrame(ingressEpoch, expectedSocket)) cursor.reset(sequence)
            }
            "event" -> {
                val event = j.getJSONObject("event")
                if (event.optString("type") == "signed-out") { expireSession(); return }
                try {
                    when (cursor.receive(EventMessages.sequence(j))) {
                        EventCursor.Decision.APPLY -> applyEvent(event, ingressEpoch)
                        EventCursor.Decision.DUPLICATE -> Unit
                        EventCursor.Decision.RESYNC -> {
                            // Web advances/delivers on a gap and refreshes state without closing WSS.
                            cursor.reset(EventMessages.sequence(j))
                            scheduleSnapshotResync(ingressEpoch, expectedSocket)
                            applyEvent(event, ingressEpoch)
                        }
                    }
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (acceptsFrame(ingressEpoch, expectedSocket)) {
                        // Do not replay a permanently rejected frame by reconnecting with the old cursor.
                        scheduleSnapshotResync(ingressEpoch, expectedSocket)
                    }
                    // An old request must not restore the old cursor or report an error into a new session.
                }
            }
            "error" -> { link.value = Connection.Error(j.optString("message", UserText.get(R.string.generic_error_something_went_wrong_try_again))) }
            // open-url is intentionally not automatically navigated; remote content cannot launch apps.
        }
    }
    fun clearLocalSession() { enabled = false; socketGeneration++; resetContentSession(); WireCodec.clear(); cursor.reset(null); heartbeat?.cancel(); reconnectJob?.cancel(); socket?.cancel(); socket = null; link.value = Connection.Offline }
    private fun expireSession() { enabled = false; socketGeneration++; resetContentSession(); api.clear(); WireCodec.clear(); cursor.reset(null); heartbeat?.cancel(); reconnectJob?.cancel(); socket?.close(1000, "signed out"); socket = null; link.value = Connection.Error(UserText.get(R.string.error_account_session_invalid)) }
    private suspend fun applyEvent(event: JSONObject, ingressEpoch: Long) {
        if (!acceptsFrame(ingressEpoch, null)) return
        when (event.optString("type")) {
            "approval" -> { val approval = WireCodec.approval(event.getJSONObject("approval")); synchronized(contentLock) { if (epoch.accepts(ingressEpoch)) state.update { it.copy(approvals = it.approvals.filterNot { a -> a.id == approval.id } + approval) } } }
            "approval-resolved" -> synchronized(contentLock) { if (epoch.accepts(ingressEpoch)) state.update { it.copy(approvals = it.approvals.filterNot { a -> a.id == event.get("id").toString() }) } }
            "conversation" -> replace(WireCodec.conversation(event.getJSONObject("conversation")), ingressEpoch)
            "conversation-turn" -> {
                val id = event.getString("conversationId")
                val turn = WireCodec.turn(event.getJSONObject("turn"))
                if (!replaceTurn(id, turn, event.optJSONObject("conversation"), ingressEpoch)) refreshSnapshot(ingressEpoch)
            }
            "device-event", "devices-changed" -> DeviceStreamEvent.from(event)?.let { deviceEvents.tryEmit(it) }
            "schedules", "memory-changed", "service-changed" -> featureRevision.update { it + 1 }
            "resync", "projects", "artifact-library" -> { refreshSnapshot(ingressEpoch); featureRevision.update { it + 1 } }
        }
    }
    private fun withGeneratedFiles(incoming: Snapshot): Snapshot {
        val snapshot = incoming.copy(conversations = incoming.conversations.map { c ->
            ImageToolSnapshotPolicy.retainCapturedImages(state.value.conversations.find { it.id == c.id }, c)
        })
        val pinned = snapshot.artifacts.filter { it.pinned }.map { it.identity }.toSet()
        val generated = snapshot.conversations.flatMap { c -> c.turns.flatMap { it.items }.flatMap { it.generatedFiles }.filter { it.state == "ready" }.map { f ->
            val identity = JSONArray(listOf(c.id, f.path.ifBlank { f.content ?: f.id })).toString()
            Artifact(java.util.UUID.nameUUIDFromBytes(identity.toByteArray()).toString(), f.name, f.language, f.content.orEmpty(), c.id, identity in pinned, identity, f)
        } }.asReversed().distinctBy { it.identity }.filterNot { it.identity in hiddenArtifacts }
        return snapshot.copy(artifacts = snapshot.artifacts.filter { it.generatedFile == null } + generated)
    }
    private fun replace(c: Conversation, expectedEpoch: Long? = null) {
        synchronized(contentLock) {
            if (expectedEpoch != null && !epoch.accepts(expectedEpoch)) return
            if (c.id in deletedConversations) return
            conversationRevisions[c.id] = (conversationRevisions[c.id] ?: 0L) + 1
            state.update { withGeneratedFiles(it.copy(conversations = it.conversations.filterNot { old -> old.id == c.id } + c)) }
            if (!c.slim) contentState.update { it - c.id }
        }
        queueViewedConversation(c.id)
    }

    /** A delta invalidates older reads, but cannot start full transcript requests on every token. */
    private fun replaceTurn(id: String, turn: Turn, patch: JSONObject?, expectedEpoch: Long): Boolean = synchronized(contentLock) {
        if (!epoch.accepts(expectedEpoch)) return@synchronized true
        val existing = state.value.conversations.find { it.id == id } ?: return@synchronized false
        val updated = WireCodec.mergeConversationPatch(existing, patch).copy(
            turns = if (existing.turns.any { it.id == turn.id }) existing.turns.map { if (it.id == turn.id) turn else it } else existing.turns + turn
        )
        conversationRevisions[id] = (conversationRevisions[id] ?: 0L) + 1
        state.update { withGeneratedFiles(it.copy(conversations = it.conversations.map { c -> if (c.id == id) updated else c })) }
        if (updated.slim && viewed?.id == id && !contentRequests.containsKey(id)) {
            contentState.update { it + (id to ContentLoadState.Failed(UserText.get(R.string.generic_error_something_went_wrong_try_again))) }
        }
        true
    }

    private fun installSnapshot(next: Snapshot, expectedEpoch: Long? = null) {
        synchronized(contentLock) {
            if (expectedEpoch != null && !epoch.accepts(expectedEpoch)) return
            snapshotRevision++
            state.value = next.copy(accountName = next.accountName.ifBlank { state.value.accountName }, conversations = next.conversations.filterNot { it.id in deletedConversations })
            val existingIds = next.conversations.map { it.id }.toSet()
            conversationRevisions.keys.retainAll(existingIds)
            attemptedVersions.keys.retainAll(existingIds)
            queuedContentVersions.keys.retainAll(existingIds)
            contentState.update { statuses -> statuses.filterKeys { id -> next.conversations.any { it.id == id && it.slim } } }
        }
        queueViewedConversation()
    }

    private fun queueViewedConversation(changedId: String? = null) {
        synchronized(contentLock) {
            val view = viewed ?: return
            if (changedId != null && changedId != view.id) return
            queuedContentVersions[view.id] = versionFor(view.id)
        }
        hydrateViewedConversation()
    }

    /** A lease makes a late onDispose from an outgoing destination harmless. */
    fun beginViewingConversation(id: String): Long {
        val lease: Long
        val cancel: List<Job>
        synchronized(contentLock) {
            val sameConversation = viewed?.id == id
            lease = ++nextViewLease
            viewed = ViewedConversation(id, lease)
            if (sameConversation) contentRequests[id]?.viewLease = lease
            else attemptedVersions.remove(id)
            queuedContentVersions[id] = versionFor(id)
            cancel = contentRequests.values.filter { it.viewLease != lease }.map { it.job }
        }
        cancel.forEach(Job::cancel)
        hydrateViewedConversation()
        return lease
    }

    fun endViewingConversation(lease: Long) {
        val cancel: List<Job>
        synchronized(contentLock) {
            if (viewed?.lease != lease) return
            viewed = null
            nextViewLease++
            cancel = contentRequests.values.filter { it.viewLease == lease }.map { it.job }
        }
        cancel.forEach(Job::cancel)
    }

    fun retryConversationContent(id: String) {
        synchronized(contentLock) {
            if (viewed?.id != id || contentRequests.containsKey(id)) return
            attemptedVersions.remove(id)
            queuedContentVersions[id] = versionFor(id)
        }
        hydrateViewedConversation()
    }

    private fun versionFor(id: String) = ContentVersion(epoch.value, snapshotRevision, conversationRevisions[id] ?: 0L)

    private fun acceptsContent(request: ContentRequest): Boolean {
        return contentRequests[request.id] === request && viewed == ViewedConversation(request.id, request.viewLease) &&
            versionFor(request.id) == request.version && state.value.conversations.any { it.id == request.id && it.slim }
    }

    /** Only snapshot/open/retry triggers queue reads; turn deltas never create a retry loop. */
    private fun hydrateViewedConversation() {
        if (!scope.isActive) return
        val request: ContentRequest
        synchronized(contentLock) {
            val view = viewed ?: return
            val conversation = state.value.conversations.find { it.id == view.id } ?: return
            if (!conversation.slim || contentRequests.containsKey(view.id)) return
            val version = versionFor(view.id)
            if (queuedContentVersions[view.id] != version) return
            if (attemptedVersions[view.id] == version) return
            attemptedVersions[view.id] = version
            request = ContentRequest(view.id, version, view.lease)
            request.job = scope.launch(start = CoroutineStart.LAZY) { loadConversationContent(request) }
            contentRequests[view.id] = request
            contentState.update { it + (view.id to ContentLoadState.Loading) }
            request.job.invokeOnCompletion { cause -> finishContentRequest(request, cause) }
        }
        request.job.start()
    }

    private suspend fun loadConversationContent(request: ContentRequest) {
        try {
            val value = rpc("conversationTurns", request.id) as? JSONObject
                ?: throw ApiException("BAD_TURNS", UserText.get(R.string.generic_error_something_went_wrong_try_again))
            val turns = WireCodec.fullTurns(value)
            synchronized(contentLock) {
                if (acceptsContent(request)) {
                    state.update { snapshot -> withGeneratedFiles(snapshot.copy(conversations = snapshot.conversations.map { conversation ->
                        if (conversation.id == request.id) conversation.copy(turns = turns, savedBranches = WireCodec.branches(value), slim = false) else conversation
                    })) }
                    conversationRevisions[request.id] = (conversationRevisions[request.id] ?: 0L) + 1
                    contentState.update { it - request.id }
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            synchronized(contentLock) {
                if (acceptsContent(request)) {
                    contentState.update { it + (request.id to ContentLoadState.Failed(
                        UserText.get(R.string.generic_error_something_went_wrong_try_again)
                    )) }
                }
            }
        }
    }

    private fun finishContentRequest(request: ContentRequest, cause: Throwable?) {
        synchronized(contentLock) {
            if (contentRequests[request.id] === request) {
                contentRequests.remove(request.id)
                if (cause is CancellationException && attemptedVersions[request.id] == request.version) {
                    attemptedVersions.remove(request.id)
                }
                if (contentState.value[request.id] is ContentLoadState.Loading) {
                    val now = versionFor(request.id)
                    val incomplete = state.value.conversations.any { it.id == request.id && it.slim }
                    if (incomplete && viewed?.id == request.id && now != request.version && queuedContentVersions[request.id] != now) {
                        contentState.update { it + (request.id to ContentLoadState.Failed(UserText.get(R.string.generic_error_something_went_wrong_try_again))) }
                    } else contentState.update { it - request.id }
                }
            }
        }
        // Completion also runs when a lazy job is canceled before its body starts.
        // Only an explicitly queued snapshot/open/retry can start a subsequent read.
        hydrateViewedConversation()
    }

    private fun resetContentSession() {
        synchronized(contentLock) { deletedConversations.clear(); hiddenArtifacts = emptySet() }
        val cancel: List<Job>
        synchronized(contentLock) {
            resyncJob?.cancel(); resyncJob = null; resyncBudget.succeeded()
            epoch.invalidate()
            snapshotRevision++
            nextViewLease++
            viewed = null
            cancel = contentRequests.values.map { it.job }
            contentRequests.clear()
            attemptedVersions.clear()
            queuedContentVersions.clear()
            conversationRevisions.clear()
            contentState.value = emptyMap()
            state.value = Snapshot()
        }
        cancel.forEach(Job::cancel)
    }
    private fun scheduleSnapshotResync(expectedEpoch: Long, expectedSocket: Long?) {
        if (!acceptsFrame(expectedEpoch, expectedSocket) || resyncJob?.isActive == true || !resyncBudget.canRead()) return
        resyncJob = scope.launch {
            delay(100) // Coalesce burst events like src-web/bridge/events.ts.
            eventMutex.withLock {
                if (!acceptsFrame(expectedEpoch, expectedSocket)) return@withLock
                try {
                    refreshSnapshot(expectedEpoch)
                    if (acceptsFrame(expectedEpoch, expectedSocket)) { resyncBudget.succeeded(); if (enabled && expectedSocket != null) link.value = Connection.Connected }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (acceptsFrame(expectedEpoch, expectedSocket)) {
                        resyncBudget.failed()
                        link.value = Connection.Error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
                    }
                }
            }
        }
    }
    private fun recover() {
        if (!enabled || reconnectJob?.isActive == true) return
        heartbeat?.cancel(); socket?.cancel(); socket = null
        link.value = Connection.Reconnecting(++attempt)
        reconnectJob = scope.launch { delay(RetryPolicy.delayMs(attempt - 1)); reconnectJob = null; connect() }
    }
}
