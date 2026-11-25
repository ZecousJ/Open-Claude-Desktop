package com.claudex.mobile

import kotlin.math.roundToInt

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.*
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.toArgb
import com.claudex.core.TurnStatus
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.navigation.NavHostController
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import com.claudex.core.Conversation
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.ByteArrayInputStream

private const val CONVERSATION_ENTRY = ConversationBridgePolicy.ENTRY
private const val TRANSCRIPT_MEDIA_PAUSE = "document.querySelectorAll('audio,video').forEach(function(node){ try { node.pause(); } catch (e) {} }); if (window.speechSynthesis) window.speechSynthesis.cancel();"
private data class ConversationExport(val name: String, val mime: String, val bytes: ByteArray, val result: CompletableDeferred<String?>)
private data class ConversationConfirmation(val title: String, val message: String, val result: CompletableDeferred<Boolean>)

/** Native shell only. Conversation DOM, Markdown, tools, files and CSS come from the same web/desktop bundle. */
@Composable internal fun SharedConversationView(vm: AppViewModel, nav: NavHostController, conversation: Conversation, modifier: Modifier = Modifier, document: ConversationDocument? = null, surfaceKey: String = conversation.id, promotePending: Boolean = false, active: Boolean = true, coveredByFilePreview: Boolean = false, onTranscriptPainted: (String) -> Unit = {}) {
    val context = LocalContext.current
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val snapshotState = vm.snapshot.collectAsStateWithLifecycle()
    val theme by vm.theme.collectAsStateWithLifecycle()
    val busyState = vm.busy.collectAsStateWithLifecycle()
    val queues = vm.queuedComposer.messages.collectAsStateWithLifecycle()
    val sendingState = remember(conversation.id) { derivedStateOf {
        busyState.value || queues.value[conversation.id].orEmpty().any { it.state == com.claudex.core.QueuedState.SUBMITTING || it.state == com.claudex.core.QueuedState.SENDING }
    } }
    val operationsState = vm.conversationActions.collectAsStateWithLifecycle()
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var confirmation by remember { mutableStateOf<ConversationConfirmation?>(null) }
    var failure by remember(conversation.id) { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val activation = remember { intArrayOf(0) }
    val keepTranscript = active || coveredByFilePreview
    val activationId = remember(keepTranscript) { if (keepTranscript) ++activation[0] else activation[0] }
    val lease = remember(conversation.id, document?.id, document?.source?.digest, signedIn, vm.api.sessionGeneration, attempt, activationId) { vm.beginConversationBridge(conversation.id) }
    var acknowledged by remember(lease) { mutableStateOf(false) }
    val canvas = remember(surfaceKey, signedIn, vm.api.sessionGeneration, document?.id, document?.source?.digest) { ConversationCanvas() }
    DisposableEffect(canvas) { onDispose { canvas.dispose() } }
    val mediaState = remember(lease) { mutableStateOf(ConversationMedia()) }
    val exportReservation = remember(lease) { NativePickerReservation<ConversationExport>() }
    val exportLauncher = key(lease.id) { rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { activityResult ->
        val request = exportReservation.takeResult()
        if (request != null && request.result.isActive) {
            val uri = activityResult.data?.data
            if (activityResult.resultCode != android.app.Activity.RESULT_OK || uri == null || !vm.acceptsConversationBridge(lease)) request.result.complete(null)
            else scope.launch {
                var opened = false
                try {
                    val savedName = withContext(Dispatchers.IO) {
                        ensureActive()
                        if (!request.result.isActive) throw CancellationException("已取消文件保存")
                        check(vm.acceptsConversationBridge(lease)) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
                        context.contentResolver.openOutputStream(uri, "wt")?.use { output ->
                            opened = true
                            var offset = 0
                            while (offset < request.bytes.size) {
                                ensureActive(); if (!request.result.isActive) throw CancellationException("已取消文件保存"); check(vm.acceptsConversationBridge(lease)) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
                                val length = minOf(64 * 1024, request.bytes.size - offset)
                                output.write(request.bytes, offset, length); offset += length
                            }
                        } ?: error(UserText.get(R.string.claudex_msg_save_failed))
                        runCatching { context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null } }.getOrNull() ?: request.name
                    }
                    ensureActive()
                    if (!request.result.isActive || !vm.acceptsConversationBridge(lease)) throw CancellationException("已取消文件保存")
                    request.result.complete(savedName)
                } catch (cancelled: CancellationException) {
                    request.result.cancel(cancelled)
                    vm.error.value = if (opened) UserText.get(R.string.claudex_msg_save_cancelled_partial) else UserText.get(R.string.claudex_msg_save_cancelled_empty)
                    throw cancelled
                } catch (error: Exception) {
                    val failure = IllegalStateException(UserText.get(if (opened) R.string.claudex_msg_save_failed_partial else R.string.claudex_msg_save_failed), error)
                    if (!request.result.completeExceptionally(failure)) vm.error.value = failure.message
                }
            }
        } else if (request != null && activityResult.resultCode == android.app.Activity.RESULT_OK && activityResult.data?.data != null) {
            vm.error.value = UserText.get(R.string.claudex_msg_save_cancelled_empty)
        }
    } }

    val host = remember(lease) { object: ConversationNativeActions {
        override suspend fun confirm(title: String, message: String): Boolean {
            check(confirmation == null) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
            val request = ConversationConfirmation(title, message, CompletableDeferred())
            confirmation = request
            return try { request.result.await() } finally { if (confirmation === request) confirmation = null }
        }
        override fun copy(text: String) { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Claudex", text)) }
        override suspend fun download(name: String, mime: String, bytes: ByteArray): String? {
            val request = ConversationExport(name, mime, bytes, CompletableDeferred())
            exportReservation.reserve(request)
            var launched = false
            return try {
                exportLauncher.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name))
                launched = true
                request.result.await()
            } finally {
                if (!request.result.isCompleted) request.result.cancel()
                // An external picker may outlive a canceled bridge request. Reserve its slot until
                // that exact launch returns; a late result must never receive a newer file's bytes.
                if (!launched) exportReservation.abortBeforeLaunch(request)
            }
        }
        override fun navigate(route: String) { nav.navigate(route) { launchSingleTop = true } }
        override fun openLink(url: String) { context.startActivity(DeviceHandoff.viewIntent(url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        override fun share(text: String) {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            context.startActivity(Intent.createChooser(send, null))
        }
    } }
    val notifyPainted by rememberUpdatedState(onTranscriptPainted)
    val controller = remember(lease) { ConversationWebController(context, vm, lease, scope, host, { exportReservation.pending != null || confirmation != null }, { rendered ->
        acknowledged = true
        if (!rendered.slim) notifyPainted(rendered.id)
    }) { canvas.speechForeground(false); failure = it; notifyPainted(conversation.id) } }
    var overlayOpen by remember(controller) { mutableStateOf(false) }
    SideEffect {
        controller.overlayOpen = { overlayOpen = it }
        controller.setVisible(active)
    }
    // Mounted only while open so it is the newest Back callback and wins over navigation.
    if (overlayOpen && active) androidx.activity.compose.BackHandler { overlayOpen = false; controller.closeOverlay() }
    LaunchedEffect(canvas, controller, active, lifecycleState) { canvas.speechForeground(active && lifecycleState == Lifecycle.State.RESUMED) }
    DisposableEffect(controller) { onDispose { exportReservation.takeResult()?.result?.cancel(); confirmation?.result?.cancel(); confirmation = null; controller.dispose(); vm.endConversationBridge(lease) } }
    DisposableEffect(active, keepTranscript, controller) {
        if (active) vm.activateConversationBridge(lease)
        if (!keepTranscript) { exportReservation.takeResult()?.result?.cancel(); confirmation?.result?.cancel(); confirmation = null; controller.dispose(); vm.endConversationBridge(lease) }
        onDispose { }
    }
    val toolImages = remember(conversation) { conversation.turns.flatMap { it.items }.mapNotNull { item ->
        ImageToolSnapshotPolicy.request(item)?.takeIf { request -> item.generatedFiles.none { it.path == request.path && it.state == "ready" } }
    }.distinct().takeLast(12) }
    val clocks = remember(conversation) {
        conversation.turns.flatMap { it.items }.mapNotNull { item ->
            val input = item.rawJson?.let { runCatching { JSONObject(it).optJSONObject("input") }.getOrNull() } ?: return@mapNotNull null
            val plan = DeviceHandoff.clock(item.type, input, "android", true)
            if (plan !is DeviceHandoff.Clock.Alarm && plan !is DeviceHandoff.Clock.Timer) return@mapNotNull null
            item.id to plan
        }
    }
    var startedClocks by remember(conversation.id) { mutableStateOf(setOf<String>()) }
    LaunchedEffect(lease, clocks, active, lifecycleState) {
        if (!active || lifecycleState != Lifecycle.State.RESUMED) return@LaunchedEffect
        for ((id, plan) in clocks) {
            if (id in startedClocks) continue
            startedClocks = startedClocks + id
            val intent = DeviceHandoff.clockIntent(plan) ?: continue
            if (runCatching { context.startActivity(intent) }.isFailure) vm.error.value = if (plan is DeviceHandoff.Clock.Alarm) "Failed to set alarm." else "Failed to set timer on device."
        }
    }
    val calendarWrites = remember(conversation) {
        conversation.turns.flatMap { it.items }.mapNotNull { item ->
            if (item.type != "event_create_v1" && item.type != "event_delete_v0" && item.type != "event_update_v0") return@mapNotNull null
            val input = item.rawJson?.let { runCatching { JSONObject(it).optJSONObject("input") }.getOrNull() } ?: return@mapNotNull null
            item.id to (item.type to input)
        }
    }
    var reportedCalendar by remember(conversation.id) { mutableStateOf(setOf<String>()) }
    LaunchedEffect(lease, calendarWrites, active, lifecycleState) {
        if (!active || lifecycleState != Lifecycle.State.RESUMED) return@LaunchedEffect
        val done = context.getSharedPreferences("claudex-device-tools", android.content.Context.MODE_PRIVATE)
        for ((id, request) in calendarWrites) {
            if (done.getBoolean(id, false) || id in reportedCalendar) continue
            val message = when (request.first) {
                "event_create_v1" -> DeviceAccess.newEvents(request.second)?.let { DeviceCalendar.create(context, it) }
                "event_delete_v0" -> DeviceAccess.removedEvents(request.second)?.let { DeviceCalendar.delete(context, it) }
                else -> DeviceAccess.updatedEvents(request.second)?.let { DeviceCalendar.update(context, it) }
            } ?: continue
            reportedCalendar = reportedCalendar + id
            if (message.isEmpty()) done.edit().putBoolean(id, true).apply() else vm.error.value = message
        }
    }
    val calendarReads = remember(conversation) {
        conversation.turns.flatMap { it.items }.mapNotNull { item ->
            if (item.type != "event_search_v0" && item.type != "calendar_search_v0") return@mapNotNull null
            item.id to (item.type to item.rawJson?.let { runCatching { JSONObject(it).optJSONObject("input") }.getOrNull() })
        }
    }
    LaunchedEffect(lease, calendarReads, active, lifecycleState) {
        if (!active || lifecycleState != Lifecycle.State.RESUMED) return@LaunchedEffect
        val done = context.getSharedPreferences("claudex-device-tools", android.content.Context.MODE_PRIVATE)
        for ((id, request) in calendarReads) {
            if (done.getBoolean(id, false)) continue
            val message = if (request.first == "calendar_search_v0") DeviceCalendar.names(context) else {
                val input = request.second ?: continue
                val search = DeviceAccess.calendarSearch(input) ?: continue
                DeviceCalendar.search(context, search)
            } ?: continue
            if (message.isEmpty()) done.edit().putBoolean(id, true).apply() else vm.error.value = message
        }
    }
    val mapLinks = remember(conversation) {
        conversation.turns.flatMap { it.items }.mapNotNull { item ->
            if (item.type != "map_display_v0" && item.type != "places_map_display_v0") return@mapNotNull null
            val input = item.rawJson?.let { runCatching { JSONObject(it).optJSONObject("input") }.getOrNull() } ?: return@mapNotNull null
            DeviceAccess.mapLink(input)?.let { item.id to it }
        }
    }
    LaunchedEffect(lease, mapLinks, active, lifecycleState) {
        if (!active || lifecycleState != Lifecycle.State.RESUMED) return@LaunchedEffect
        val done = context.getSharedPreferences("claudex-device-tools", android.content.Context.MODE_PRIVATE)
        for ((id, link) in mapLinks) {
            if (done.getBoolean(id, false)) continue
            if (DeviceHandoff.openMap(context, link)) done.edit().putBoolean(id, true).apply()
            else vm.error.value = context.getString(R.string.map_display_tool_open_location_error)
        }
    }
    val locationReads = remember(conversation) {
        conversation.turns.flatMap { it.items }.mapNotNull { item ->
            if (item.type != "user_location_v0") return@mapNotNull null
            val input = item.rawJson?.let { runCatching { JSONObject(it).optJSONObject("input") }.getOrNull() } ?: return@mapNotNull null
            DeviceAccess.locationRequest(input)?.let { item.id to it }
        }
    }
    LaunchedEffect(lease, locationReads, active, lifecycleState) {
        if (!active || lifecycleState != Lifecycle.State.RESUMED) return@LaunchedEffect
        val done = context.getSharedPreferences("claudex-device-tools", android.content.Context.MODE_PRIVATE)
        for ((id, requested) in locationReads) {
            if (done.getBoolean(id, false)) continue
            when (DeviceLocation.take(context, requested)) {
                null -> done.edit().putBoolean(id, true).apply()
                "off" -> vm.error.value = context.getString(R.string.user_locate_tool_location_off)
                "denied" -> vm.error.value = context.getString(R.string.permission_location_system_disabled)
                else -> Unit
            }
        }
    }
    LaunchedEffect(lease, toolImages) {
        val repo = vm.repository as? RemoteRepository ?: return@LaunchedEffect
        if (!vm.acceptsConversationBridge(lease)) return@LaunchedEffect
        try { vm.api.withCurrentSession { repo.captureToolImages(conversation.id, toolImages) } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* An unavailable snapshot is never reported as loaded. */ }
    }
    val imageSources = remember(conversation) { conversation.turns.flatMap { it.attachments }.filter { it.kind == "image" }.distinctBy { it.id }.takeLast(24) }
    val generatedImages = remember(conversation) { conversation.turns.flatMap { it.items }.flatMap { it.generatedFiles }.filter { file ->
        val size = file.bytes
        file.state == "ready" && file.blob && file.mime in setOf("image/png", "image/jpeg", "image/webp") && size != null && size <= 2 * 1024 * 1024
    }.distinctBy { it.digest }.takeLast(12) }
    LaunchedEffect(lease, imageSources, generatedImages, document?.id, active) {
        if (!active || document != null) return@LaunchedEffect
        val previous = mediaState.value
        val imageIds = imageSources.mapTo(mutableSetOf()) { it.id }
        val fileDigests = generatedImages.mapNotNullTo(mutableSetOf()) { it.digest }
        val previews = previous.attachmentPreviews.filterKeys { it in imageIds }.toMutableMap()
        val generated = previous.generatedFileBytes.filterKeys { it in fileDigests }.toMutableMap()
        mediaState.value = ConversationMedia(previews.toMap(), generated.toMap())
        var budget = 8 * 1024 * 1024 - previews.values.sumOf { it.length } - generated.values.sumOf { it.length }
        try { vm.api.withCurrentSession {
            for (attachment in imageSources) {
                if (attachment.id in previews) continue
                ensureActive(); if (!vm.acceptsConversationBridge(lease) || budget <= 0) break
                try {
                    val local = vm.localFile(attachment.id)
                    val preview = if (local != null) withContext(Dispatchers.IO) {
                        val bitmap = decodePreviewBitmap(local.readBytes())
                        try { val bytes = java.io.ByteArrayOutputStream(); bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, bytes); "data:image/png;base64," + java.util.Base64.getEncoder().encodeToString(bytes.toByteArray()) } finally { bitmap.recycle() }
                    } else (vm.repository as? RemoteRepository)?.readAttachmentImage(attachment.id, thumbnail = true, maximumBytes = minOf(budget, 2 * 1024 * 1024) / 4 * 3 - 32)?.dataUrl()
                    if (preview != null && preview.length <= minOf(budget, 2 * 1024 * 1024) && Regex("^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$").matches(preview)) {
                        previews[attachment.id] = preview; budget -= preview.length
                        if (vm.acceptsConversationBridge(lease)) mediaState.value = ConversationMedia(previews.toMap(), generated.toMap())
                    }
                } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { /* Native file opening remains available. */ }
            }
            for (file in generatedImages) {
                if (file.digest in generated) continue
                ensureActive(); if (!vm.acceptsConversationBridge(lease) || budget <= 0) break
                try {
                    val bytes = vm.repository.readGeneratedFile(file)
                    val encoded = java.util.Base64.getEncoder().encodeToString(bytes)
                    val digest = file.digest
                    if (encoded.length <= budget && digest != null) {
                        generated[digest] = encoded; budget -= encoded.length
                        if (vm.acceptsConversationBridge(lease)) mediaState.value = ConversationMedia(previews.toMap(), generated.toMap())
                    }
                } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { /* Native digest-verified file preview remains available. */ }
            }
        } } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { /* Session loss clears this view; never retain cross-account media. */ }
    }
    val dark = theme == "dark" || (theme == "system" && isSystemInDarkTheme())
    PublishConversationPresentation(conversation, dark, snapshotState, sendingState, operationsState, mediaState, document, controller::offer)
    Column(modifier.fillMaxWidth()) {
        // A broken page is the official notice card with Retry (§4.10), never a raw error line.
        failure?.let { message -> NoticeCard(message, Modifier.padding(horizontal = 20.dp, vertical = 8.dp), stringResource(R.string.generic_retry), { failure = null; attempt++ }, icon = Anthropicons.warningCircle) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            // Mount at page entry, rather than waiting for the navigation animation to finish.
            val pageColor = Claude.colors.bg100.toArgb()
            key(canvas) { AndroidView(factory = { FrameLayout(it) }, update = { if (active) canvas.mount(it, controller, promotePending, pageColor) }, modifier = Modifier.fillMaxSize(), onRelease = { canvas.dispose() }) }
            // Until the page has drawn the conversation it stays covered in the page colour: a
            // WebView that has not painted yet shows black. A remote computer's session arrives
            // before its turns, so the cover does not wait for turns. Loading one that has turns
            // (§8): the centred Large spinner, no words (owner, 2026-10-05).
            if (!acknowledged && failure == null) Box(Modifier.fillMaxSize().background(Claude.colors.bg100), contentAlignment = Alignment.Center) {
                if (conversation.turns.isNotEmpty()) ClaudeSpinner(SpinnerSize.Large)
            }
        }
    }
    confirmation?.let { request -> ClaudeAlertDialog(onDismissRequest = { request.result.complete(false) }, title = { Text(request.title) }, text = { Text(request.message) }, confirmButton = { TextButton({ request.result.complete(true) }) { Text(stringResource(R.string.external_link_dialog_confirm)) } }, dismissButton = { TextButton({ request.result.complete(false) }) { Text(stringResource(R.string.generic_button_cancel)) } }) }
}

/** No JavaScriptInterface, cookies, tokens, remote code, generic RPC or file access. All callbacks are main-frame + exact-origin. */
internal class ConversationWebController(
    private val context: Context,
    private val vm: AppViewModel,
    private val lease: ConversationLease,
    private val scope: CoroutineScope,
    private val host: ConversationNativeActions,
    private val waitingForNativeUi: () -> Boolean,
    private val onApplied: (Conversation) -> Unit = {},
    private val failure: (String) -> Unit,
) {
    /** A sheet or menu of the transcript overlay is open; the screen's Back closes it ([closeOverlay]). */
    var overlayOpen: (Boolean) -> Unit = {}
    private var interactive = true
    fun setVisible(visible: Boolean) {
        if (interactive == visible || disposed) return
        interactive = visible
        handler.removeCallbacks(ackTimeout)
        if (visible) {
            if (inFlight != null) handler.postDelayed(ackTimeout, 10_000)
            scheduleFlush()
        }
    }
    fun closeOverlay() { if (!disposed) webView?.evaluateJavascript("window.__oxCloseOverlay&&window.__oxCloseOverlay();", null) }
    private val handler = Handler(Looper.getMainLooper())
    private var mediaFocus: AudioFocusRequest? = null
    private var readingNotice = false
    private val mediaFocusChanges = AudioManager.OnAudioFocusChangeListener { change ->
        if (DictationPolicy.lostMicrophone(change)) handler.post { pauseTranscriptMedia(); releaseTranscriptSpeaker() }
    }
    private var webView: WebView? = null
    private var disposed = false
    private var ready = false
    private var broken = false
    private var appliedRevision = 0L
    private var recoveredRejection = false
    private var pageStarted = false
    internal val documentReady get() = ready
    internal val canRetainCanvas get() = !broken
    internal var documentStartedAt: Long = SystemClock.uptimeMillis()
        private set
    private var pending: ConversationPresentation? = null
    private var inFlight: Pair<Long, ConversationPresentation>? = null
    private var applied: ConversationPresentation? = null
    private var revision = 0L
    private var lastSent = 0L
    private var flushScheduled = false
    private val jobs = mutableMapOf<String, Job>()
    private val seenRequests = linkedSetOf<String>()
    private val flush = Runnable { flushScheduled = false; flush() }
    private val ackTimeout = object: Runnable {
        override fun run() {
            // A system picker can hide/throttle the WebView while the person decides where to save.
            if (!disposed && waitingForNativeUi()) handler.postDelayed(this, 10_000)
            else fail(UserText.get(R.string.chat_load_failed_reload))
        }
    }
    private val readyTimeout = Runnable { if (!ready) fail(UserText.get(R.string.chat_load_failed_reload)) }

    @SuppressLint("SetJavaScriptEnabled")
    fun authorizesSpeech(candidate: WebView) = interactive && !disposed && !broken && webView === candidate && vm.acceptsConversationBridge(lease)
    fun createView(prepared: PreparedConversationCanvas?, pageColor: Int, installBridge: (WebView) -> Unit): WebView {
        check(webView == null && !disposed)
        val assets = WebViewAssetLoader.Builder().addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(context)).build()
        return (prepared?.view ?: WebView(context)).also { view ->
            webView = view
            if (prepared != null) { ready = prepared.ready; pageStarted = true; documentStartedAt = prepared.startedAt }
            // WebView WRAP_CONTENT forces the HTML layout height to zero even when Compose
            // measures a nonzero slot. Fill the native slot before loading the shared page.
            // An adopted view is still attached to FrameLayout: preserve its MarginLayoutParams.
            if (prepared == null) view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            view.setBackgroundColor(pageColor)
            view.settings.apply {
                javaScriptEnabled = true
                // The transcript's text follows the system font size, as the native views around it do.
                textZoom = ConversationTextScale.zoom(context.resources.configuration.fontScale)
                allowFileAccess = false; allowContentAccess = false
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = false
                @Suppress("DEPRECATION")
                allowUniversalAccessFromFileURLs = false
                domStorageEnabled = false; databaseEnabled = false
                javaScriptCanOpenWindowsAutomatically = false; setSupportMultipleWindows(false)
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                mediaPlaybackRequiresUserGesture = true
                cacheMode = WebSettings.LOAD_NO_CACHE
                textZoom = (context.resources.configuration.fontScale * 100).toInt().coerceIn(50, 300)
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
            view.webChromeClient = object: WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
                override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) { callback?.invoke(origin, false, false) }
                override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?) = false
            }
            view.webViewClient = object: WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
                    val uri = request?.url ?: return denied()
                    if (uri.scheme != "https" || uri.authority != "appassets.androidplatform.net" || uri.query != null || uri.fragment != null ||
                        !(uri.path == "/conversation/index.html" || uri.path?.startsWith("/conversation/assets/") == true || uri.path == TranscriptOverlay.FONT_PATH) || uri.path.orEmpty().contains("..")) return denied()
                    return assets.shouldInterceptRequest(uri) ?: denied()
                }
                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    if (pageStarted || url != CONVERSATION_ENTRY) fail(UserText.get(R.string.chat_load_failed_reload))
                    pageStarted = true
                }
                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) { if (request?.isForMainFrame == true) fail(UserText.get(R.string.chat_load_failed)) }
                override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: android.net.http.SslError?) { handler?.cancel(); fail(UserText.get(R.string.chat_load_failed)) }
                override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean { fail(UserText.get(R.string.chat_load_failed_reload)); return true }
            }
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                fail(UserText.get(R.string.claudex_msg_webview_update))
            } else {
                installBridge(view)
                if (!ready) handler.postDelayed(readyTimeout, (45_000 - (SystemClock.uptimeMillis() - documentStartedAt)).coerceAtLeast(0))
                if (prepared == null) view.loadUrl(CONVERSATION_ENTRY) else scheduleFlush()
            }
        }
    }
    internal fun receiveTranscriptMedia(sender: WebView, event: String?, origin: String, mainFrame: Boolean) {
        if (!authorizesSpeech(sender) || !ConversationBridgePolicy.acceptsFrame(origin, mainFrame, sender.url)) return
        when (event) {
            "play" -> if (!takeTranscriptSpeaker()) pauseTranscriptMedia()
            "speech" -> if (!takeTranscriptSpeaker()) pauseTranscriptMedia() else holdTranscriptSpeaker()
            "idle" -> {
                releaseTranscriptSpeaker()
                if (readingNotice) { readingNotice = false; SpeechPlayback.dismiss(sender.context) }
            }
        }
    }

    private fun takeTranscriptSpeaker(): Boolean {
        val audio = webView?.context?.getSystemService(AudioManager::class.java) ?: return false
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setOnAudioFocusChangeListener(mediaFocusChanges)
            .build()
        val granted = audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (granted) mediaFocus = request else audio.abandonAudioFocusRequest(request)
        return granted
    }

    private fun holdTranscriptSpeaker() {
        readingNotice = true
        SpeechPlayback.onStop = { handler.post { pauseTranscriptMedia() } }
        webView?.context?.let(SpeechPlayback::present)
    }

    private fun releaseTranscriptSpeaker() {
        val request = mediaFocus ?: return
        mediaFocus = null
        webView?.context?.getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(request)
    }

    private fun pauseTranscriptMedia() { if (!disposed) webView?.evaluateJavascript(TRANSCRIPT_MEDIA_PAUSE, null) }

    /** Official transcript look and chat behaviour (assets/transcript-official), once per document. */
    private fun installOverlay() {
        if (disposed || webView?.url != CONVERSATION_ENTRY) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            webView?.evaluateJavascript(TRANSCRIPT_MEDIA_WATCH, null)
        }
        webView?.evaluateJavascript(TranscriptOverlay.script(context), null)
    }
    private fun denied() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
    internal fun receiveFrame(sender: WebView, data: String?, sourceOrigin: String, mainFrame: Boolean) {
        if (!ConversationBridgePolicy.acceptsFrame(sourceOrigin, mainFrame, sender.url) || sender !== webView || disposed || broken || (interactive && !vm.acceptsConversationBridge(lease))) return
        if (data == null || data.length > ConversationBridgePolicy.MAX_MESSAGE_CHARS) return
        runCatching { receive(JSONObject(data)) }.onFailure { fail(UserText.get(R.string.chat_load_failed_reload)) }
    }
    fun offer(value: ConversationPresentation) {
        if (disposed || broken || !vm.acceptsConversationBridge(lease)) return
        if (!shouldQueueConversationPresentation(value, pending, inFlight?.second, applied)) return
        pending = value; scheduleFlush()
    }
    private fun scheduleFlush() {
        if (!interactive || !ready || disposed || inFlight != null || pending == null || flushScheduled) return
        flushScheduled = true
        handler.postDelayed(flush, (80L - (SystemClock.uptimeMillis() - lastSent)).coerceAtLeast(0))
    }
    private fun flush() {
        if (!interactive || disposed || !ready || inFlight != null || !vm.acceptsConversationBridge(lease)) return
        val value = pending ?: return
        pending = null
        val next = ++revision
        val delivery = conversationDelivery(applied, value, lease.id, appliedRevision, next)
        inFlight = next to value; lastSent = SystemClock.uptimeMillis()
        send(delivery.method, delivery.body)
        handler.postDelayed(ackTimeout, 10_000)
    }
    private fun receive(j: JSONObject) {
        require(j.opt("version") == 1)
        val type = j.getString("type")
        if (!interactive && type !in setOf("ready", "stateApplied", "stateRejected", "cancelRequest")) return
        if (type == "ready") { if (!ready) { ready = true; handler.removeCallbacks(readyTimeout); installOverlay(); scheduleFlush() }; return }
        // The overlay's reply Share (§4.8): text only, to the system share sheet the person then picks from.
        if (type == "nativeOverlay") { overlayOpen(j.optBoolean("open")); return }
        if (type == "nativeShare") { j.optString("text").takeIf { it.isNotBlank() }?.let { text -> runCatching { host.share(text.take(100_000)) } }; return }
        if (j.optString("sessionId") != lease.id) return
        when (type) {
            "stateApplied" -> {
                if (!isCurrentConversationAcknowledgement(j.optLong("revision", -1), inFlight?.first)) return
                val rendered = inFlight!!.second.conversation
                if (appliedRevision == 0L || applied?.conversation?.slim == true && !rendered.slim ||
                    applied?.conversation?.turns?.isEmpty() == true && rendered.turns.isNotEmpty()) {
                    val view = webView ?: return
                    view.postVisualStateCallback(inFlight!!.first, object : WebView.VisualStateCallback() {
                        override fun onComplete(requestId: Long) {
                            if (!disposed && !broken && webView === view) onApplied(rendered)
                        }
                    })
                }
                recoveredRejection = false; appliedRevision = inFlight!!.first; applied = inFlight?.second; inFlight = null; handler.removeCallbacks(ackTimeout); scheduleFlush()
            }
            "stateRejected" -> if (j.optLong("revision", -1) == inFlight?.first) {
                if (recoveredRejection) fail(UserText.get(R.string.chat_load_failed_reload))
                else {
                    recoveredRejection = true
                    pending = pending ?: inFlight?.second
                    inFlight = null; applied = null; appliedRevision = 0
                    handler.removeCallbacks(ackTimeout)
                    scheduleFlush()
                }
            }
            "cancelRequest" -> ConversationBridgePolicy.requestId(j)?.let { jobs.remove(it)?.cancel() }
            else -> {
                val requestId = ConversationBridgePolicy.requestId(j) ?: return
                // A bounded, never-evicting set prevents replaying a mutation in this document lease.
                if (requestId in seenRequests) return
                if (seenRequests.size >= 4096 || jobs.size >= 16) { result(requestId, false, error = UserText.get(R.string.claudex_msg_too_many_actions)); return }
                seenRequests += requestId
                val action = runCatching { ConversationBridgePolicy.parse(j) }.getOrElse { result(requestId, false, error = it.message ?: UserText.get(R.string.generic_error_something_went_wrong_try_again)); return }
                val job = scope.launch(start = CoroutineStart.LAZY) {
                    try {
                        val document = applied?.document ?: inFlight?.second?.document
                        val value = if (document == null) vm.dispatchConversationAction(lease, action, host) else vm.dispatchConversationDocumentAction(lease, document, action, host)
                        result(requestId, true, value)
                    }
                    catch (cancelled: CancellationException) { result(requestId, false, error = UserText.get(R.string.claudex_msg_action_stopped), cancelled = true, cancellationReason = conversationCancellationReason(cancelled)) }
                    catch (error: Exception) { result(requestId, false, error = error.message ?: UserText.get(R.string.error_unknown)) }
                    finally { jobs.remove(requestId) }
                }
                jobs[requestId] = job
                job.start()
            }
        }
    }
    private fun result(requestId: String, ok: Boolean, value: Any? = null, error: String? = null, cancelled: Boolean = false, cancellationReason: String? = null) {
        if (disposed || !vm.acceptsConversationBridge(lease)) return
        val reply = JSONObject().put("version", 1).put("sessionId", lease.id).put("requestId", requestId).put("ok", ok)
        if (value != null) reply.put("result", value)
        if (error != null) reply.put("error", error)
        if (cancelled) reply.put("cancelled", true)
        if (cancelled && cancellationReason == "userDeclined") reply.put("cancellationReason", cancellationReason)
        send("result", reply)
    }
    private fun send(method: String, body: JSONObject) {
        if (disposed || webView?.url != CONVERSATION_ENTRY || !vm.acceptsConversationBridge(lease)) return
        check(method in setOf("render", "renderDocument", "update", "result"))
        // JSON is quoted as data, never concatenated as executable source.
        webView?.evaluateJavascript("window.ClaudexConversation?.$method(JSON.parse(${JSONObject.quote(body.toString())}));", null)
    }
    private fun fail(message: String) { if (!disposed && !broken) { broken = true; ready = false; pending = null; inFlight = null; handler.removeCallbacksAndMessages(null); jobs.values.toList().forEach(Job::cancel); jobs.clear(); failure(message) } }
    fun dispose() {
        if (disposed) return
        if (readingNotice) { readingNotice = false; webView?.context?.let(SpeechPlayback::dismiss) }
        releaseTranscriptSpeaker()
        disposed = true; handler.removeCallbacksAndMessages(null); jobs.values.toList().forEach(Job::cancel); jobs.clear(); pending = null; inFlight = null; applied = null
        webView = null
    }
}

/** WebView text zoom (percent) for the system font scale; WebView ignores that scale by itself. */
internal object ConversationTextScale {
    fun zoom(fontScale: Float): Int = if (!fontScale.isFinite() || fontScale <= 0f) 100 else (fontScale * 100).roundToInt().coerceIn(80, 300)
}

/** The official chat-transcript overlay: CSS and behaviour over the pinned shared renderer, with its labels from the string catalogue. */
internal object TranscriptOverlay {
    const val FONT_PATH = "/transcript-official/JetBrainsMono.ttf"
    @Volatile private var assets: Pair<String, String>? = null
    private fun assets(context: Context): Pair<String, String> = assets ?: Pair(
        context.assets.open("transcript-official/overlay.css").bufferedReader().use { it.readText() },
        context.assets.open("transcript-official/overlay.js").bufferedReader().use { it.readText() },
    ).also { assets = it }
    fun strings(context: Context): JSONObject = JSONObject()
        .put("summary", context.getString(R.string.collapsed_tool_timeline_title))
        .put("share", context.getString(R.string.generic_share))
        .put("retry", context.getString(R.string.generic_retry))
        .put("copyMessage", context.getString(R.string.chat_message_bottom_sheet_menu_copy))
        .put("selectText", context.getString(R.string.chat_message_bottom_sheet_menu_select))
        .put("edit", context.getString(R.string.chat_message_bottom_sheet_menu_edit))
        .put("retryMessage", context.getString(R.string.chat_message_bottom_sheet_menu_retry))
    /** Configuration is JSON data; the script itself is the bundled asset. */
    fun script(context: Context): String {
        val (css, js) = assets(context)
        val config = JSONObject().put("css", css).put("strings", strings(context))
        return "window.__oxOfficialConfig=JSON.parse(${JSONObject.quote(config.toString())});\n$js"
    }
}
