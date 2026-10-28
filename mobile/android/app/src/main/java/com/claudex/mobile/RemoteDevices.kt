package com.claudex.mobile

import com.claudex.core.ApiException
import com.claudex.core.Approval
import com.claudex.core.Conversation
import com.claudex.core.TurnStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

// The account's signed-in desktops (main shared/remote-devices.ts, owner
// 2026-10-06; the iOS app's Core/RemoteDevices.swift): the phone lists the
// computers that are online, opens a Code conversation on one, sends to it,
// stops it and answers its approvals. The conversation stays on the computer.

data class DeviceInfo(val id: String, val name: String, val platform: String, val version: String, val connectedAt: String) {
    val platformName: String get() = when (platform) { "darwin" -> "Mac"; "win32" -> "Windows"; "linux" -> "Linux"; else -> platform }
    companion object {
        fun from(j: JSONObject) = DeviceInfo(j.getString("id"), j.optString("name", UserText.get(R.string.claudex_device_default_name)), j.optString("platform"), j.optString("version"), j.optString("connectedAt"))
    }
}

data class DeviceConversationSummary(val id: String, val title: String, val cwd: String?, val updatedAt: Long, val running: Boolean, val approvals: Int, val model: String) {
    /** The folder's last part ("Claudex" for /Users/me/Developer/Claudex). */
    val folderName: String? get() = cwd?.takeIf { it.isNotBlank() }?.split('/', '\\')?.lastOrNull { it.isNotBlank() } ?: cwd
    companion object {
        fun from(j: JSONObject) = DeviceConversationSummary(j.getString("id"), j.optString("title", UserText.get(R.string.claudex_device_default_chat)), j.optString("cwd").takeIf { it.isNotBlank() },
            j.optLong("updatedAt"), j.optBoolean("running"), j.optInt("approvals"), j.optString("model"))
    }
}

/** A folder the computer's owner added for phones (Settings → General → Folders for your phone). */
data class DeviceDirectory(val path: String, val name: String, val sessions: Int, val default: Boolean) {
    companion object {
        fun from(j: JSONObject) = DeviceDirectory(j.getString("path"), j.optString("name").ifBlank { j.getString("path") }, j.optInt("sessions"), j.optBoolean("default"))
    }
}

/** A model the computer can run a session on, as listModels names it. */
data class DeviceModelOption(val providerId: String, val id: String)
data class DeviceModels(val models: List<DeviceModelOption>, val default: DeviceModelOption?) {
    companion object {
        private fun option(j: JSONObject) = DeviceModelOption(j.getString("providerId"), j.getString("id"))
        fun from(j: JSONObject) = DeviceModels(j.optJSONArray("models")?.objects().orEmpty().map(::option), j.optJSONObject("default")?.let(::option))
    }
}

/** An opened desktop conversation and the approvals it waits on. */
data class DeviceConversationState(val deviceId: String, val conversation: Conversation, val approvals: List<Approval>) {
    val running: Boolean get() = conversation.turns.lastOrNull()?.status == TurnStatus.IN_PROGRESS

    /** The state after one device event (the inner `event` of a device-event); null when it changed nothing. */
    fun applying(event: JSONObject): DeviceConversationState? = when (event.optString("type")) {
        "conversation" -> event.optJSONObject("conversation")?.let(WireCodec::conversation)?.takeIf { it.id == conversation.id }?.let { copy(conversation = it) }
        "conversation-turn" -> if (event.optString("conversationId") != conversation.id) null else {
            val turn = WireCodec.turn(event.getJSONObject("turn"))
            val turns = conversation.turns.toMutableList()
            val index = turns.indexOfFirst { it.id == turn.id }
            if (index >= 0) turns[index] = turn else turns.add(turn)
            val full = WireCodec.conversation(conversation.copy(turns = turns))
            event.optJSONObject("conversation")?.let { patch -> patch.keys().forEach { key -> if (key != "id" && key != "turns") full.put(key, patch.get(key)) } }
            copy(conversation = WireCodec.conversation(full))
        }
        "approval" -> {
            val approval = WireCodec.approval(event.getJSONObject("approval"))
            if (approval.conversationId != conversation.id) null else copy(approvals = approvals.filterNot { it.id == approval.id } + approval)
        }
        "approval-resolved" -> {
            val id = event.opt("id")?.toString()
            if (approvals.none { it.id == id }) null else copy(approvals = approvals.filterNot { it.id == id })
        }
        else -> null
    }
}

sealed interface DeviceStreamEvent {
    data object DevicesChanged: DeviceStreamEvent
    data class Device(val id: String, val event: JSONObject): DeviceStreamEvent
    companion object {
        /** A device-event or devices-changed event from the account's stream. */
        fun from(event: JSONObject): DeviceStreamEvent? = when (event.optString("type")) {
            "devices-changed" -> DevicesChanged
            "device-event" -> {
                val id = event.optString("deviceId"); val inner = event.optJSONObject("event")
                if (id.isBlank() || inner == null || inner.optString("type").isBlank()) null else Device(id, inner)
            }
            else -> null
        }
    }
}

/** Calls to the account's desktops through the service. */
class DeviceClient(private val api: NativeApi) {
    suspend fun devices(): List<DeviceInfo> {
        val result = api.request("/api/v1/claudex/web/devices", authorized = true, method = "GET")
        return (value(result) as? JSONArray)?.objects().orEmpty().map(DeviceInfo::from)
    }
    suspend fun call(device: String, method: String, vararg args: Any?): Any? {
        require(device.matches(Regex("[A-Za-z0-9_-]{8,64}")) && method.matches(Regex("[a-z][A-Za-z0-9]{0,63}")))
        val result = try {
            api.request("/api/v1/claudex/web/devices/$device/rpc/$method", JSONObject().put("args", JSONArray(args.toList())), authorized = true)
        } catch (e: ApiException) { throw ApiException(e.code, message(e.code, e.message), e.httpStatus) }
        return value(result)
    }
    suspend fun conversations(device: String) = (call(device, "listCodeConversations") as? JSONArray)?.objects().orEmpty().map(DeviceConversationSummary::from)
    suspend fun open(device: String, id: String): DeviceConversationState {
        val value = call(device, "openConversation", id) as? JSONObject ?: throw ApiException("BAD_RESPONSE", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        val conversation = WireCodec.conversation(value.getJSONObject("conversation"))
        require(conversation.id == id)
        return DeviceConversationState(device, conversation, value.optJSONArray("approvals")?.objects().orEmpty().map(WireCodec::approval))
    }
    suspend fun send(device: String, id: String, text: String) { call(device, "send", JSONObject().put("conversationId", id).put("text", text)) }
    /** The folders new sessions may start in (the computer refuses any other path). */
    suspend fun directories(device: String) = (call(device, "listDirectories") as? JSONArray)?.objects().orEmpty().map(DeviceDirectory::from)
    /** Starts a Code session in [cwd] with its first message; the answer is the session to open. */
    suspend fun newSession(device: String, cwd: String, text: String): String {
        val answer = call(device, "newSession", JSONObject().put("cwd", cwd).put("text", text)) as? JSONObject
        return answer?.optString("conversationId")?.takeIf { it.isNotBlank() } ?: throw ApiException("BAD_RESPONSE", UserText.get(R.string.generic_error_something_went_wrong_try_again))
    }
    /** Stops the session's turn and archives it on the computer. */
    suspend fun endSession(device: String, id: String) { call(device, "endSession", id) }
    suspend fun models(device: String) = (call(device, "listModels") as? JSONObject)?.let(DeviceModels::from) ?: DeviceModels(emptyList(), null)
    /** The session's model from its next message on. */
    suspend fun setModel(device: String, id: String, model: DeviceModelOption) {
        call(device, "setModel", JSONObject().put("conversationId", id).put("providerId", model.providerId).put("model", model.id))
    }
    suspend fun interrupt(device: String, id: String) { call(device, "interrupt", id) }
    suspend fun approve(device: String, approval: Approval, decision: JSONObject) {
        call(device, "approve", if (approval.numericId) approval.id.toLongOrNull() ?: approval.id else approval.id, decision)
    }
    private fun value(result: JSONObject): Any? {
        if (!result.optBoolean("ok")) {
            val error = result.optJSONObject("error") ?: JSONObject()
            val code = error.optString("code", "DEVICE_ERROR")
            throw ApiException(code, message(code, error.optString("message")))
        }
        return result.opt("value")
    }
    companion object {
        /** The service's and the computer's refusals in the app's language (strings_messages.xml); an unknown message passes through. */
        @androidx.annotation.StringRes fun messageRes(code: String?, fallback: String?): Int? = when (code) {
            "CLAUDEX_DEVICE_OFFLINE" -> R.string.claudex_msg_offline_computer
            "CLAUDEX_DEVICE_BUSY" -> R.string.claudex_msg_computer_busy
            "CLAUDEX_WEB_TIMEOUT" -> R.string.claudex_msg_computer_timeout
            "CLAUDEX_WEB_METHOD_UNAVAILABLE" -> R.string.claudex_msg_computer_outdated
            else -> when (fallback) {
                "This conversation is not on this computer." -> R.string.claudex_msg_chat_not_on_computer
                "This request was already answered." -> R.string.claudex_msg_request_answered
                "Write a message first." -> R.string.claudex_msg_write_first
                "Wait for or stop the running task first." -> R.string.claudex_msg_wait_task
                "This folder isn't added for your phone. Add it in Settings on the computer." -> R.string.claudex_msg_folder_not_added
                "Choose a directory, not the filesystem root." -> R.string.claudex_msg_choose_directory
                "Choose a model first.", "No model is available on this computer." -> R.string.claudex_msg_no_model
                "This account cannot use the selected model." -> R.string.claudex_msg_model_unavailable
                "This computer couldn't start the session." -> R.string.claudex_msg_cannot_start_session
                null, "" -> R.string.error_unknown
                else -> null
            }
        }
        fun message(code: String?, fallback: String?): String = messageRes(code, fallback)?.let { UserText.get(it) } ?: fallback.orEmpty()
    }
}

/** The account's online computers and the Code conversation opened on one. */
class DeviceController(private val scope: CoroutineScope, private val client: () -> DeviceClient?) {
    val devices = MutableStateFlow<List<DeviceInfo>>(emptyList())
    val loaded = MutableStateFlow(false)
    val conversations = MutableStateFlow<Map<String, List<DeviceConversationSummary>>>(emptyMap())
    val open = MutableStateFlow<DeviceConversationState?>(null)
    val sending = MutableStateFlow(false)
    val error = MutableStateFlow<String?>(null)
    /** Computer id → the folders phones may start sessions in. */
    val directories = MutableStateFlow<Map<String, List<DeviceDirectory>>>(emptyMap())
    /** Computer id → the folder the person picked for new sessions (the default folder otherwise). */
    val chosenDirectory = MutableStateFlow<Map<String, String>>(emptyMap())
    private var generation = 0
    private var renewJob: Job? = null
    private var devicesJob: Job? = null
    private val listJobs = mutableMapOf<String, Job>()

    fun reset() {
        generation++; renewJob?.cancel(); devicesJob?.cancel(); listJobs.values.forEach { it.cancel() }; listJobs.clear()
        devices.value = emptyList(); loaded.value = false; conversations.value = emptyMap(); open.value = null; sending.value = false; error.value = null
        directories.value = emptyMap(); chosenDirectory.value = emptyMap()
    }

    /** The folder new sessions start in: the picked one if it is still offered, else the default, else the first. */
    fun directoryFor(device: String): DeviceDirectory? {
        val list = directories.value[device].orEmpty()
        return list.find { it.path == chosenDirectory.value[device] } ?: list.find { it.default } ?: list.firstOrNull()
    }
    fun chooseDirectory(device: String, path: String) { chosenDirectory.value = chosenDirectory.value + (device to path) }

    private suspend fun guarded(block: suspend (Int) -> Unit) {
        val epoch = generation
        try { block(epoch) } catch (c: CancellationException) { throw c } catch (e: Exception) { if (epoch == generation) error.value = e.message ?: UserText.get(R.string.error_unknown) }
    }

    suspend fun loadDevices() {
        val c = client() ?: return
        val epoch = generation
        try {
            val next = c.devices()
            if (epoch != generation) return
            devices.value = next; loaded.value = true
            conversations.value = conversations.value.filterKeys { id -> next.any { it.id == id } }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { if (epoch == generation) { loaded.value = true; error.value = e.message } }
    }

    suspend fun loadConversations(device: String) = guarded { epoch ->
        val list = client()?.conversations(device) ?: return@guarded
        if (epoch == generation) conversations.value = conversations.value + (device to list)
    }

    suspend fun loadDirectories(device: String) = guarded { epoch ->
        val list = client()?.directories(device) ?: return@guarded
        if (epoch == generation) directories.value = directories.value + (device to list)
    }

    /** Starts a session in the chosen folder with its first message; the id of the session to open, or null (the reason is in [error]). */
    suspend fun startSession(device: String, text: String): String? {
        val c = client() ?: return null; val directory = directoryFor(device) ?: return null
        val trimmed = text.trim(); if (trimmed.isEmpty() || sending.value) return null
        sending.value = true
        return try { c.newSession(device, directory.path, trimmed).also { loadConversations(device) } }
        catch (e: CancellationException) { throw e } catch (e: Exception) { error.value = e.message; null }
        finally { sending.value = false }
    }

    /** "End session" on a row or in the session's menu; true once the computer archived it. */
    suspend fun endSession(device: String, id: String): Boolean {
        val c = client() ?: return false
        return try { c.endSession(device, id); conversations.value[device]?.let { list -> conversations.value = conversations.value + (device to list.filterNot { it.id == id }) }; loadConversations(device); true }
        catch (e: CancellationException) { throw e } catch (e: Exception) { error.value = UserText.get(R.string.claudex_device_end_failed); false }
    }

    suspend fun models(device: String): DeviceModels? = try { client()?.models(device) } catch (e: CancellationException) { throw e } catch (e: Exception) { error.value = e.message; null }

    /** "Change model" in the session's menu; true once saved. */
    suspend fun setModel(device: String, id: String, model: DeviceModelOption): Boolean {
        val c = client() ?: return false
        return try { c.setModel(device, id, model); openConversation(device, id); true }
        catch (e: CancellationException) { throw e } catch (e: Exception) { error.value = UserText.get(R.string.ccr_model_save_failed); false }
    }

    suspend fun openConversation(device: String, id: String) = guarded { epoch ->
        val state = client()?.open(device, id) ?: return@guarded
        if (epoch != generation) return@guarded
        open.value = state
        renew(device, id)
    }

    /** The computer streams a conversation for a few minutes after it was opened: ask again while it stays on screen. */
    private fun renew(device: String, id: String) {
        renewJob?.cancel()
        renewJob = scope.launch {
            while (true) {
                delay(150_000)
                if (open.value?.conversation?.id != id) return@launch
                runCatching { client()?.open(device, id) }.getOrNull()?.let { if (open.value?.conversation?.id == id) open.value = it }
            }
        }
    }

    fun close(id: String) { if (open.value?.conversation?.id == id) { renewJob?.cancel(); open.value = null } }

    suspend fun send(text: String): Boolean {
        val c = client() ?: return false; val state = open.value ?: return false
        val trimmed = text.trim(); if (trimmed.isEmpty() || sending.value) return false
        sending.value = true
        return try { c.send(state.deviceId, state.conversation.id, trimmed); true }
        catch (e: CancellationException) { throw e } catch (e: Exception) { error.value = e.message; false }
        finally { sending.value = false }
    }

    suspend fun interrupt() = guarded { val state = open.value ?: return@guarded; client()?.interrupt(state.deviceId, state.conversation.id) }

    /** Answers a computer's request with the response its card built. */
    suspend fun approve(approval: Approval, response: JSONObject) {
        val state = open.value ?: return
        client()?.approve(state.deviceId, approval, response)
    }

    fun receive(event: DeviceStreamEvent) {
        when (event) {
            DeviceStreamEvent.DevicesChanged -> {
                devicesJob?.cancel()
                devicesJob = scope.launch {
                    delay(300); loadDevices()
                    // Back online after a restart: open it again so it streams.
                    open.value?.let { state -> if (devices.value.any { it.id == state.deviceId }) openConversation(state.deviceId, state.conversation.id) }
                }
            }
            is DeviceStreamEvent.Device -> {
                if (event.event.optString("type") == "device-conversations") {
                    if (event.id !in conversations.value) return
                    listJobs[event.id]?.cancel()
                    listJobs[event.id] = scope.launch { delay(200); loadConversations(event.id); if (event.id in directories.value) loadDirectories(event.id) }
                    return
                }
                val state = open.value ?: return
                if (state.deviceId != event.id) return
                runCatching { state.applying(event.event) }.getOrNull()?.let { open.value = it }
            }
        }
    }
}
