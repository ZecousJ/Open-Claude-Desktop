@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
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
 * Code: the Devices section (one chip per computer signed in to this
 * account, then "Add device"), the session filter and the cloud Code sessions; the top-bar action and the
 * empty state start a new session on a GitHub repository (route code-new).
 */
@Composable fun CodeScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf(SessionFilter.ALL) }
    var filterMenu by remember { mutableStateOf(false) }
    var search by rememberSaveable { mutableStateOf("") }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val c = Claude.colors
    LaunchedEffect(Unit) { vm.mode.value = Mode.CODE }
    val all = snapshot.conversations.filter { it.mode == Mode.CODE }.sortedByDescending { it.updatedAt }
    val waiting = snapshot.approvals.map { it.conversationId }.toSet()
    // Ready for review: the pull request a finished session made is open and waits for a reviewer (the service answers, SessionList.kt).
    val review by vm.sessionReview.ready.collectAsStateWithLifecycle()
    val askedAbout = SessionReviewPolicy.candidates(all)
    LaunchedEffect(askedAbout) { vm.sessionReview.load(all) }
    val sessions = all.filter { s -> SessionList.matches(filter, s, waiting, review) }.filter { SessionGit.matches(it, search) }
    OfficialPage(stringResource(R.string.code_screen_title), actions = {
        Box {
            ClaudeIconButton(AppGlyphs.filter, stringResource(if (filter == SessionFilter.ALL) R.string.session_list_filter_sessions_a11y else R.string.session_list_filter_change_a11y), { filterMenu = true })
            ClaudeDropdownMenu(filterMenu, { filterMenu = false }) {
                SessionFilter.entries.forEach { option -> ClaudeMenuItem(stringResource(option.label), { filter = option; filterMenu = false }, option.icon, selected = option == filter) }
            }
        }
        ClaudeIconButton(AppGlyphs.chatAdd, stringResource(R.string.new_session), { nav.navigate("code-new") })
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
                        search.isNotBlank() -> OfficialEmptyState(AppGlyphs.searchCircle, stringResource(R.string.empty_state_search_title, search.trim()), Modifier.padding(top = 24.dp))
                        filter != SessionFilter.ALL -> OfficialEmptyState(AppGlyphs.code, stringResource(R.string.session_list_filter_empty), Modifier.padding(top = 24.dp))
                        all.isNotEmpty() -> OfficialEmptyState(AppGlyphs.archive, stringResource(R.string.code_empty_all_sessions_archived_title), Modifier.padding(top = 24.dp),
                            subtitle = stringResource(R.string.code_empty_all_sessions_archived_subtitle))
                        else -> OfficialEmptyState(AppGlyphs.code, stringResource(R.string.code_empty_start_first_session_title), Modifier.padding(top = 24.dp),
                            subtitle = stringResource(R.string.code_empty_start_first_session_subtitle),
                            action = { ClaudeButton(stringResource(R.string.new_session), { nav.navigate("code-new") }, size = ButtonSize.Medium, icon = AppGlyphs.add) })
                    }
                }
                items(sessions, key = { it.id }) { session ->
                    val status = when {
                        session.id in waiting -> RowStatus.Waiting
                        session.turns.lastOrNull()?.status == TurnStatus.IN_PROGRESS -> RowStatus.Working
                        session.unread -> RowStatus.New
                        else -> RowStatus.Quiet
                    }
                    OfficialListRow(session.title.ifBlank { stringResource(R.string.generic_untitled) }, { nav.navigate("conversation/${session.id}") },
                        subtitle = relativeTime(session.updatedAt), pinned = session.pinned, leading = { StatusMark(status) })
                }
            }
        }
    }
}

/** A device chip: pill ≥ 44 dp, 12/4/16/4 padding, raised with a hairline; laptop glyph with the green status dot; name ≤ 112 dp. */
@Composable private fun DeviceChip(label: String, onClick: () -> Unit, clickLabel: String, online: Boolean = true, add: Boolean = false) {
    val c = Claude.colors
    val shape = Claude.shapes.pill
    Row(Modifier.heightIn(min = 44.dp).then(if (online) Modifier.shadow(4.dp, shape, ambientColor = Color.Black.copy(alpha = .08f), spotColor = Color.Black.copy(alpha = .08f)) else Modifier)
        .clip(shape).background(if (online) c.surfaceSunken else Color.Transparent).border(1.dp, c.borderDefault, shape)
        .clickable(onClickLabel = clickLabel, role = Role.Button, onClick = onClick).padding(start = 12.dp, top = 4.dp, end = 16.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(24.dp)) {
            Icon(if (add) AppGlyphs.add else if (online) AppGlyphs.laptop else AppGlyphs.laptopSlash, null, Modifier.size(24.dp), tint = if (online || add) c.textPrimary else c.textTertiary)
            if (online && !add) Box(Modifier.align(Alignment.BottomEnd).size(8.dp).clip(CircleShape).background(c.success100))
        }
        Text(label, Modifier.widthIn(max = 112.dp), style = Claude.type.body15, color = if (online || add) c.textPrimary else c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Devices section: "Devices" and a row of chips — one per computer that has Claudex open and is
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
 * "Connect your computer" sheet with the Claudex instruction in place of the terminal command:
 * open Claudex on the computer and sign in to this account; then come back and pick the computer.
 */
@Composable fun ConnectComputerSheet(computerName: String? = null, dismiss: () -> Unit) {
    val c = Claude.colors
    ClaudeModalBottomSheet(dismiss) {
        ClaudeSheetHeader(stringResource(if (computerName == null) R.string.ccr_devices_setup_title else R.string.ccr_devices_asleep_title), onClose = dismiss)
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, top = 40.dp, bottom = 24.dp).navigationBarsPadding(),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Icon(AppGlyphs.laptop, null, Modifier.size(48.dp), tint = c.textSecondary)
            if (computerName != null) {
                Text(stringResource(R.string.ccr_devices_asleep_lead, computerName), style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
                Text(stringResource(R.string.claudex_devices_asleep_instruction), style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
            } else {
                Text(stringResource(R.string.claudex_devices_setup_body), style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
                Text(stringResource(R.string.ccr_devices_setup_footer), style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
            }
            // The "or" divider and the desktop hint, worded for Claudex.
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f).height(1.dp).background(c.borderDefault))
                Text(stringResource(R.string.ccr_devices_setup_or), Modifier.padding(horizontal = 12.dp), style = Claude.type.body13, color = c.textSecondary)
                Box(Modifier.weight(1f).height(1.dp).background(c.borderDefault))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(AppGlyphs.laptop, null, Modifier.size(20.dp), tint = c.textSecondary)
                Text(stringResource(R.string.claudex_devices_desktop_hint), Modifier.weight(1f), style = Claude.type.body13, color = c.textSecondary)
            }
        }
    }
}

/** A new cloud Code session on a GitHub repository: Repositories, base branch and mode rows, then the composer. */
@Composable fun RepositoryConversationScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle(); val selected by vm.selectedRepository.collectAsStateWithLifecycle()
    var sheet by remember { mutableStateOf(false) }; var permission by remember { mutableStateOf(false) }
    // The Code starter: a chosen suggestion or "Something else…" swaps the composer for Start
    // Session.
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
                SettingsRow(stringResource(R.string.code_project_repos_title), { sheet = true }, AppGlyphs.github, subtitle = selected?.name ?: stringResource(R.string.ccr_connect_github_description))
                SettingsRow(stringResource(R.string.ccr_choose_base_branch), { sheet = true }, AppGlyphs.branch, subtitle = selected?.branch, enabled = selected != null)
                SettingsRow(stringResource(R.string.ccr_sheet_permission_row), { permission = true }, AppGlyphs.hand, subtitle = permissionModeTitle(CodeModePolicy.current(WireCodec.rawSettings)))
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
            else ClaudeButton(stringResource(R.string.code_project_repos_title), { sheet = true }, size = ButtonSize.Large, fillWidth = true, icon = AppGlyphs.github)
            Text(stringResource(R.string.code_starter_connect_own_repo), Modifier.clickable(role = androidx.compose.ui.semantics.Role.Button) { sheet = true }.padding(vertical = 14.dp),
                style = Claude.type.body13, color = Claude.colors.text500)
        }
        else ClaudeButton(stringResource(R.string.code_project_repos_title), { sheet = true }, Modifier.padding(16.dp).navigationBarsPadding(), size = ButtonSize.Large, fillWidth = true,
            icon = AppGlyphs.github, enabled = BuildConfig.DEMO_MODE || snapshot.cloudCode)
    }
    if (sheet) RepositorySheet(vm) { sheet = false }
    if (permission) PermissionSheet(vm) { permission = false }
}

/**
 * Cowork: the cloud task list with the same filter menu as Code; the composer starts a task. Empty states follow: NoSessions is the title
 * alone, AllArchived points at the Archived filter, FilteredEmpty is "No tasks found." with the hand-off line.
 */
@Composable fun CoworkScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf(SessionFilter.ALL) }
    var filterMenu by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.mode.value = Mode.COWORK }
    // The official first-use page stands in for the list until "Get started" is tapped once.
    val starterSeen by vm.coworkStarterSeen.collectAsStateWithLifecycle()
    if (!starterSeen) { CoworkStarterPage(vm::markCoworkStarterSeen); return }
    val waiting = snapshot.approvals.map { it.conversationId }.toSet()
    val everything = snapshot.conversations.filter { it.mode == Mode.COWORK }.sortedByDescending { it.updatedAt }
    val tasks = everything.filter { t -> SessionList.matches(filter, t, waiting, emptySet()) }
    OfficialPage(stringResource(R.string.dramatic_shrimp_screen_title), actions = {
        Box {
            ClaudeIconButton(AppGlyphs.filter, stringResource(if (filter == SessionFilter.ALL) R.string.session_list_filter_sessions_a11y else R.string.session_list_filter_change_a11y), { filterMenu = true })
            ClaudeDropdownMenu(filterMenu, { filterMenu = false }) {
                SessionList.coworkFilters.forEach { option -> ClaudeMenuItem(stringResource(option.label), { filter = option; filterMenu = false }, option.icon, selected = option == filter) }
            }
        }
    }) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(vertical = 8.dp)) {
            if (tasks.isEmpty()) item(key = "empty") {
                when {
                    filter != SessionFilter.ALL -> OfficialEmptyState(AppGlyphs.tasks, stringResource(R.string.cowork_empty_no_tasks_found_title), Modifier.padding(top = 64.dp),
                        subtitle = stringResource(R.string.cowork_empty_no_tasks_subtitle))
                    everything.isNotEmpty() -> OfficialEmptyState(AppGlyphs.archive, stringResource(R.string.cowork_empty_all_tasks_archived_title), Modifier.padding(top = 64.dp),
                        subtitle = stringResource(R.string.cowork_empty_all_tasks_archived_subtitle))
                    else -> OfficialEmptyState(AppGlyphs.tasks, stringResource(R.string.cowork_empty_what_can_claude_tackle_title), Modifier.padding(top = 64.dp),
                        subtitle = if (BuildConfig.DEMO_MODE || snapshot.cloudCowork) null else stringResource(R.string.cowork_unavailable_toast))
                }
            }
            items(tasks, key = { it.id }) { task ->
                val status = when {
                    task.id in waiting -> RowStatus.Waiting
                    task.turns.lastOrNull()?.status == TurnStatus.IN_PROGRESS -> RowStatus.Working
                    task.unread -> RowStatus.New
                    else -> RowStatus.Quiet
                }
                OfficialListRow(task.title.ifBlank { stringResource(R.string.generic_untitled) }, { nav.navigate("task/${task.id}") },
                    subtitle = relativeTime(task.updatedAt), leading = { StatusMark(status) })
            }
        }
        if (BuildConfig.DEMO_MODE || snapshot.cloudCowork) Composer(vm, nav, draftMode = Mode.COWORK)
    }
}

/** A Cowork task: its transcript, its approvals, open the chat, stop. */
@Composable fun TaskScreen(vm: AppViewModel, nav: NavHostController, id: String) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle(); val c = snapshot.conversations.find { it.id == id }; val turn = c?.turns?.lastOrNull()
    OfficialPage(c?.title?.ifBlank { null } ?: stringResource(R.string.dramatic_shrimp_screen_title), onBack = { nav.popBackStack() }) {
        ConversationContentStatus(vm, id)
        if (c == null) OfficialEmptyState(AppGlyphs.tasks, stringResource(R.string.chat_not_found_title), Modifier.weight(1f), subtitle = stringResource(R.string.chat_not_found_message))
        else {
            SharedConversationView(vm, nav, c, Modifier.weight(1f))
            PendingApprovals(vm, id)
        }
        Row(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (turn?.status == TurnStatus.IN_PROGRESS) ClaudeButton(stringResource(R.string.ccr_background_task_stop), { vm.interrupt(id) }, Modifier.weight(1f), variant = ButtonVariant.Secondary, size = ButtonSize.Large, fillWidth = true, icon = AppGlyphs.stop)
            ClaudeButton(stringResource(R.string.claudex_task_open_chat), { nav.navigate("conversation/$id") }, Modifier.weight(1f), size = ButtonSize.Large, fillWidth = true, enabled = c != null)
        }
    }
}

/** Diff (`ccr_diff_title`): the file picker and the read-only diff of the session's changes. */
@Composable fun DiffScreen(vm: AppViewModel, nav: NavHostController, id: String) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle(); val files = snapshot.conversations.find { it.id == id }?.turns?.flatMap { it.items }?.flatMap { it.changes }.orEmpty()
    var index by rememberSaveable { mutableIntStateOf(0) }; val selected = files.getOrNull(index) ?: files.firstOrNull(); var choose by remember { mutableStateOf(false) }
    val allLines = remember(files) { files.flatMap { presentDiff(it.diff) } }
    val horizontal = rememberScrollState()
    val c = Claude.colors
    OfficialPage(stringResource(R.string.ccr_diff_title), onBack = { nav.popBackStack() }) {
        ConversationContentStatus(vm, id)
        if (selected == null) { OfficialEmptyState(AppGlyphs.code, stringResource(R.string.claudex_diff_empty), Modifier.weight(1f)); return@OfficialPage }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
            SettingsGroup {
                Box {
                    SettingsRow(selected.path.substringAfterLast('/'), { choose = true }, AppGlyphs.file,
                        subtitle = "${files.size} · +${allLines.count { it.kind == '+' }} −${allLines.count { it.kind == '-' }}",
                        trailing = { Icon(AppGlyphs.caretDown, null, Modifier.size(20.dp), tint = c.text300) })
                    ClaudeDropdownMenu(choose, { choose = false }) { files.forEachIndexed { i, file -> ClaudeMenuItem(file.path, { index = i; choose = false }, selected = i == index) } }
                }
                SettingsTile(padding = PaddingValues(0.dp)) {
                    SelectionContainer { Column(Modifier.horizontalScroll(horizontal).widthIn(min = 320.dp)) { presentDiff(selected.diff).forEach { line ->
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
}
