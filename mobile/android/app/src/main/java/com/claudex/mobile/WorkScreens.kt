@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.*
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.launch

/** The official permission-mode titles (`ccr_mode_*`) for our modes. */
@Composable internal fun permissionModeTitle(mode: String?): String = when (mode) {
    "manual" -> stringResource(R.string.ccr_permission_mode_ask_title)
    "acceptEdits" -> stringResource(R.string.ccr_permission_mode_act_title)
    "plan" -> stringResource(R.string.ccr_permission_mode_plan_title)
    "auto" -> stringResource(R.string.ccr_permission_mode_auto_title)
    "bypass" -> stringResource(R.string.ccr_mode_bypass)
    else -> stringResource(R.string.usage_meter_row_loading)
}

/**
 * Code (`rww`, code-voice-tools.md §4): the Devices section (one chip per computer signed in to this
 * account, then "Add device"), the session filter and the cloud Code sessions; the top-bar action and the
 * empty state start a new session on a GitHub repository (route code-new).
 */
@Composable fun CodeScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf(SessionFilter.ALL) }
    var group by rememberSaveable { mutableStateOf(SessionGroup.NONE) }
    var selecting by rememberSaveable { mutableStateOf(false) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var filterMenu by remember { mutableStateOf(false) }
    var search by rememberSaveable { mutableStateOf("") }
    var bulkDelete by remember { mutableStateOf(false) }
    var bulkBusy by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf<Set<String>?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    val c = Claude.colors
    fun endSelection() { selecting = false; selected = emptySet() }
    BackHandler(selecting) { endSelection() }
    LaunchedEffect(Unit) { vm.mode.value = Mode.CODE }
    val all = snapshot.conversations.filter { it.mode == Mode.CODE }.sortedByDescending { it.updatedAt }
    val waiting = snapshot.approvals.map { it.conversationId }.toSet()
    // Ready for review: the pull request a finished session made is open and waits for a reviewer (the service answers, SessionList.kt).
    val review by vm.sessionReview.ready.collectAsStateWithLifecycle()
    val askedAbout = SessionReviewPolicy.candidates(all)
    LaunchedEffect(askedAbout) { vm.sessionReview.load(all) }
    val sessions = all.filter { s -> SessionList.matches(filter, s, waiting, review) }.filter { SessionGit.matches(it, search) }
    val now = remember(sessions) { System.currentTimeMillis() }
    val sections = remember(sessions, group, waiting, review, now) { SessionList.sections(sessions, group, waiting, review, now) }
    val selectedRunning = sessions.any { it.id in selected && it.turns.lastOrNull()?.status == TurnStatus.IN_PROGRESS }
    LaunchedEffect(sessions) { selected = selected.filter { id -> sessions.any { it.id == id } }.toSet() }
    OfficialPage(stringResource(R.string.code_screen_title), subtitle = if (selecting) stringResource(R.string.chat_list_selected_count, selected.size) else null, actions = {
        if (selecting) {
            ClaudeButton(stringResource(R.string.chat_list_move_selected), { moving = selected }, variant = ButtonVariant.Borderless, size = ButtonSize.Small, icon = Anthropicons.projects,
                enabled = selected.isNotEmpty() && !selectedRunning && ChatProjectMoves.supported(vm) && snapshot.projects.isNotEmpty())
            ClaudeIconButton(Anthropicons.trash, stringResource(R.string.chat_menu_delete), { bulkDelete = true }, enabled = selected.isNotEmpty() && !selectedRunning && !bulkBusy, tint = if (selected.isNotEmpty() && !selectedRunning) c.danger100 else c.text500)
        } else {
        Box {
            ClaudeIconButton(Anthropicons.filter, stringResource(if (filter == SessionFilter.ALL) R.string.session_list_filter_sessions_a11y else R.string.session_list_filter_change_a11y), { filterMenu = true })
            ClaudeDropdownMenu(filterMenu, { filterMenu = false }) {
                SessionFilter.entries.forEach { option -> ClaudeMenuItem(stringResource(option.label), { filter = option; filterMenu = false }, option.icon, selected = option == filter) }
                SessionGroupItems(group) { group = it; filterMenu = false }
            }
        }
        ClaudeIconButton(Anthropicons.chatAdd, stringResource(R.string.new_session), { nav.navigate("code-new") })
        }
    }) {
        PullToRefreshBox(refreshing, onRefresh = {
            scope.launch { refreshing = true; try { vm.repository.refresh(); vm.devices.loadDevices(); vm.sessionReview.load(vm.snapshot.value.conversations, force = true) } catch (e: CancellationException) { throw e } catch (_: Exception) {} finally { refreshing = false } }
        }, Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                item(key = "devices") { DeviceSection(vm, nav) }
                item(key = "search") {
                    val label = stringResource(R.string.session_list_search_a11y)
                    ListSearchField(search, { search = it.take(400) }, stringResource(R.string.session_list_search_placeholder),
                        Modifier.padding(horizontal = 12.dp, vertical = 4.dp).semantics { contentDescription = label })
                }
                item(key = "sessionsHeader") {
                    Text(stringResource(R.string.session_list_sessions_header), Modifier.padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 8.dp),
                        style = Claude.type.body15Strong, color = c.text500)
                }
                if (sessions.isEmpty()) item(key = "empty") {
                    when {
                        search.isNotBlank() -> OfficialEmptyState(Anthropicons.searchCircle, stringResource(R.string.empty_state_search_title, search.trim()), Modifier.padding(top = 24.dp))
                        filter != SessionFilter.ALL -> OfficialEmptyState(Anthropicons.code, stringResource(R.string.session_list_filter_empty), Modifier.padding(top = 24.dp))
                        all.isNotEmpty() -> OfficialEmptyState(Anthropicons.archive, stringResource(R.string.code_empty_all_sessions_archived_title), Modifier.padding(top = 24.dp),
                            subtitle = stringResource(R.string.code_empty_all_sessions_archived_subtitle))
                        else -> OfficialEmptyState(Anthropicons.code, stringResource(R.string.code_empty_start_first_session_title), Modifier.padding(top = 24.dp),
                            subtitle = stringResource(R.string.code_empty_start_first_session_subtitle),
                            action = { ClaudeButton(stringResource(R.string.new_session), { nav.navigate("code-new") }, size = ButtonSize.Medium, icon = Anthropicons.add) })
                    }
                }
                sections.forEach { section ->
                    if (group != SessionGroup.NONE) item(key = "group:" + section.key) { SessionHeading(section.literal ?: stringResource(section.title ?: R.string.session_group_idle)) }
                items(section.rows, key = { it.id }) { session ->
                    val status = when {
                        session.id in waiting -> RowStatus.Waiting
                        session.turns.lastOrNull()?.status == TurnStatus.IN_PROGRESS -> RowStatus.Working
                        session.unread -> RowStatus.New
                        else -> RowStatus.Quiet
                    }
                    ListedSessionRow(vm, nav, session, { nav.navigate("conversation/${session.id}") }, pinned = session.pinned, subtitle = relativeTime(session.updatedAt),
                        selecting = selecting, selected = session.id in selected, onToggle = { on -> selected = if (on) selected + session.id else selected - session.id },
                        onBeginSelect = { selecting = true; selected = setOf(session.id) }) { StatusMark(status) }
                }
                }
            }
        }
    }
    if (bulkDelete) {
        val count = selected.size
        ClaudeDialog(pluralStringResource(R.plurals.chat_list_delete_selected_title, count, count), stringResource(R.string.delete_dialog_default_subtitle),
            stringResource(R.string.chat_menu_delete), onConfirm = {
                val ids = selected.toList()
                bulkBusy = true
                scope.launch {
                    try { ids.forEach { vm.repository.deleteConversation(it) } }
                    catch (e: CancellationException) { throw e }
                    catch (e: Exception) { vm.error.value = e.message ?: context.getString(R.string.generic_error_something_went_wrong_try_again) }
                    finally { bulkBusy = false; bulkDelete = false; endSelection() }
                }
            }, onDismiss = { bulkDelete = false }, destructive = true, busy = bulkBusy)
    }
    moving?.let { ids ->
        ProjectPickerSheet(snapshot.projects, current = sessions.filter { it.id in ids }.mapNotNull { it.projectId }.distinct().singleOrNull(), onDismiss = { moving = null }) { project ->
            moving = null
            vm.work { ChatProjectMoves.move(vm, ids, project.id); vm.error.value = context.getString(R.string.chat_moved_to_project_toast, project.name) }
            endSelection()
        }
    }
}

/** A session or task row. A long press opens the same menu as the open conversation. Select starts multi-select with that row checked. */
@Composable private fun ListedSessionRow(vm: AppViewModel, nav: NavHostController, conversation: Conversation, onOpen: () -> Unit, subtitle: String, pinned: Boolean = false,
    selecting: Boolean = false, selected: Boolean = false, onToggle: ((Boolean) -> Unit)? = null, onBeginSelect: (() -> Unit)? = null, leading: @Composable () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf<ChatMenuAction?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val removed = stringResource(R.string.chat_removed_from_project_toast)
    val sessionCopied = stringResource(R.string.ccr_session_id_copied)
    val branchCopied = stringResource(R.string.ccr_branch_copied)
    LaunchedEffect(toast, vm.popupAutoDismiss) { if (toast != null && vm.popupAutoDismiss) { kotlinx.coroutines.delay(2500); toast = null } }
    Box(Modifier.fillMaxWidth()) {
        OfficialListRow(conversation.title.ifBlank { stringResource(R.string.generic_untitled) }, onOpen, subtitle = subtitle, onLongClick = if (selecting) null else ({ menu = true }), pinned = pinned,
            selection = if (selecting) selected else null, onToggle = onToggle, leading = leading)
        ChatMoreMenu(conversation, menu && !selecting, { menu = false }, onSelect = onBeginSelect) { action ->
            when (action) {
                ChatMenuAction.PIN -> vm.updateConversation(conversation, pinned = !conversation.pinned)
                ChatMenuAction.ARCHIVE -> vm.updateConversation(conversation, archived = !conversation.archived)
                ChatMenuAction.COPY_BRANCH -> SessionGit.branch(conversation)?.let { clipboard.setText(androidx.compose.ui.text.AnnotatedString(it)); toast = branchCopied }
                ChatMenuAction.COPY_ID -> { clipboard.setText(androidx.compose.ui.text.AnnotatedString(conversation.id)); toast = sessionCopied }
                ChatMenuAction.REMOVE_FROM_PROJECT -> vm.moveConversation(conversation, null) { toast = removed }
                else -> sheet = action
            }
        }
        toast?.let { PillToast(it, Modifier.align(Alignment.Center)) { toast = null } }
    }
    when (sheet) {
        ChatMenuAction.SHARE -> HostedShareSheet(vm, conversation) { sheet = null }
        ChatMenuAction.CHANGE_MODEL -> ModelSelectorSheet(vm, { sheet = null }, conversation = conversation)
        ChatMenuAction.RENAME -> RenameConversationDialog(conversation, { sheet = null }) { title -> vm.updateConversation(conversation, title = title); sheet = null }
        ChatMenuAction.PROJECT -> MoveToProjectSheet(vm, conversation, { sheet = null }) { name -> sheet = null; toast = context.getString(R.string.chat_moved_to_project_toast, name) }
        ChatMenuAction.DELETE -> DeleteConversationDialog(vm, conversation, { sheet = null }) { sheet = null }
        else -> Unit
    }
}

/** Group by under the filter list: Date, Status, Folder, None. */
@Composable private fun SessionGroupItems(group: SessionGroup, onGroup: (SessionGroup) -> Unit) {
    HorizontalDivider(Modifier.padding(vertical = 4.dp), color = Claude.colors.borderDefault)
    Text(stringResource(R.string.session_group_by), Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = Claude.type.body13, color = Claude.colors.text500)
    SessionGroup.entries.forEach { option -> ClaudeMenuItem(stringResource(option.label), { onGroup(option) }, selected = option == group) }
}

/** A group heading in the session or task list. */
@Composable private fun SessionHeading(title: String) {
    Text(title, Modifier.padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 8.dp).semantics { heading() }, style = Claude.type.body15Strong, color = Claude.colors.text500)
}

/** A device chip (`imx`, §4.2): pill ≥ 44 dp, 12/4/16/4 padding, raised with a hairline (the Add device chip has the same frame, `imx.java:175`); laptop glyph with the green status dot; name ≤ 112 dp. */
@Composable private fun DeviceChip(label: String, onClick: () -> Unit, clickLabel: String, online: Boolean = true, add: Boolean = false) {
    val c = Claude.colors
    val shape = Claude.shapes.pill
    Row(Modifier.heightIn(min = 44.dp).then(if (online) Modifier.shadow(4.dp, shape, ambientColor = Color.Black.copy(alpha = .08f), spotColor = Color.Black.copy(alpha = .08f)) else Modifier)
        .clip(shape).background(if (online) c.surfaceSunken else Color.Transparent).border(1.dp, c.borderDefault, shape)
        .clickable(onClickLabel = clickLabel, role = Role.Button, onClick = onClick).padding(start = 12.dp, top = 4.dp, end = 16.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(24.dp)) {
            Icon(if (add) Anthropicons.add else if (online) Anthropicons.laptop else Anthropicons.laptopSlash, null, Modifier.size(24.dp), tint = if (online || add) c.textPrimary else c.textTertiary)
            if (online && !add) Box(Modifier.align(Alignment.BottomEnd).size(8.dp).clip(CircleShape).background(c.success100))
        }
        Text(label, Modifier.widthIn(max = 112.dp), style = Claude.type.body15, color = if (online || add) c.textPrimary else c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Devices section (`imx.d`): "Devices" and a row of chips — one per computer that has Claudex open and is
 * signed in to this account (status "Connected"), then "Add device", which opens the Connect your computer sheet.
 */
@Composable fun DeviceSection(vm: AppViewModel, nav: NavHostController) {
    val devices by vm.devices.devices.collectAsStateWithLifecycle()
    val loaded by vm.devices.loaded.collectAsStateWithLifecycle()
    var setup by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.devices.loadDevices() }
    val c = Claude.colors
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Text(stringResource(R.string.ccr_devices_section_title), Modifier.padding(horizontal = 24.dp, vertical = 8.dp), style = Claude.type.body15Strong, color = c.text500)
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!loaded && vm.repository is RemoteRepository) item(key = "loading") { Box(Modifier.heightIn(min = 44.dp).padding(horizontal = 12.dp), contentAlignment = Alignment.Center) { ClaudeSpinner(SpinnerSize.Small) } }
            items(devices, key = { it.id }) { device ->
                val status = stringResource(R.string.ccr_devices_status_active)
                Box(Modifier.semantics(mergeDescendants = true) { contentDescription = device.name + ", " + status }) {
                    DeviceChip(device.name, { nav.navigate("device/${device.id}") }, stringResource(R.string.ccr_devices_picker_action))
                }
            }
            item(key = "add") { DeviceChip(stringResource(R.string.ccr_devices_add_device), { setup = true }, stringResource(R.string.ccr_devices_setup_title), add = true) }
        }
    }
    if (setup) ConnectComputerSheet { setup = false }
}

/**
 * "Connect your computer" sheet (`eww`, §4.5) with the Claudex instruction in place of the terminal command:
 * open Claudex on the computer and sign in to this account; then come back and pick the computer.
 */
@Composable fun ConnectComputerSheet(computerName: String? = null, dismiss: () -> Unit) {
    val c = Claude.colors
    ClaudeModalBottomSheet(dismiss) {
        ClaudeSheetHeader(stringResource(if (computerName == null) R.string.ccr_devices_setup_title else R.string.ccr_devices_asleep_title), onClose = dismiss)
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, top = 40.dp, bottom = 24.dp).navigationBarsPadding(),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Icon(Anthropicons.laptop, null, Modifier.size(48.dp), tint = c.textSecondary)
            if (computerName != null) {
                Text(stringResource(R.string.ccr_devices_asleep_lead, computerName), style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
                Text(stringResource(R.string.claudex_devices_asleep_instruction), style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
            } else {
                Text(stringResource(R.string.claudex_devices_setup_body), style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
                Text(stringResource(R.string.ccr_devices_setup_footer), style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
            }
            // The "or" divider (`eww.d`) and the desktop hint (`eww.b`), worded for Claudex.
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f).height(1.dp).background(c.borderDefault))
                Text(stringResource(R.string.ccr_devices_setup_or), Modifier.padding(horizontal = 12.dp), style = Claude.type.body13, color = c.textSecondary)
                Box(Modifier.weight(1f).height(1.dp).background(c.borderDefault))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Anthropicons.laptop, null, Modifier.size(20.dp), tint = c.textSecondary)
                Text(stringResource(R.string.claudex_devices_desktop_hint), Modifier.weight(1f), style = Claude.type.body13, color = c.textSecondary)
            }
        }
    }
}

/** A new cloud Code session on a GitHub repository: Repositories, base branch and mode rows, then the composer. */
@Composable fun RepositoryConversationScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle(); val selected by vm.selectedRepository.collectAsStateWithLifecycle()
    var sheet by remember { mutableStateOf(false) }; var permission by remember { mutableStateOf(false) }
    // The Code starter (`uzr`): a chosen suggestion or "Something else…" swaps the composer for Start Session.
    var choice by rememberSaveable { mutableStateOf<String?>(null) }
    val draft by vm.draft.collectAsStateWithLifecycle(); val busy by vm.busy.collectAsStateWithLifecycle()
    val ready = BuildConfig.DEMO_MODE || snapshot.cloudCode
    LaunchedEffect(Unit) { vm.switchDraft(null, null, Mode.CODE); vm.mode.value = Mode.CODE; if (selected == null) sheet = true }
    OfficialPage(stringResource(R.string.new_session), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
            if (ready) CodeStarter(snapshot.accountName.takeIf { it.isNotBlank() && '@' !in it && !BuildConfig.DEMO_MODE }, choice, draft, { tapped ->
                val next = CodeStarterPolicy.next(choice, tapped)
                vm.draft.value = CodeStarterPolicy.draftAfter(vm.draft.value, next); choice = next
            }, { vm.draft.value = it }, busy)
            Spacer(Modifier.height(12.dp))
            SettingsGroup {
                SettingsRow(stringResource(R.string.code_project_repos_title), { sheet = true }, Anthropicons.github, subtitle = selected?.name ?: stringResource(R.string.ccr_connect_github_description))
                SettingsRow(stringResource(R.string.ccr_choose_base_branch), { sheet = true }, Anthropicons.branch, subtitle = selected?.branch, enabled = selected != null)
                SettingsRow(stringResource(R.string.ccr_sheet_permission_row), { permission = true }, Anthropicons.hand, subtitle = permissionModeTitle(CodeModePolicy.current(WireCodec.rawSettings)))
            }
            if (!BuildConfig.DEMO_MODE && !snapshot.cloudCode) SettingsFootnote(stringResource(R.string.claudex_cloud_code_unavailable))
        }
        if (selected != null && ready && choice != null) Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).navigationBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
            ClaudeButton(stringResource(R.string.code_starter_start_session), {
                vm.submitComposer(null, null, pending = { pendingId -> nav.navigate("sending/$pendingId") { launchSingleTop = true } }) { id ->
                    if (nav.currentBackStackEntry?.destination?.route != "sending/{id}") nav.navigate("conversation/$id")
                }
            }, size = ButtonSize.Large, fillWidth = true, enabled = CodeStarterPolicy.canStart(draft, choice), loading = busy)
            Text(stringResource(R.string.code_starter_connect_own_repo), Modifier.clickable(role = androidx.compose.ui.semantics.Role.Button) { sheet = true }.padding(vertical = 14.dp),
                style = Claude.type.body13, color = Claude.colors.text500)
        }
        else if (selected != null && ready) Composer(vm, nav, draftMode = Mode.CODE)
        else if (ready) Column(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
            if (choice != null) ClaudeButton(stringResource(R.string.code_starter_start_session), { sheet = true }, size = ButtonSize.Large, fillWidth = true, enabled = CodeStarterPolicy.canStart(draft, choice))
            else ClaudeButton(stringResource(R.string.code_project_repos_title), { sheet = true }, size = ButtonSize.Large, fillWidth = true, icon = Anthropicons.github)
            Text(stringResource(R.string.code_starter_connect_own_repo), Modifier.clickable(role = androidx.compose.ui.semantics.Role.Button) { sheet = true }.padding(vertical = 14.dp),
                style = Claude.type.body13, color = Claude.colors.text500)
        }
        else ClaudeButton(stringResource(R.string.code_project_repos_title), { sheet = true }, Modifier.padding(16.dp).navigationBarsPadding(), size = ButtonSize.Large, fillWidth = true,
            icon = Anthropicons.github, enabled = BuildConfig.DEMO_MODE || snapshot.cloudCode)
    }
    if (sheet) RepositorySheet(vm) { sheet = false }
    if (permission) PermissionSheet(vm) { permission = false }
}

/**
 * Cowork (`dramatic_shrimp`, strings §3.15): the cloud task list with the same filter menu as Code (`ys7` is the one
 * list model for sessions and tasks); the composer starts a task. Empty states follow `kix.b`: NoSessions is the title
 * alone, AllArchived points at the Archived filter, FilteredEmpty is "No tasks found." with the hand-off line.
 */
@Composable fun CoworkScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf(SessionFilter.ALL) }
    var group by rememberSaveable { mutableStateOf(SessionGroup.NONE) }
    var selecting by rememberSaveable { mutableStateOf(false) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var filterMenu by remember { mutableStateOf(false) }
    var bulkDelete by remember { mutableStateOf(false) }
    var bulkBusy by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf<Set<String>?>(null) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    val c = Claude.colors
    fun endSelection() { selecting = false; selected = emptySet() }
    BackHandler(selecting) { endSelection() }
    LaunchedEffect(Unit) { vm.mode.value = Mode.COWORK }
    // The official first-use page stands in for the list until "Get started" is tapped once (ys7.b0).
    val starterSeen by vm.coworkStarterSeen.collectAsStateWithLifecycle()
    if (!starterSeen) { CoworkStarterPage(vm::markCoworkStarterSeen); return }
    val waiting = snapshot.approvals.map { it.conversationId }.toSet()
    val everything = snapshot.conversations.filter { it.mode == Mode.COWORK }.sortedByDescending { it.updatedAt }
    val tasks = everything.filter { t -> SessionList.matches(filter, t, waiting, emptySet()) }
    val taskNow = remember(tasks) { System.currentTimeMillis() }
    val taskSections = remember(tasks, group, waiting, taskNow) { SessionList.sections(tasks, group, waiting, emptySet(), taskNow) }
    val selectedRunning = tasks.any { it.id in selected && it.turns.lastOrNull()?.status == TurnStatus.IN_PROGRESS }
    LaunchedEffect(tasks) { selected = selected.filter { id -> tasks.any { it.id == id } }.toSet() }
    OfficialPage(stringResource(R.string.dramatic_shrimp_screen_title), subtitle = if (selecting) stringResource(R.string.chat_list_selected_count, selected.size) else null, actions = {
        if (selecting) {
            ClaudeButton(stringResource(R.string.chat_list_move_selected), { moving = selected }, variant = ButtonVariant.Borderless, size = ButtonSize.Small, icon = Anthropicons.projects,
                enabled = selected.isNotEmpty() && !selectedRunning && ChatProjectMoves.supported(vm) && snapshot.projects.isNotEmpty())
            ClaudeIconButton(Anthropicons.trash, stringResource(R.string.chat_menu_delete), { bulkDelete = true }, enabled = selected.isNotEmpty() && !selectedRunning && !bulkBusy, tint = if (selected.isNotEmpty() && !selectedRunning) c.danger100 else c.text500)
        } else Box {
            ClaudeIconButton(Anthropicons.filter, stringResource(if (filter == SessionFilter.ALL) R.string.session_list_filter_sessions_a11y else R.string.session_list_filter_change_a11y), { filterMenu = true })
            ClaudeDropdownMenu(filterMenu, { filterMenu = false }) {
                SessionList.coworkFilters.forEach { option -> ClaudeMenuItem(stringResource(option.label), { filter = option; filterMenu = false }, option.icon, selected = option == filter) }
                SessionGroupItems(group) { group = it; filterMenu = false }
            }
        }
    }) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(vertical = 8.dp)) {
            if (tasks.isEmpty()) item(key = "empty") {
                when {
                    filter != SessionFilter.ALL -> OfficialEmptyState(Anthropicons.tasks, stringResource(R.string.cowork_empty_no_tasks_found_title), Modifier.padding(top = 64.dp),
                        subtitle = stringResource(R.string.cowork_empty_no_tasks_subtitle))
                    everything.isNotEmpty() -> OfficialEmptyState(Anthropicons.archive, stringResource(R.string.cowork_empty_all_tasks_archived_title), Modifier.padding(top = 64.dp),
                        subtitle = stringResource(R.string.cowork_empty_all_tasks_archived_subtitle))
                    else -> OfficialEmptyState(Anthropicons.tasks, stringResource(R.string.cowork_empty_what_can_claude_tackle_title), Modifier.padding(top = 64.dp),
                        subtitle = if (BuildConfig.DEMO_MODE || snapshot.cloudCowork) null else stringResource(R.string.cowork_unavailable_toast))
                }
            }
            taskSections.forEach { section ->
                if (group != SessionGroup.NONE) item(key = "group:" + section.key) { SessionHeading(section.literal ?: stringResource(section.title ?: R.string.session_group_idle)) }
            items(section.rows, key = { it.id }) { task ->
                val status = when {
                    task.id in waiting -> RowStatus.Waiting
                    task.turns.lastOrNull()?.status == TurnStatus.IN_PROGRESS -> RowStatus.Working
                    task.unread -> RowStatus.New
                    else -> RowStatus.Quiet
                }
                ListedSessionRow(vm, nav, task, { nav.navigate("task/${task.id}") }, subtitle = relativeTime(task.updatedAt),
                    selecting = selecting, selected = task.id in selected, onToggle = { on -> selected = if (on) selected + task.id else selected - task.id },
                    onBeginSelect = { selecting = true; selected = setOf(task.id) }) { StatusMark(status) }
            }
            }
        }
        if (!selecting && (BuildConfig.DEMO_MODE || snapshot.cloudCowork)) Composer(vm, nav, draftMode = Mode.COWORK)
    }
    if (bulkDelete) {
        val count = selected.size
        ClaudeDialog(pluralStringResource(R.plurals.chat_list_delete_selected_title, count, count), stringResource(R.string.delete_dialog_default_subtitle),
            stringResource(R.string.chat_menu_delete), onConfirm = {
                val ids = selected.toList()
                bulkBusy = true
                scope.launch {
                    try { ids.forEach { vm.repository.deleteConversation(it) } }
                    catch (e: CancellationException) { throw e }
                    catch (e: Exception) { vm.error.value = e.message ?: context.getString(R.string.generic_error_something_went_wrong_try_again) }
                    finally { bulkBusy = false; bulkDelete = false; endSelection() }
                }
            }, onDismiss = { bulkDelete = false }, destructive = true, busy = bulkBusy)
    }
    moving?.let { ids ->
        ProjectPickerSheet(snapshot.projects, current = tasks.filter { it.id in ids }.mapNotNull { it.projectId }.distinct().singleOrNull(), onDismiss = { moving = null }) { project ->
            moving = null
            vm.work { ChatProjectMoves.move(vm, ids, project.id); vm.error.value = context.getString(R.string.chat_moved_to_project_toast, project.name) }
            endSelection()
        }
    }
}

/** A Cowork task: its transcript, its approvals, open the chat, stop. */
@Composable fun TaskScreen(vm: AppViewModel, nav: NavHostController, id: String) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle(); val c = snapshot.conversations.find { it.id == id }; val turn = c?.turns?.lastOrNull()
    OfficialPage(c?.title?.ifBlank { null } ?: stringResource(R.string.dramatic_shrimp_screen_title), onBack = { nav.popBackStack() }) {
        ConversationContentStatus(vm, id)
        if (c == null) OfficialEmptyState(Anthropicons.tasks, stringResource(R.string.chat_not_found_title), Modifier.weight(1f), subtitle = stringResource(R.string.chat_not_found_message))
        else {
            SharedConversationView(vm, nav, c, Modifier.weight(1f))
            PendingApprovals(vm, id)
        }
        Row(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (turn?.status == TurnStatus.IN_PROGRESS) ClaudeButton(stringResource(R.string.ccr_background_task_stop), { vm.interrupt(id) }, Modifier.weight(1f), variant = ButtonVariant.Secondary, size = ButtonSize.Large, fillWidth = true, icon = Anthropicons.stop)
            ClaudeButton(stringResource(R.string.claudex_task_open_chat), { nav.navigate("conversation/$id") }, Modifier.weight(1f), size = ButtonSize.Large, fillWidth = true, enabled = c != null)
        }
    }
}

/** Diff (`ccr_diff_title`): the file picker and the read-only diff of the session's changes. */
@Composable fun DiffScreen(vm: AppViewModel, nav: NavHostController, id: String) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val conversation = snapshot.conversations.find { it.id == id }
    val turnFiles = conversation?.turns?.flatMap { it.items }?.flatMap { it.changes }.orEmpty()
    var tree by remember(id) { mutableStateOf<List<Change>?>(null) }
    var notice by remember(id) { mutableStateOf(DiffNotice.LOADING) }
    var context by rememberSaveable(id) { mutableIntStateOf(3) }
    var counts by remember(id) { mutableStateOf<Map<String, Int>>(emptyMap()) }
    var scopeBase by rememberSaveable(id) { mutableStateOf<String?>(null) }
    var scopeSha by rememberSaveable(id) { mutableStateOf<String?>(null) }
    var ends by remember(id) { mutableStateOf<DiffScopeEnds?>(null) }
    var commits by remember(id) { mutableStateOf<List<DiffCommit>>(emptyList()) }
    var branches by remember(id) { mutableStateOf<List<String>?>(null) }
    var scopeMenu by remember { mutableStateOf(false) }
    var branchMenu by remember { mutableStateOf(false) }
    var commitMenu by remember { mutableStateOf(false) }
    LaunchedEffect(id, conversation?.mode, context, scopeBase, scopeSha) {
        val repo = vm.repository as? RemoteRepository
        if (repo == null || conversation?.mode != Mode.CODE) {
            tree = null
            counts = emptyMap()
            ends = null
            commits = emptyList()
            notice = DiffListing.notice(true, false, "ready", false, false, turnFiles.isNotEmpty())
            return@LaunchedEffect
        }
        if (tree == null) notice = DiffNotice.LOADING
        try {
            val askedCommit = !scopeSha.isNullOrBlank()
            val scope = JSONObject().put("kind", if (askedCommit) "commit" else "branch")
            if (!scopeBase.isNullOrBlank()) scope.put("base", scopeBase)
            if (askedCommit) scope.put("sha", scopeSha)
            val value = repo.rpc("workingTreeChanges", id, context, scope) as? JSONObject
            val parsed = workingDiffFiles(value?.optString("diff").orEmpty())
            val facts = diffScopeFacts(value)
            tree = parsed
            counts = lineCounts(value?.optJSONObject("lineCounts"))
            ends = facts.first
            commits = facts.second
            if (askedCommit && value?.optString("scope") != "commit") scopeSha = null
            val settled = DiffListing.notice(true, false, value?.optString("state"), value?.optBoolean("truncated") == true, parsed.isNotEmpty(), turnFiles.isNotEmpty())
            notice = diffSettledNotice(settled, (!askedCommit && !scopeBase.isNullOrBlank()) || (askedCommit && !scopeSha.isNullOrBlank()))
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            val hadListing = tree != null
            if (!hadListing) {
                counts = emptyMap()
                ends = null
                commits = emptyList()
            }
            notice = diffRefreshFailure(hadListing, turnFiles.isNotEmpty())
        }
    }
    LaunchedEffect(scopeMenu) {
        if (!scopeMenu) return@LaunchedEffect
        val repo = vm.repository as? RemoteRepository
        branches = if (repo == null) null else try { diffCompareBranches(branchNames(repo.rpc("gitBranches", id)), ends?.head) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
    }
    val files = if (notice == DiffNotice.PARTIAL || notice == DiffNotice.READY || notice == DiffNotice.STALE) tree.orEmpty() else if (notice == DiffNotice.EDITS_ONLY) turnFiles else emptyList()
    var index by rememberSaveable { mutableIntStateOf(0) }; val selected = files.getOrNull(index) ?: files.firstOrNull(); var choose by remember { mutableStateOf(false) }
    val allLines = remember(files) { files.flatMap { presentDiff(it.diff) } }
    val horizontal = rememberScrollState()
    val c = Claude.colors
    val range = ends
    OfficialPage(stringResource(R.string.ccr_diff_title), onBack = { nav.popBackStack() }) {
        ConversationContentStatus(vm, id)
        if (range != null && (notice == DiffNotice.READY || notice == DiffNotice.PARTIAL || notice == DiffNotice.EMPTY || notice == DiffNotice.NONE || notice == DiffNotice.STALE)) {
            SettingsRow(stringResource(R.string.ccr_diff_scope_range, range.base, range.head), { scopeMenu = true },
                trailing = { Icon(Anthropicons.caretDown, null, Modifier.size(20.dp), tint = c.text300) })
        }
        val note = diffNoticeText(notice)
        if (selected == null) {
            OfficialEmptyState(Anthropicons.code, note ?: stringResource(R.string.claudex_diff_empty), Modifier.weight(1f))
            return@OfficialPage
        }
        if (note != null) Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(note, style = Claude.type.body13, color = Claude.colors.text300)
            if (notice == DiffNotice.EDITS_ONLY) Text(stringResource(R.string.ccr_diff_edits_twice), style = Claude.type.body13, color = Claude.colors.text300)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
            SettingsGroup {
                Box {
                    SettingsRow(selected.path.substringAfterLast('/'), { choose = true }, Anthropicons.file,
                        subtitle = "${files.size} · +${allLines.count { it.kind == '+' }} −${allLines.count { it.kind == '-' }}",
                        trailing = { Icon(Anthropicons.caretDown, null, Modifier.size(20.dp), tint = c.text300) })
                    ClaudeDropdownMenu(choose, { choose = false }) { files.forEachIndexed { i, file -> ClaudeMenuItem(file.path, { index = i; choose = false }, selected = i == index) } }
                }
                SettingsTile(padding = PaddingValues(0.dp)) {
                    val face = diffFileFace(selected.diff)
                    val expand = diffExpand(selected.diff, counts[selected.path])
                    val cap = counts[selected.path]?.coerceAtMost(10_000)
                    if (expand != null && cap != null && context < cap) {
                        val name = stringResource(when (expand.way) { DiffExpandWay.ALL -> R.string.ccr_diff_expand_all; DiffExpandWay.UP -> R.string.ccr_diff_expand_up; DiffExpandWay.DOWN -> R.string.ccr_diff_expand_down })
                        Text(stringResource(R.string.ccr_diff_expand_lines, expand.hidden),
                            Modifier.fillMaxWidth().padding(16.dp).clickable(role = Role.Button) { context = cap }.semantics { contentDescription = name },
                            style = Claude.type.body13, color = c.text300)
                    }
                    if (face.binary || (face.hidden && face.renamedFrom == null)) {
                        Text(stringResource(if (face.binary) R.string.ccr_diff_binary else R.string.ccr_diff_hidden), Modifier.padding(16.dp), style = Claude.type.body15, color = c.text300)
                    } else SelectionContainer { Column(Modifier.horizontalScroll(horizontal).widthIn(min = 320.dp)) {
                        face.renamedFrom?.let { Text(stringResource(R.string.ccr_diff_renamed, it), Modifier.padding(horizontal = 8.dp, vertical = 8.dp), style = Claude.type.body13, color = c.text300) }
                        if (!face.hidden) presentDiff(selected.diff).forEach { line ->
                        val background = when (line.kind) { '+' -> c.success900; '-' -> c.danger900; else -> Color.Transparent }
                        Row(Modifier.fillMaxWidth().background(background).padding(vertical = 3.dp, horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text((line.after ?: line.before)?.toString() ?: "", Modifier.width(34.dp), style = Claude.type.code, color = c.text500)
                            Text(line.text, style = Claude.type.code, color = c.text100)
                        }
                    } } }
                }
            }
        }
    }
    if (scopeMenu) ClaudeModalBottomSheet({ scopeMenu = false }) {
        val selectedCommit = commits.firstOrNull { it.sha == scopeSha }
        SettingsRow(stringResource(R.string.ccr_diff_all_changes), { scopeSha = null; scopeBase = null; index = 0; scopeMenu = false },
            subtitle = range?.let { stringResource(R.string.ccr_diff_vs, it.base) },
            trailing = { if (scopeSha == null) Icon(Anthropicons.check, null, Modifier.size(20.dp), tint = c.text500) })
        if (branches != null) SettingsRow(stringResource(R.string.ccr_diff_compare), { scopeMenu = false; branchMenu = true }, subtitle = range?.base)
        if (commits.isNotEmpty()) SettingsRow(stringResource(R.string.ccr_diff_commits), { scopeMenu = false; commitMenu = true },
            subtitle = selectedCommit?.shortSha ?: pluralStringResource(R.plurals.ccr_diff_commit_count, commits.size, commits.size),
            trailing = { if (selectedCommit != null) Icon(Anthropicons.check, null, Modifier.size(20.dp), tint = c.text500) })
    }
    if (branchMenu) ClaudeModalBottomSheet({ branchMenu = false }) {
        ClaudeSheetHeader(stringResource(R.string.ccr_diff_compare), { branchMenu = false })
        val names = branches.orEmpty()
        if (names.isEmpty()) Text(stringResource(R.string.ccr_diff_no_branches), Modifier.padding(24.dp), style = Claude.type.body15, color = c.text300)
        else LazyColumn(Modifier.heightIn(max = 480.dp)) {
            items(names) { name ->
                SettingsRow(name, { scopeBase = name; scopeSha = null; index = 0; branchMenu = false },
                    trailing = { if (name == scopeBase) Icon(Anthropicons.check, null, Modifier.size(20.dp), tint = c.text500) })
            }
        }
    }
    if (commitMenu) ClaudeModalBottomSheet({ commitMenu = false }) {
        ClaudeSheetHeader(stringResource(R.string.ccr_diff_commits), { commitMenu = false })
        LazyColumn(Modifier.heightIn(max = 480.dp)) {
            items(commits, key = { it.sha }) { commit ->
                val subject = commit.subject
                val spoken = if (subject != null) stringResource(R.string.ccr_diff_commit_named, subject)
                    else stringResource(R.string.ccr_diff_commit_unnamed, stringResource(R.string.ccr_diff_no_message), commit.shortSha)
                SettingsRow(commit.shortSha, {
                    if (scopeBase.isNullOrBlank()) scopeBase = range?.base
                    scopeSha = commit.sha
                    index = 0
                    commitMenu = false
                }, subtitle = subject ?: stringResource(R.string.ccr_diff_no_message), modifier = Modifier.semantics { contentDescription = spoken },
                    trailing = { if (commit.sha == scopeSha) Icon(Anthropicons.check, null, Modifier.size(20.dp), tint = c.text500) })
            }
        }
    }
}

/** The sentence for a diff page that is not simply showing a complete tree. */
@Composable private fun diffNoticeText(notice: DiffNotice): String? = when (notice) {
    DiffNotice.LOADING -> stringResource(R.string.ccr_diff_loading)
    DiffNotice.UNAVAILABLE -> stringResource(R.string.ccr_diff_unavailable)
    DiffNotice.UNABLE -> stringResource(R.string.ccr_diff_unable)
    DiffNotice.STALE -> stringResource(R.string.ccr_diff_stale)
    DiffNotice.PARTIAL -> stringResource(R.string.ccr_diff_partial)
    DiffNotice.EDITS_ONLY -> stringResource(R.string.ccr_diff_edits_only)
    DiffNotice.TOO_MANY -> stringResource(R.string.ccr_diff_too_many)
    DiffNotice.EMPTY -> stringResource(R.string.claudex_diff_empty)
    DiffNotice.NONE -> stringResource(R.string.ccr_diff_none)
    DiffNotice.READY -> null
}

/** One file per `diff --git` section of a working-tree diff. */
private fun workingDiffFiles(diff: String): List<Change> = diff.split("diff --git ").filter { it.isNotBlank() }.map { block ->
    val body = "diff --git $block"
    Change(diffNewPath(body) ?: block.lineSequence().firstOrNull().orEmpty().substringBefore(' '), body)
}

private fun branchNames(raw: Any?): List<String> {
    val array = raw as? JSONArray ?: return emptyList()
    return (0 until array.length()).mapNotNull { index -> array.optString(index).takeIf { it.isNotBlank() } }
}

private fun lineCounts(json: JSONObject?): Map<String, Int> {
    if (json == null) return emptyMap()
    val counts = linkedMapOf<String, Int>()
    val keys = json.keys()
    while (keys.hasNext()) {
        val key = keys.next()
        val count = json.optInt(key, -1)
        if (count >= 0) counts[key] = count
    }
    return counts
}
