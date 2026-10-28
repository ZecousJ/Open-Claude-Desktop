@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.claudex.core.*
import java.io.File

/*
 * Composer sheets: Add to chat, Select model
 * (with More models and Effort pages) and the waiting-messages sheet. Rows use the official grouped
 * sheet rows.
 */

// ───────────────────────────── Add to chat ─────────────────────────────

/** Add to chat: Camera / Photos / Files tiles and the limit notice. */
@Composable fun AddToChatSheet(vm: AppViewModel, conversationId: String?, mode: Mode, dismiss: () -> Unit) {
    val context = LocalContext.current
    val attachments by vm.attachments.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val remaining = (AttachmentPolicy.MAX_COUNT - attachments.size).coerceAtLeast(0)
    val blocked = remaining == 0 || busy
    var cameraFile by remember { mutableStateOf<Uri?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved -> cameraFile?.takeIf { saved }?.let { vm.pickMany(listOf(it)) }; dismiss() }
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> uri?.let { vm.pickMany(listOf(it)) }; dismiss() }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(maxOf(2, AttachmentPolicy.MAX_COUNT))) { uris -> vm.pickMany(uris.take(remaining)); dismiss() }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> vm.pickMany(uris.take(remaining)); dismiss() }
    val hasCamera = remember(context) { context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }

    ClaudeModalBottomSheet(onDismissRequest = dismiss) {
        ClaudeSheetHeader(stringResource(if (mode == Mode.CODE) R.string.chat_options_add_to_session else R.string.chat_options_add_to_chat))
        Column(Modifier.verticalScroll(rememberScrollState()).padding(top = 12.dp).navigationBarsPadding().padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                UploadTile(AppGlyphs.camera, stringResource(R.string.upload_camera_button), enabled = hasCamera && !blocked) {
                    runCatching {
                        val folder = File(context.cacheDir, "camera").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
                        val stamp = java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.ROOT).format(java.util.Date())
                        val uri = FileProvider.getUriForFile(context, "${context.packageName}.composer", File(folder, "IMG_$stamp.jpg"))
                        cameraFile = uri; camera.launch(uri)
                    }.onFailure { vm.error.value = it.message }
                }
                UploadTile(AppGlyphs.image, stringResource(R.string.upload_photos_button), enabled = !blocked) {
                    val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    if (remaining > 1) photos.launch(request) else photo.launch(request)
                }
                UploadTile(AppGlyphs.fileUpload, stringResource(R.string.upload_file_button), enabled = !blocked) { files.launch(arrayOf("*/*")) }
            }
            if (remaining == 0) Text(stringResource(R.string.chat_input_attachment_limit_reached_toast, AttachmentPolicy.MAX_COUNT), Modifier.padding(horizontal = 12.dp),
                style = Claude.type.body15, color = Claude.colors.text500)
        }
    }
}

/** Upload tile: weight 1, min 104 dp, 16 dp corners, surface fill; 10 % disc around a 24 dp glyph; 15 sp label. */
@Composable private fun RowScope.UploadTile(icon: ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = Claude.colors
    val content = if (enabled) c.text100 else c.text500
    Column(Modifier.weight(1f).fillMaxHeight().heightIn(min = 104.dp).clip(Claude.shapes.card).background(c.bg000)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.clip(CircleShape).background(content.copy(alpha = .10f)).padding(10.dp)) { Icon(icon, null, Modifier.size(24.dp), tint = content) }
        Text(label, style = Claude.type.body15, color = content, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

// ───────────────────────────── Select model ─────────────────────────────

private enum class ModelPage { Select, More, Effort }

/** Model selector (`ModelSelectorBottomSheetDestination`): Select model → More models / Effort pages. */
@Composable fun ModelSelectorSheet(vm: AppViewModel, dismiss: () -> Unit, conversation: Conversation? = null) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val selected by vm.selectedModel.collectAsStateWithLifecycle(); val selectedProvider by vm.selectedProvider.collectAsStateWithLifecycle()
    val effort by vm.effort.collectAsStateWithLifecycle()
    // A Code session's own model (menu "Change model", and the composer's pill inside the session); otherwise the new-chat choice.
    val current = conversation?.let { c -> snapshot.models.find { it.id == c.model && it.providerId == c.providerId } }
        ?: snapshot.models.find { it.id == selected && (selectedProvider == null || it.providerId == selectedProvider) } ?: vm.model()
    val choices = ModelMenuPolicy.choices(snapshot.models, current)
    val vendors = snapshot.models.map { ModelMenuPolicy.vendor(it.id) }.distinctBy { it.id }
    var vendor by remember { mutableStateOf(ModelMenuPolicy.vendor(current?.id.orEmpty()).id) }
    val shownVendor = vendor.takeIf { id -> vendors.any { it.id == id } } ?: vendors.firstOrNull()?.id
    fun ofVendor(list: List<ModelOption>) = list.filter { vendors.size < 2 || ModelMenuPolicy.vendor(it.id).id == shownVendor }
    var page by remember { mutableStateOf(ModelPage.Select) }
    ClaudeModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        AnimatedContent(page, transitionSpec = { fadeIn(ClaudeMotion.fadeIn()) togetherWith fadeOut(ClaudeMotion.fadeOut()) }, label = "model-sheet-page") { shown ->
            Column {
                when (shown) {
                    ModelPage.Select -> ClaudeSheetHeader(stringResource(R.string.chat_options_select_model))
                    ModelPage.More -> SheetPageHeader(stringResource(R.string.chat_options_more_models)) { page = ModelPage.Select }
                    ModelPage.Effort -> SheetPageHeader(stringResource(R.string.chat_options_effort)) { page = ModelPage.Select }
                }
                Column(Modifier.verticalScroll(rememberScrollState()).padding(top = 12.dp).navigationBarsPadding().padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    when (shown) {
                        ModelPage.Select, ModelPage.More -> {
                            if (snapshot.models.isEmpty()) Text(stringResource(R.string.claudex_model_none), Modifier.padding(horizontal = 24.dp), style = Claude.type.body15, color = Claude.colors.text500)
                            // Claudex serves several makers' models: a chip row narrows the list to one maker.
                            if (vendors.size > 1) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                vendors.forEach { maker -> ClaudeChip(maker.name, { vendor = maker.id }, selected = shownVendor == maker.id, compact = true) }
                            }
                            val rows = ofVendor(if (shown == ModelPage.More) choices.more else choices.quick)
                            if (rows.isNotEmpty()) SettingsGroup {
                                rows.forEach { model ->
                                    ModelRow(model, current?.id == model.id && current.providerId == model.providerId) {
                                        if (conversation != null) vm.changeConversationModel(conversation, model) { dismiss() }
                                        else { vm.selectModel(model); if (shown == ModelPage.More) page = ModelPage.Select }
                                    }
                                }
                            }
                            if (shown == ModelPage.Select && current?.efforts?.isNotEmpty() == true) SettingsGroup {
                                SettingsRow(stringResource(R.string.chat_options_effort), { page = ModelPage.Effort }, trailing = {
                                    ComposerPolicy.effortLabel(effort)?.let { Text(stringResource(it), style = Claude.type.body15, color = Claude.colors.text500) }
                                    Icon(AppGlyphs.caretRight, null, Modifier.size(20.dp), tint = Claude.colors.text500)
                                })
                            }
                            if (shown == ModelPage.Select && ofVendor(choices.more).isNotEmpty()) SettingsGroup {
                                SettingsRow(stringResource(R.string.chat_options_more_models), { page = ModelPage.More }, trailing = {
                                    Icon(AppGlyphs.caretRight, null, Modifier.size(20.dp), tint = Claude.colors.text500)
                                })
                            }
                        }
                        ModelPage.Effort -> current?.let { model ->
                            SettingsGroup {
                                model.efforts.forEach { value ->
                                    val label = ComposerPolicy.effortLabel(value)?.let { stringResource(it) } ?: value
                                    SettingsRow(label, { vm.setEffort(value); page = ModelPage.Select }, trailing = {
                                        if (value == model.defaultEffort) Badge(stringResource(R.string.model_picker_effort_default_badge))
                                        SelectedCheck(effort == value)
                                    })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Model row: name 17 sp, description 13 sp tertiary up to two lines, a check that always keeps its room. */
@Composable private fun ModelRow(model: ModelOption, selected: Boolean, onClick: () -> Unit) {
    val c = Claude.colors
    Row(Modifier.fillMaxWidth().clip(Claude.shapes.settingsRow).background(c.bg000).clickable(role = Role.Button, onClick = onClick)
        .heightIn(min = 56.dp).padding(start = 12.dp, top = 8.dp, end = 16.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(model.name, style = Claude.type.body17, color = c.text100, maxLines = 2, overflow = TextOverflow.Ellipsis)
            model.description.takeIf { it.isNotBlank() }?.let { Text(it, style = Claude.type.body13, color = c.text500, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        SelectedCheck(selected)
    }
}

@Composable private fun SelectedCheck(selected: Boolean) {
    val description = stringResource(R.string.composer_selected)
    Icon(AppGlyphs.check, if (selected) description else null, Modifier.size(24.dp).alpha(if (selected) 1f else 0f), tint = Claude.colors.text100)
}

/** Neutral badge: pill, sunken fill, 11/550 secondary text, padding 8 × 2. */
@Composable private fun Badge(text: String) {
    Text(text, Modifier.clip(CircleShape).background(Claude.colors.bg300).padding(horizontal = 8.dp, vertical = 2.dp), style = Claude.type.body11Strong, color = Claude.colors.text300)
}

/** Sub-page header of a sheet: back arrow, centred title (same metrics as [ClaudeSheetHeader]). */
@Composable private fun SheetPageHeader(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ClaudeIconButton(AppGlyphs.arrowLeft, stringResource(R.string.generic_back_button_content_description), onBack)
        Text(title, Modifier.weight(1f).semantics { heading() }, style = Claude.type.body17Strong, color = Claude.colors.text100, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        Spacer(Modifier.size(48.dp))
    }
}

// ───────────────────────────── Waiting messages ─────────────────────────────

/** WaitingMessages sheet: "N messages waiting", the note, then each waiting message with Send now / Undo send / Remove. */
@Composable fun WaitingMessagesSheet(vm: AppViewModel, conversationId: String, dismiss: () -> Unit) {
    val queues by vm.queuedComposer.messages.collectAsStateWithLifecycle()
    val entries = queues[conversationId].orEmpty()
    LaunchedEffect(entries.isEmpty()) { if (entries.isEmpty()) dismiss() }
    if (entries.isEmpty()) return
    val c = Claude.colors
    ClaudeModalBottomSheet(onDismissRequest = dismiss) {
        ClaudeSheetHeader(pluralStringResource(R.plurals.chat_waiting_messages_sheet_title, entries.size, entries.size))
        Column(Modifier.verticalScroll(rememberScrollState()).padding(top = 4.dp).navigationBarsPadding().padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.chat_waiting_messages_sheet_note), Modifier.padding(horizontal = 24.dp), style = Claude.type.body15, color = c.text500)
            SettingsGroup {
                entries.forEach { entry -> WaitingMessageRow(vm, conversationId, entry) }
            }
        }
    }
}

@Composable private fun WaitingMessageRow(vm: AppViewModel, conversationId: String, entry: QueuedMessage) {
    val c = Claude.colors
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().clip(Claude.shapes.settingsRow).background(c.bg000).heightIn(min = 56.dp).padding(start = 12.dp, top = 8.dp, end = 4.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (entry.input.text.isNotBlank()) Text(entry.input.text, style = Claude.type.body17, color = c.text100, maxLines = 4, overflow = TextOverflow.Ellipsis)
            entry.input.attachments.forEach { Text(it.name, style = Claude.type.body13, color = c.text500, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            val status = entry.error ?: when (entry.state) {
                QueuedState.QUEUED -> stringResource(R.string.chat_message_queued_state_description)
                QueuedState.STEERED -> stringResource(R.string.chat_waiting_messages_sheet_note)
                QueuedState.SUBMITTING, QueuedState.SENDING -> null // no plumbing text: a quiet spinner
            }
            status?.let { Text(it, style = Claude.type.body13, color = if (entry.error != null) c.dangerText else c.text500) }
        }
        if (entry.state == QueuedState.SUBMITTING || entry.state == QueuedState.SENDING) Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { ClaudeSpinner(SpinnerSize.Small) }
        else if (entry.state == QueuedState.QUEUED) Box {
            ClaudeIconButton(AppGlyphs.dotsVertical, stringResource(R.string.claudex_waiting_message_options), { menu = true }, tint = c.text500)
            ClaudeDropdownMenu(menu, { menu = false }) {
                if (entry.error == null) ClaudeMenuItem(stringResource(R.string.chat_waiting_message_menu_send_now), { menu = false; vm.queuedComposer.sendNow(conversationId, entry.id) }, AppGlyphs.arrowUp)
                ClaudeMenuItem(stringResource(R.string.chat_waiting_message_menu_undo_send), { menu = false; vm.editQueuedMessage(conversationId, entry.id) }, AppGlyphs.arrowCounterClockwise)
                ClaudeMenuItem(stringResource(R.string.claudex_waiting_message_remove), { menu = false; vm.queuedComposer.remove(conversationId, entry.id) }, AppGlyphs.trash, destructive = true)
            }
        }
    }
}
