@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.text.Spanned
import android.text.style.StyleSpan
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.math.sqrt

/*
 * The home/chat composer:
 * a floating card (24 dp corners, surface at 96 %, 0.5 dp hairline, 8 dp / 10 % shadow, max 768 dp),
 * the growing text field, the toolbar (+, model pill, mic, Send / Stop), the attachment strip, the
 * recording strip for dictation (tap and hold-to-talk), and the slots above the card: reply failure,
 * usage limit, waiting messages and dictation errors. The sheets live in ComposerSheets.kt.
 */

private const val CARD_MAX_WIDTH = 768

@Composable fun Composer(vm: AppViewModel, nav: NavHostController, conversationId: String? = null, projectId: String? = null, generating: Boolean = false, draftMode: Mode = Mode.CHAT, inPlace: Boolean = false) {
    LaunchedEffect(conversationId, projectId, draftMode) { vm.switchDraft(conversationId, projectId, draftMode) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val draft by vm.draft.collectAsStateWithLifecycle(); val attachments by vm.attachments.collectAsStateWithLifecycle(); val busy by vm.busy.collectAsStateWithLifecycle()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle(); val selected by vm.selectedModel.collectAsStateWithLifecycle(); val selectedProvider by vm.selectedProvider.collectAsStateWithLifecycle(); val effort by vm.effort.collectAsStateWithLifecycle()
    val queues by vm.queuedComposer.messages.collectAsStateWithLifecycle()
    val conversation = snapshot.conversations.find { it.id == conversationId }
    // A Code session sends with its own model (AppViewModel.send), so the pill names that one.
    val model = conversation?.takeIf { it.mode == Mode.CODE }?.let { c -> snapshot.models.find { it.id == c.model && it.providerId == c.providerId } }
        ?: snapshot.models.find { it.id == selected && (selectedProvider == null || it.providerId == selectedProvider) } ?: snapshot.models.find { it.id == snapshot.selectedModel } ?: snapshot.models.firstOrNull()
    val mode = conversation?.mode ?: draftMode
    val projectName = snapshot.projects.find { it.id == (conversation?.projectId ?: projectId) }?.name
    val incognito = ComposerFeaturePolicy.incognito(conversation?.rawJson)
    val queueBusy = queues[conversationId].orEmpty().any { it.state == QueuedState.SUBMITTING || it.state == QueuedState.SENDING }
    val hasDraft = draft.isNotBlank() || attachments.isNotEmpty()
    val action = ComposerPolicy.action(busy, generating, hasDraft)
    LaunchedEffect(conversationId, busy, generating, hasDraft, queueBusy) {
        if (BuildConfig.DEMO_MODE) android.util.Log.i("ClaudexComposer", "id=$conversationId busy=$busy running=$generating draft=$hasDraft queueBusy=$queueBusy")
    }
    var sheet by remember { mutableStateOf("") }

    val submit: () -> Unit = {
        vm.submitComposer(conversationId, projectId, pending = { pendingId -> if (!inPlace) nav.navigate("sending/$pendingId") { if (nav.currentBackStackEntry?.destination?.route == "home") popUpTo("home") { inclusive = true }; launchSingleTop = true } }) { id ->
            if (!inPlace && id != conversationId && nav.currentBackStackEntry?.destination?.route != "sending/{id}") nav.navigate("conversation/$id")
        }
    }

    // Dictation: the platform recogniser inside the app; the system dialog stays as the fallback on
    // devices whose recogniser cannot be bound directly.
    val dictation = remember { ComposerDictation(context.applicationContext, scope) }
    DisposableEffect(dictation) { onDispose { dictation.dispose() } }
    val language = remember(context) { context.resources.configuration.locales[0].toLanguageTag() }
    val recognizerAvailable = remember(dictation) { dictation.available }
    val onDictated: (String, Boolean) -> Unit = { text, send -> vm.draft.value = DictationPolicy.append(vm.draft.value, text); if (send) submit() }
    val systemDictation = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == android.app.Activity.RESULT_OK) result.data?.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let { onDictated(it, false) }
    }
    val microphone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) dictation.start(false, language, onDictated) else dictation.error = R.string.audio_permission_required
    }
    fun hasMicrophone() = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    fun startTapDictation() {
        if (!recognizerAvailable) {
            try { systemDictation.launch(android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, language)) }
            catch (_: android.content.ActivityNotFoundException) { dictation.error = R.string.claudex_stt_unavailable }
            return
        }
        if (hasMicrophone()) dictation.start(false, language, onDictated) else microphone.launch(Manifest.permission.RECORD_AUDIO)
    }
    val holdToTalk = recognizerAvailable && !busy
    val haptics = LocalHapticFeedback.current
    fun startHold(): Boolean {
        if (!hasMicrophone()) { microphone.launch(Manifest.permission.RECORD_AUDIO); return false }
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        dictation.start(true, language, onDictated)
        return dictation.active
    }

    val hint = ComposerPolicy.hint(conversationId != null, mode, projectName, recognizerAvailable, sending = busy && draft.isEmpty())
    val placeholder = if (hint.arg != null) stringResource(hint.id, hint.arg) else stringResource(hint.id)

    Column(Modifier.fillMaxWidth().imePadding().padding(bottom = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        val slot = Modifier.padding(horizontal = 16.dp).widthIn(max = CARD_MAX_WIDTH.dp).fillMaxWidth()
        ComposerFailureNotice(vm, conversationId, slot.padding(bottom = 8.dp))
        UsageLimitBanner(vm, nav, conversationId, generating, slot.padding(bottom = 8.dp))
        WaitingMessagesBar(vm, conversationId, slot.padding(bottom = 8.dp)) { sheet = "waiting" }
        AnimatedVisibility(dictation.error != null, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            dictation.error?.let { DictationError(it, slot.padding(horizontal = 8.dp).padding(bottom = 8.dp)) }
        }
        ComposerCard(Modifier.padding(horizontal = 8.dp).widthIn(max = CARD_MAX_WIDTH.dp).fillMaxWidth(), dashed = incognito) {
            if (attachments.isNotEmpty()) AttachmentStrip(attachments, onOpen = { nav.navigate("attachment/$it") }, onRemove = vm::removeAttachment)
            val fieldAlpha by animateFloatAsState(if (dictation.active) 0f else 1f, ClaudeMotion.springCalm(), label = "textfield-alpha")
            AnimatedVisibility(!dictation.active, enter = expandVertically(ClaudeMotion.springCalm()), exit = shrinkVertically(ClaudeMotion.springCalm())) {
                ComposerTextField(draft, { vm.draft.value = it; dictation.error = null }, placeholder, Modifier.alpha(fieldAlpha))
            }
            Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).heightIn(min = if (attachments.isEmpty()) 48.dp else 0.dp)
                .holdToTalk(holdToTalk && !dictation.active, dictation, ::startHold), contentAlignment = Alignment.CenterStart) {
                AnimatedContent(dictation.mode, transitionSpec = { fadeIn(ClaudeMotion.springCalm()) togetherWith fadeOut(ClaudeMotion.springCalm()) }, label = "ChatInputComposerSwap") { current ->
                    when (current) {
                        DictationMode.Off -> NormalToolbar(
                            modelName = model?.name, effortLabel = model?.takeIf { it.efforts.isNotEmpty() }?.let { ComposerPolicy.effortLabel(effort) }?.let { stringResource(it) },
                            modelEnabled = snapshot.models.isNotEmpty(), action = action, busy = busy,
                            sendEnabled = busy || (hasDraft && !queueBusy), plusEnabled = !busy,
                            onPlus = { sheet = "attachment" }, onModel = { sheet = "model" },
                            onMic = ::startTapDictation, onAction = submit)
                        DictationMode.Tap -> TapDictationToolbar(dictation)
                        DictationMode.Hold -> HoldDictationToolbar(dictation)
                    }
                }
            }
        }
    }
    when (sheet) {
        "model" -> ModelSelectorSheet(vm, { sheet = "" }, conversation = conversation?.takeIf { it.mode == Mode.CODE })
        "attachment" -> AddToChatSheet(vm, conversationId, mode) { sheet = "" }
        "waiting" -> conversationId?.let { WaitingMessagesSheet(vm, it) { sheet = "" } }
    }
}

// ───────────────────────────── Card and field ─────────────────────────────

/** Floating composer card: 24 dp, surface at 96 %, 0.5 dp hairline (dashed 1 dp in an incognito chat),
 *  shadow 8 dp / 10 % / y 2 dp, min height 48, vertical content padding 8. */
@Composable private fun ComposerCard(modifier: Modifier, dashed: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val c = Claude.colors
    val shape = Claude.shapes.r24
    val density = LocalDensity.current
    Column(modifier
        .shadow(8.dp, shape, clip = false, ambientColor = Color.Black.copy(alpha = .10f), spotColor = Color.Black.copy(alpha = .10f))
        .clip(shape).background(c.bg000.copy(alpha = .96f))
        .then(if (dashed) Modifier.drawBehind {
            val stroke = with(density) { 1.dp.toPx() }; val dash = with(density) { 5.dp.toPx() }; val r = with(density) { 24.dp.toPx() }
            drawRoundRect(c.border300, topLeft = Offset(stroke / 2, stroke / 2), size = Size(size.width - stroke, size.height - stroke), cornerRadius = CornerRadius(r),
                style = Stroke(stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash))))
        } else Modifier.border(0.5.dp, c.border300, shape))
        .heightIn(min = 48.dp).padding(vertical = 8.dp), content = content)
}

/** Text field: 17 sp, grows to 10 lines then scrolls, 13 dp from the card edge, Return = new line. */
@Composable private fun ComposerTextField(value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val c = Claude.colors
    Row(modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Box(Modifier.weight(1f).padding(horizontal = 5.dp).heightIn(min = 36.dp), contentAlignment = Alignment.CenterStart) {
            BasicTextField(value, onValueChange, Modifier.fillMaxWidth().padding(vertical = 8.dp).semantics { contentDescription = placeholder },
                textStyle = Claude.type.body17.copy(color = c.text100), cursorBrush = SolidColor(c.text500), maxLines = 10,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (value.isEmpty()) Text(placeholder, style = Claude.type.body17, color = c.text500, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        inner()
                    }
                })
        }
    }
}

// ───────────────────────────── Toolbar ─────────────────────────────

@Composable private fun NormalToolbar(modelName: String?, effortLabel: String?, modelEnabled: Boolean, action: ComposerAction,
    busy: Boolean, sendEnabled: Boolean, plusEnabled: Boolean, onPlus: () -> Unit, onModel: () -> Unit,
    onMic: () -> Unit, onAction: () -> Unit) {
    val c = Claude.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            ComposerRoundButton(AppGlyphs.add, stringResource(R.string.chat_input_add_to_chat), onPlus, c.tileFill, c.text100, enabled = plusEnabled)
            ModelPill(modelName, effortLabel, modelEnabled, onModel)
        }
        Row(Modifier.padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            val micEnd by animateDpAsState(if (action == ComposerAction.None) 8.dp else 0.dp, ClaudeMotion.springCalm(), label = "mic end padding")
            Box(Modifier.padding(end = micEnd)) {
                ComposerRoundButton(AppGlyphs.microphone, stringResource(R.string.chat_input_start_speech_input), onMic, c.tileFill, c.text300, enabled = !busy)
            }
            Box {
                ToolbarItem(action == ComposerAction.Send) { SendButton(busy, sendEnabled, onAction) }
                ToolbarItem(action == ComposerAction.Stop) {
                    ComposerRoundButton(AppGlyphs.stop, stringResource(R.string.chat_input_stop_button_content_description), onAction, c.tileFill, c.text100)
                }
            }
        }
    }
}

/** Show/hide of every toolbar item: scale from 0.01 + fade, spring(1, 400). */
@Composable private fun ToolbarItem(visible: Boolean, content: @Composable () -> Unit) {
    AnimatedVisibility(visible, enter = scaleIn(ClaudeMotion.springCalm(), initialScale = .01f) + fadeIn(ClaudeMotion.springCalm()),
        exit = scaleOut(ClaudeMotion.springCalm(), targetScale = 0f) + fadeOut(ClaudeMotion.springCalm())) { content() }
}

/** Round composer button: 48 dp touch target, 36 dp filled circle, 20 dp glyph, tooltip on long press, 0.4 alpha when disabled. */
@Composable private fun ComposerRoundButton(icon: ImageVector, description: String, onClick: () -> Unit, fill: Color, tint: Color,
    enabled: Boolean = true, content: (@Composable () -> Unit)? = null) {
    TooltipBox(TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above), tooltip = { PlainTooltip { Text(description) } }, state = rememberTooltipState()) {
        Box(Modifier.size(48.dp).clip(CircleShape).clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = description }.alpha(if (enabled) 1f else .4f),
            contentAlignment = Alignment.Center) {
            Box(Modifier.size(36.dp).background(fill, CircleShape), contentAlignment = Alignment.Center) {
                if (content != null) content() else Icon(icon, null, Modifier.size(20.dp), tint = tint)
            }
        }
    }
}

/** Send: accent circle, white arrow; while attachments upload a 24 dp spinner (tap stops waiting). */
@Composable private fun SendButton(uploading: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = Claude.colors
    val description = stringResource(if (uploading) R.string.chat_input_send_button_waiting_for_uploads else R.string.chat_input_send_button_content_description)
    val fill = if (enabled) c.accentMain100 else c.text100.copy(alpha = .10f)
    val tint = if (enabled) c.onColor100 else c.text100.copy(alpha = .38f)
    TooltipBox(TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above), tooltip = { PlainTooltip { Text(description) } }, state = rememberTooltipState()) {
        Box(Modifier.size(48.dp).clip(CircleShape).clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = description },
            contentAlignment = Alignment.Center) {
            Box(Modifier.size(36.dp).background(fill, CircleShape), contentAlignment = Alignment.Center) {
                if (uploading) CircularProgressIndicator(Modifier.size(24.dp), color = c.onColor100, strokeWidth = 2.dp)
                else Icon(AppGlyphs.arrowUp, null, Modifier.size(20.dp), tint = tint)
            }
        }
    }
}

/** Model pill: pill on the neutral fill, min 36 dp, 16 dp sides, name 13 sp + effort 13 sp secondary. */
@Composable private fun ModelPill(name: String?, secondary: String?, enabled: Boolean, onClick: () -> Unit) {
    val c = Claude.colors
    val configuration = LocalConfiguration.current
    val maxWidth = ComposerPolicy.pillMaxWidth(configuration.screenWidthDp, LocalDensity.current.fontScale).dp
    val description = if (name != null) stringResource(R.string.model_selector_chip_a11y, listOfNotNull(name, secondary).joinToString(" · ")) else stringResource(R.string.model_selector_chip_a11y_empty)
    Row(Modifier.padding(vertical = 4.dp).widthIn(max = maxWidth).clip(CircleShape).background(c.tileFill)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics(mergeDescendants = true) { contentDescription = description }
        .heightIn(min = 36.dp).padding(horizontal = 16.dp).alpha(if (enabled) 1f else .4f),
        horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(name ?: stringResource(R.string.claudex_model_none), Modifier.weight(1f, fill = false), style = Claude.type.body13, color = c.text100, maxLines = 1, overflow = TextOverflow.Ellipsis)
        secondary?.let { Text(it, style = Claude.type.body13, color = c.text300, maxLines = 1) }
    }
}

// ───────────────────────────── Attachment strip ─────────────────────────────

/** Strip above the field: 96 dp tiles, 16 dp corners, remove button top-end. */
@Composable private fun AttachmentStrip(items: List<Attachment>, onOpen: (String) -> Unit, onRemove: (String) -> Unit) {
    LazyRow(Modifier.fillMaxWidth().padding(bottom = 4.dp), contentPadding = PaddingValues(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(items, key = { it.id }) { item -> AttachmentTile(item, { onOpen(item.id) }, { onRemove(item.id) }) }
    }
}

@Composable private fun AttachmentTile(item: Attachment, onOpen: () -> Unit, onRemove: () -> Unit) {
    val c = Claude.colors
    val image = item.kind == "image" || item.mime.startsWith("image/")
    val thumbnail by produceState<ImageBitmap?>(null, item.path, image) {
        if (image) value = withContext(Dispatchers.IO) { decodeThumbnail(item.path, 192) }
    }
    val description = stringResource(if (image) R.string.file_preview_image_content_description else R.string.file_preview_file_content_description)
    Box(Modifier.size(96.dp)) {
        Box(Modifier.matchParentSize().clip(Claude.shapes.card).background(if (image) c.bg100 else c.bg300)
            .clickable(role = Role.Button, onClick = onOpen).semantics { contentDescription = "$description, ${item.name}" }) {
            val bitmap = thumbnail
            if (bitmap != null) Image(bitmap, null, Modifier.matchParentSize(), contentScale = ContentScale.Crop)
            else if (!image) Text(item.name, Modifier.padding(8.dp), style = Claude.type.body11, color = c.text300, maxLines = 3, overflow = TextOverflow.Ellipsis)
            ComposerPolicy.extension(item.name)?.takeIf { !image }?.let { ext ->
                Surface(Modifier.align(Alignment.BottomStart).padding(8.dp), shape = Claude.shapes.r8, color = c.bg000, border = BorderStroke(0.5.dp, c.border200)) {
                    Text(ext, Modifier.padding(horizontal = 6.dp, vertical = 2.dp), style = Claude.type.body11Strong, color = c.text300, maxLines = 1)
                }
            }
        }
        val remove = stringResource(R.string.chat_input_image_remove_button_content_description)
        Box(Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 6.dp).size(24.dp).clip(CircleShape).background(c.text100)
            .clickable(role = Role.Button, onClick = onRemove).semantics { contentDescription = remove }, contentAlignment = Alignment.Center) {
            Icon(AppGlyphs.x, null, Modifier.size(16.dp), tint = c.bg000)
        }
    }
}

private fun decodeThumbnail(path: String, target: Int): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= target && bounds.outHeight / (sample * 2) >= target) sample *= 2
    BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}.getOrNull()

// ───────────────────────────── Dictation strip ─────────────────────────────

/** Long-press on the empty toolbar starts hold-to-talk: slide onto the cancel target to cancel, release elsewhere to send. */
@Composable private fun Modifier.holdToTalk(enabled: Boolean, dictation: ComposerDictation, start: () -> Boolean): Modifier {
    // Keyed on the controller only: the gesture must survive the toolbar swapping to the hold strip.
    val allowed by rememberUpdatedState(enabled)
    val begin by rememberUpdatedState(start)
    return pointerInput(dictation) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = true)
            if (!allowed) return@awaitEachGesture
            val long = awaitLongPressOrCancellation(down.id) ?: return@awaitEachGesture
            if (!begin()) return@awaitEachGesture
            val pointer = long.id
            while (true) {
                val event = awaitPointerEvent()
                val change = event.changes.firstOrNull { it.id == pointer } ?: break
                change.consume()
                dictation.holdCancel = change.position.x < size.width * .3f
                if (!change.pressed) break
            }
            if (dictation.holdCancel) dictation.cancel() else dictation.stop(send = true)
        }
    }
}

/** Tap dictation: Cancel · waveform / Transcribing… · Stop dictation · Send dictation. */
@Composable private fun TapDictationToolbar(dictation: ComposerDictation) {
    val c = Claude.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        DictationButton(AppGlyphs.x, stringResource(R.string.generic_button_cancel), c.tileFill, c.text100, true) { dictation.cancel() }
        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
            AnimatedContent(dictation.transcribing, label = "speech-toolbar-center") { transcribing ->
                if (transcribing) Text(stringResource(R.string.stt_input_transcribing), style = Claude.type.body13, color = c.text300)
                else Waveform(dictation.bars, Modifier.fillMaxWidth().height(25.dp))
            }
        }
        DictationButton(AppGlyphs.stopFilled, stringResource(R.string.stt_input_stop_dictation), c.tileFill, c.text100, !dictation.transcribing) { dictation.stop(send = false) }
        DictationButton(AppGlyphs.arrowUp, stringResource(R.string.stt_input_send_dictation), c.accentMain100, c.onColor100, !dictation.transcribing) { dictation.stop(send = true) }
    }
}

/** Hold-to-talk: cancel target · "Release to …" over the waveform · send target. */
@Composable private fun HoldDictationToolbar(dictation: ComposerDictation) {
    val c = Claude.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        HoldTarget(AppGlyphs.x, dictation.holdCancel, c.danger100)
        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
            AnimatedContent(dictation.transcribing, label = "speech-toolbar-center") { transcribing ->
                if (transcribing) Text(stringResource(R.string.stt_input_transcribing), style = Claude.type.body13, color = c.text300)
                else Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(if (dictation.holdCancel) R.string.stt_release_to_cancel else R.string.stt_release_to_send), style = Claude.type.body13, color = c.text500, maxLines = 1)
                    Waveform(dictation.bars, Modifier.fillMaxWidth().height(25.dp).graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                        .drawWithContent { drawContent(); drawRect(Brush.horizontalGradient(0f to Color.Transparent, .2f to Color.Black), blendMode = BlendMode.DstIn) })
                }
            }
        }
        HoldTarget(AppGlyphs.arrowUp, !dictation.holdCancel, c.accentMain100)
    }
}

/** 36 dp dictation button: colours at 38 % when disabled. */
@Composable private fun DictationButton(icon: ImageVector, description: String, fill: Color, tint: Color, enabled: Boolean, onClick: () -> Unit) {
    Box(Modifier.size(36.dp).clip(CircleShape).background(if (enabled) fill else fill.copy(alpha = fill.alpha * .38f))
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = description }, contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(20.dp), tint = if (enabled) tint else tint.copy(alpha = .38f))
    }
}

/** Hold target: 36 dp circle, 1.2× while the finger is over it (spring 1, 1500); idle sunken fill and tertiary glyph. */
@Composable private fun HoldTarget(icon: ImageVector, active: Boolean, activeColor: Color) {
    val c = Claude.colors
    val scale by animateFloatAsState(if (active) 1.2f else 1f, spring(Spring.DampingRatioNoBouncy, 1500f), label = "hold-target-scale")
    val bg by animateColorAsState(if (active) activeColor else c.bg300, label = "hold-target-bg")
    Box(Modifier.size(36.dp).scale(scale).clip(CircleShape).background(bg), contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(20.dp), tint = if (active) c.onColor100 else c.text500)
    }
}

/** Waveform: 3 dp bars 3 dp apart, newest at the right, elliptic fade on the three outer bars, 1.5 dp corners. */
@Composable private fun Waveform(bars: List<Float>, modifier: Modifier) {
    val c = Claude.colors
    Canvas(modifier) {
        val bar = 3.dp.toPx(); val pitch = 6.dp.toPx(); val min = 3.dp.toPx(); val radius = CornerRadius(1.5.dp.toPx())
        val visible = (size.width / pitch).toInt().coerceAtLeast(1)
        val shown = bars.takeLast(visible)
        shown.forEachIndexed { index, level ->
            val fromRight = shown.size - 1 - index
            val x = size.width - (fromRight + 1) * pitch + (pitch - bar) / 2
            val edge = minOf(fromRight, visible - 1 - fromRight)
            val e = if (edge < 3) (3 - edge) / 4f else 0f
            val h = ((if (level > 0f) level else 0f) * (size.height - min) + min) * sqrt(1f - e * e)
            drawRoundRect(if (level > 0f) c.text100 else c.text300, Offset(x, (size.height - h) / 2), Size(bar, h), radius)
        }
    }
}

/** Dictation error above the card: 17 sp italic, secondary colour, the `<b>` part bold, up to 3 lines. */
@Composable private fun DictationError(id: Int, modifier: Modifier) {
    val text = LocalContext.current.resources.getText(id)
    Text(styled(text), modifier, style = Claude.type.body17.copy(fontStyle = FontStyle.Italic), color = Claude.colors.text300, maxLines = 3, overflow = TextOverflow.Ellipsis)
}

private fun styled(text: CharSequence): AnnotatedString = buildAnnotatedString {
    append(text.toString())
    (text as? Spanned)?.getSpans(0, text.length, StyleSpan::class.java)?.forEach { span ->
        if (span.style == android.graphics.Typeface.BOLD) addStyle(SpanStyle(fontWeight = FontWeight.Bold), text.getSpanStart(span), text.getSpanEnd(span))
    }
}

// ───────────────────────────── Slots above the card ─────────────────────────────

/** Usage card: sunken fill, 16 dp corners, 12 dp padding; title 13/550, subtitle 11 secondary, small action. */
@Composable private fun UsageLimitBanner(vm: AppViewModel, nav: NavHostController, conversationId: String?, generating: Boolean, modifier: Modifier) {
    if (BuildConfig.DEMO_MODE) return
    val remote = vm.repository as? RemoteRepository ?: return
    var plan by remember { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(remote, conversationId, generating) {
        if (generating) return@LaunchedEffect
        plan = try { remote.rpc("planUsage", true) as? JSONObject } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { plan }
    }
    val banner = UsageBannerPolicy.banner(plan) ?: return
    val c = Claude.colors
    val context = LocalContext.current
    val subtitle = banner.resetsAt?.let { at ->
        val time = android.text.format.DateFormat.getTimeFormat(context).format(java.util.Date(at))
        val sameDay = android.text.format.DateUtils.isToday(at)
        if (sameDay) stringResource(R.string.composer_rate_limit_resets_at_time, time)
        else stringResource(R.string.composer_rate_limit_resets_day_at_time,
            java.text.SimpleDateFormat(android.text.format.DateFormat.getBestDateTimePattern(context.resources.configuration.locales[0], "EEE"), context.resources.configuration.locales[0]).format(java.util.Date(at)), time)
    } ?: if (banner.reached) stringResource(R.string.composer_rate_limit_try_again_later) else stringResource(R.string.composer_usage_percent_used, banner.percent)
    Surface(modifier, shape = Claude.shapes.card, color = c.bg300) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stringResource(if (banner.reached) R.string.composer_rate_limit_reached else R.string.composer_rate_limit_approaching), style = Claude.type.body13Strong, color = c.text100)
                Text(subtitle, style = Claude.type.body11, color = c.text300)
            }
            ClaudeButton(stringResource(R.string.composer_usage_title), { nav.navigate("usage") }, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
        }
    }
}

/** Waiting messages (official `chat_waiting_*`): "N waiting · Send now"; the count opens the waiting-messages sheet. */
@Composable private fun WaitingMessagesBar(vm: AppViewModel, conversationId: String?, modifier: Modifier, onShowAll: () -> Unit) {
    val queues by vm.queuedComposer.messages.collectAsStateWithLifecycle()
    val id = conversationId ?: return
    val entries = queues[id].orEmpty()
    if (entries.isEmpty()) return
    val c = Claude.colors
    val next = entries.firstOrNull { it.state == QueuedState.QUEUED && it.error == null }
    val showAll = stringResource(R.string.chat_waiting_messages_show_all)
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(pluralStringResource(R.plurals.chat_waiting_messages_count, entries.size, entries.size),
            Modifier.clip(Claude.shapes.r8).clickable(role = Role.Button, onClick = onShowAll).semantics { contentDescription = showAll }.padding(horizontal = 4.dp, vertical = 6.dp),
            style = Claude.type.body13, color = c.text500)
        if (next != null) {
            Text("·", Modifier.padding(horizontal = 4.dp), style = Claude.type.body13, color = c.text500)
            Text(stringResource(R.string.chat_waiting_message_menu_send_now),
                Modifier.clip(Claude.shapes.r8).clickable(role = Role.Button) { vm.queuedComposer.sendNow(id, next.id) }.padding(horizontal = 4.dp, vertical = 6.dp),
                style = Claude.type.body13Strong, color = c.text100)
        }
    }
}
