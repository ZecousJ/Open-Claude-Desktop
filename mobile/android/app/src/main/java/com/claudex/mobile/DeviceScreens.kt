@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.Approval
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * A computer's Code conversations (the official device sessions sheet, `code/remote/devices/e`, as a page):
 * the computer's name and status, then its conversations with their folder and time; waiting and running
 * conversations carry the status mark. A computer that went offline shows the Reconnect your computer copy.
 */
@Composable fun DeviceConversationsScreen(vm: AppViewModel, nav: NavHostController, deviceId: String) {
    val devices by vm.devices.devices.collectAsStateWithLifecycle()
    val lists by vm.devices.conversations.collectAsStateWithLifecycle()
    val error by vm.devices.error.collectAsStateWithLifecycle()
    val device = devices.find { it.id == deviceId }
    val list = lists[deviceId]
    var reconnect by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    var endingIds by remember { mutableStateOf(emptySet<String>()) }
    val scope = rememberCoroutineScope()
    val directories = vm.devices.directories.collectAsStateWithLifecycle().value[deviceId]
    vm.devices.chosenDirectory.collectAsStateWithLifecycle().value
    LaunchedEffect(deviceId) { vm.devices.loadConversations(deviceId); vm.devices.loadDirectories(deviceId) }
    LaunchedEffect(error) { error?.let { vm.error.value = it; vm.devices.error.value = null } }
    val c = Claude.colors
    OfficialPage(device?.name ?: stringResource(R.string.ccr_devices_section_title), onBack = { nav.popBackStack() }) {
        if (device == null) {
            OfficialEmptyState(AppGlyphs.laptopSlash, stringResource(R.string.claudex_device_offline), Modifier.weight(1f),
                action = { ClaudeButton(stringResource(R.string.ccr_devices_asleep_title), { reconnect = true }, variant = ButtonVariant.Secondary, size = ButtonSize.Small) })
            if (reconnect) ConnectComputerSheet { reconnect = false }
            return@OfficialPage
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item(key = "device") {
                Column(Modifier.padding(vertical = 12.dp)) {
                    SettingsGroup {
                        SettingsRow(device.name, {}, AppGlyphs.laptop, subtitle = listOf(device.platformName, device.version).filter { it.isNotBlank() }.joinToString(" · "), enabled = true,
                            trailing = { Text(stringResource(R.string.ccr_devices_status_active), style = Claude.type.body13, color = c.text500) })
                    }
                }
            }
            // Directory row and New session (`code/remote/devices/e` c and d): the folder new sessions start in, then the button.
            item(key = "new") {
                val directory = vm.devices.directoryFor(deviceId)
                Column(Modifier.padding(bottom = 12.dp)) {
                    if (directory != null) {
                        SettingsGroup {
                            SettingsRow(stringResource(R.string.ccr_device_directory_label), { picking = true }, AppGlyphs.folder, subtitle = directory.name,
                                trailing = { Icon(AppGlyphs.caretRight, stringResource(R.string.ccr_device_new_session_directory_hint), Modifier.size(20.dp), tint = c.text500) })
                        }
                        ClaudeButton(stringResource(R.string.new_session), { nav.navigate("deviceNew/$deviceId") }, Modifier.padding(horizontal = 16.dp, vertical = 12.dp), size = ButtonSize.Large, fillWidth = true)
                    } else if (directories != null) {
                        SettingsFootnote(stringResource(R.string.claudex_device_no_directories))
                    }
                }
            }
            item(key = "header") { Text(stringResource(R.string.ccr_paired_active_sessions_title), Modifier.padding(start = 24.dp, end = 24.dp, top = 4.dp, bottom = 8.dp), style = Claude.type.body15Strong, color = c.text500) }
            if (list == null) item(key = "loading") { LoadingState() }
            else if (list.isEmpty()) item(key = "empty") { OfficialEmptyState(AppGlyphs.code, stringResource(R.string.ccr_device_no_active_sessions), Modifier.padding(top = 24.dp)) }
            items(list.orEmpty(), key = { it.id }) { item ->
                val time = relativeTime(item.updatedAt)
                val ending = item.id in endingIds
                OfficialListRow(item.title, { nav.navigate("deviceConversation/$deviceId/${item.id}") },
                    subtitle = listOfNotNull(item.folderName ?: stringResource(R.string.ccr_paired_no_folder), time).joinToString(" · "),
                    leading = { StatusMark(if (item.approvals > 0) RowStatus.Waiting else if (item.running) RowStatus.Working else RowStatus.Quiet) },
                    // `ccr_paired_end_session`: a small button on the row, no confirmation.
                    trailing = { ClaudeButton(stringResource(R.string.ccr_paired_end_session), { endingIds = endingIds + item.id; scope.launch { vm.devices.endSession(deviceId, item.id); endingIds = endingIds - item.id } },
                        variant = ButtonVariant.Secondary, size = ButtonSize.Small, enabled = !ending, loading = ending) })
            }
        }
    }
    if (picking) DirectorySheet(vm, deviceId) { picking = false }
}

/** Directory picker (`DeviceDirectories`): "Choose a directory"; the default folder carries its badge, the chosen one a check. */
@Composable private fun DirectorySheet(vm: AppViewModel, deviceId: String, dismiss: () -> Unit) {
    val directories by vm.devices.directories.collectAsStateWithLifecycle()
    val chosen by vm.devices.chosenDirectory.collectAsStateWithLifecycle()
    val list = directories[deviceId].orEmpty()
    val current = list.find { it.path == chosen[deviceId] } ?: list.find { it.default } ?: list.firstOrNull()
    val c = Claude.colors
    ClaudeModalBottomSheet(dismiss) {
        ClaudeSheetHeader(stringResource(R.string.ccr_device_directory_label), dismiss)
        Text(stringResource(R.string.ccr_devices_directory_picker_subtitle), Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp), style = Claude.type.body15, color = c.textSecondary, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Column(Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 24.dp)) {
            list.forEach { directory ->
                SheetActionRow(directory.name, { vm.devices.chooseDirectory(deviceId, directory.path); dismiss() }, AppGlyphs.folder,
                    suffix = pluralStringResource(R.plurals.ccr_device_active_sessions_header, directory.sessions, directory.sessions),
                    trailing = {
                        if (directory.default) Text(stringResource(R.string.ccr_device_picker_default_badge), Modifier.clip(CircleShape).background(c.bg300).padding(horizontal = 8.dp, vertical = 2.dp), style = Claude.type.body11Strong, color = c.text300)
                        Icon(AppGlyphs.check, null, Modifier.size(20.dp).alpha(if (directory.path == current?.path) 1f else 0f), tint = c.text100)
                    })
            }
        }
    }
}

/** One Code conversation on a computer: its transcript, its approvals and a composer that sends to it there. */
@Composable fun DeviceConversationScreen(vm: AppViewModel, nav: NavHostController, deviceId: String, conversationId: String) {
    val devices by vm.devices.devices.collectAsStateWithLifecycle()
    val open by vm.devices.open.collectAsStateWithLifecycle()
    val sending by vm.devices.sending.collectAsStateWithLifecycle()
    val error by vm.devices.error.collectAsStateWithLifecycle()
    val device = devices.find { it.id == deviceId }
    val state = open?.takeIf { it.deviceId == deviceId && it.conversation.id == conversationId }
    val scope = rememberCoroutineScope()
    var text by rememberSaveable(conversationId) { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var changeModel by remember { mutableStateOf(false) }
    LaunchedEffect(deviceId, conversationId) { vm.devices.openConversation(deviceId, conversationId) }
    DisposableEffect(conversationId) { onDispose { vm.devices.close(conversationId) } }
    LaunchedEffect(error) { error?.let { vm.error.value = it; vm.devices.error.value = null } }
    OfficialPage(state?.conversation?.title ?: stringResource(R.string.generic_untitled), onBack = { nav.popBackStack() }, modifier = Modifier.imePadding(), actions = {
        if (state != null) Box {
            ClaudeIconButton(AppGlyphs.dotsVertical, stringResource(R.string.generic_button_more_options), { menu = true })
            ClaudeDropdownMenu(menu, { menu = false }) {
                ClaudeMenuItem(stringResource(R.string.session_menu_change_model), { menu = false; changeModel = true }, AppGlyphs.memory)
                ClaudeMenuItem(stringResource(R.string.ccr_paired_end_session), { menu = false; scope.launch { if (vm.devices.endSession(deviceId, conversationId)) nav.popBackStack() } }, AppGlyphs.archive)
            }
        }
    }) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (state != null) SharedConversationView(vm, nav, state.conversation, Modifier.fillMaxSize(), surfaceKey = "device:$deviceId:$conversationId")
            else LoadingState(Modifier.align(Alignment.Center))
        }
        val alwaysAllow = rememberApprovalsAlwaysAllow(vm)
        state?.approvals?.forEach { approval -> DeviceApproval(approval, alwaysAllow) { response -> vm.devices.approve(approval, response) } }
        val running = state?.running == true
        DeviceComposer(device?.name.orEmpty(), text, { text = it }, canSend = state != null && !sending && !running && text.isNotBlank(), sending = sending, running = running,
            onStop = { scope.launch { vm.devices.interrupt() } }, onSend = { val message = text; scope.launch { if (vm.devices.send(message)) text = "" } })
    }
    if (changeModel && state != null) DeviceModelSheet(vm, deviceId, state.conversation) { changeModel = false }
}

/**
 * New session on a computer: the folder it starts in (picked on the computer's page), then the first message. The
 * computer creates the session with that message, so the page opens it when the computer answers.
 */
@Composable fun DeviceNewSessionScreen(vm: AppViewModel, nav: NavHostController, deviceId: String) {
    val devices by vm.devices.devices.collectAsStateWithLifecycle()
    val sending by vm.devices.sending.collectAsStateWithLifecycle()
    val error by vm.devices.error.collectAsStateWithLifecycle()
    val directories by vm.devices.directories.collectAsStateWithLifecycle()
    vm.devices.chosenDirectory.collectAsStateWithLifecycle().value
    val device = devices.find { it.id == deviceId }
    val directory = vm.devices.directoryFor(deviceId)
    val scope = rememberCoroutineScope()
    var text by rememberSaveable(deviceId) { mutableStateOf("") }
    LaunchedEffect(deviceId) { if (directories[deviceId] == null) vm.devices.loadDirectories(deviceId) }
    LaunchedEffect(error) { error?.let { vm.error.value = it; vm.devices.error.value = null } }
    OfficialPage(stringResource(R.string.new_session), onBack = { nav.popBackStack() }, modifier = Modifier.imePadding()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
            SettingsGroup {
                SettingsRow(stringResource(R.string.ccr_device_directory_label), { nav.popBackStack() }, AppGlyphs.folder, subtitle = directory?.name ?: stringResource(R.string.ccr_paired_no_folder))
            }
            if (device == null) SettingsFootnote(stringResource(R.string.claudex_device_offline))
        }
        DeviceComposer(device?.name.orEmpty(), text, { text = it }, canSend = device != null && directory != null && !sending && text.isNotBlank(), sending = sending, running = false,
            hint = stringResource(R.string.claudex_device_new_hint, directory?.name ?: ""), onStop = {},
            onSend = { val message = text; scope.launch { vm.devices.startSession(deviceId, message)?.let { id ->
                text = ""
                nav.navigate("deviceConversation/$deviceId/$id") { popUpTo("deviceNew/{device}") { inclusive = true } }
            } } })
    }
}

/** The composer of a computer's session: the text, the computer's name, Stop while a turn runs and Send. */
@Composable private fun DeviceComposer(deviceName: String, text: String, onText: (String) -> Unit, canSend: Boolean, sending: Boolean, running: Boolean,
    onStop: () -> Unit, onSend: () -> Unit, hint: String? = null) {
    val c = Claude.colors
    Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).navigationBarsPadding(), color = c.bg000, shape = Claude.shapes.r24,
        border = BorderStroke(1.dp, c.borderDefault), shadowElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().padding(6.dp)) {
            ClaudeTextField(text, onText, Modifier.fillMaxWidth().semantics { contentDescription = deviceName }, singleLine = false, maxLines = 6,
                placeholder = hint ?: stringResource(R.string.claudex_device_composer_hint, deviceName.ifBlank { stringResource(R.string.ccr_devices_section_title) }),
                container = c.bg000, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 10.dp))
            Row(Modifier.fillMaxWidth().padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(AppGlyphs.laptop, null, Modifier.size(16.dp), tint = c.text500)
                Spacer(Modifier.width(6.dp))
                Text(deviceName, Modifier.weight(1f), style = Claude.type.body13, color = c.text500, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (running) ClaudeIconButton(AppGlyphs.stopFilled, stringResource(R.string.claudex_device_stop), onStop)
                ClaudeButton(null, onSend, icon = AppGlyphs.arrowUp, contentDescription = stringResource(R.string.claudex_device_send), enabled = canSend, loading = sending, size = ButtonSize.Small)
            }
        }
    }
}

/** "Change model" for a session on a computer: the models that computer's services offer; the session uses the pick from its next message. */
@Composable private fun DeviceModelSheet(vm: AppViewModel, deviceId: String, conversation: com.claudex.core.Conversation, dismiss: () -> Unit) {
    var models by remember { mutableStateOf<DeviceModels?>(null) }
    var saving by remember { mutableStateOf<DeviceModelOption?>(null) }
    val scope = rememberCoroutineScope()
    val c = Claude.colors
    LaunchedEffect(deviceId) { models = vm.devices.models(deviceId) ?: DeviceModels(emptyList(), null) }
    ClaudeModalBottomSheet({ if (saving == null) dismiss() }) {
        ClaudeSheetHeader(stringResource(R.string.chat_options_select_model))
        Column(Modifier.verticalScroll(rememberScrollState()).padding(top = 12.dp).navigationBarsPadding().padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val list = models
            if (list == null) LoadingState()
            else if (list.models.isEmpty()) Text(stringResource(R.string.claudex_model_none), Modifier.padding(horizontal = 24.dp), style = Claude.type.body15, color = c.text500)
            else SettingsGroup {
                list.models.forEach { model ->
                    SettingsRow(model.id, {
                        if (saving == null) { saving = model; scope.launch { val ok = vm.devices.setModel(deviceId, conversation.id, model); saving = null; if (ok) dismiss() } }
                    }, trailing = {
                        if (saving == model) ClaudeSpinner(SpinnerSize.XSmall)
                        else Icon(AppGlyphs.check, null, Modifier.size(24.dp).alpha(if (model.id == conversation.model && model.providerId == conversation.providerId) 1f else 0f), tint = c.text100)
                    })
                }
            }
        }
    }
}

/**
 * A computer's approval: the official in-session approval card (approve once, for the session, or deny; a connector
 * tool's sheet; a tool's form), answered with the card's own response; the computer's engine applies it and refuses a
 * session grant the administrator turned off. Extra permissions are reviewed on the computer.
 */
@Composable private fun DeviceApproval(approval: Approval, approvalsAlwaysAllow: Boolean?, answer: suspend (org.json.JSONObject) -> Unit) {
    ApprovalCard(approval, Modifier.padding(horizontal = 16.dp, vertical = 4.dp), elsewhereMessage = androidx.compose.ui.res.stringResource(R.string.ccr_folder_consent_review_on_computer),
        extended = false, approvalsAlwaysAllow = approvalsAlwaysAllow, answer = answer)
}
