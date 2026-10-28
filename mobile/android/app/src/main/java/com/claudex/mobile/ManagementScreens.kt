@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.*
import kotlinx.coroutines.*
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date
import java.util.TimeZone

internal class PanelWork(private val scope: CoroutineScope) {
    var busy by mutableStateOf(false); private set
    var failure by mutableStateOf<String?>(null)
    var showFailure by mutableStateOf(false)
    private var queuedRead: (suspend () -> Unit)? = null
    fun run(alert: Boolean = true, block: suspend () -> Unit) {
        if (busy) { if (!alert) queuedRead = block; return }
        busy = true; failure = null; showFailure = false
        scope.launch { try { block() } catch (cancelled: CancellationException) { throw cancelled } catch (error: Exception) { failure = error.message ?: UserText.get(R.string.claudex_msg_action_unconfirmed); showFailure = alert } finally { busy = false; val next = queuedRead; queuedRead = null; if (failure == null && next != null) run(alert = false, block = next) } }
    }
}
@Composable internal fun PanelFailureDialog(work: PanelWork) {
    if (work.showFailure && work.failure != null) ClaudeAlertDialog(onDismissRequest = { work.showFailure = false }, title = { Text(stringResource(R.string.generic_error_title)) }, text = { Text(work.failure.orEmpty()) },
        confirmButton = { ClaudeButton(stringResource(R.string.generic_button_okay), { work.showFailure = false }, size = ButtonSize.Small) })
}
@Composable internal fun rememberPanelWork(): PanelWork { val scope = rememberCoroutineScope(); return remember(scope) { PanelWork(scope) } }
@Composable internal fun featureTick(vm: AppViewModel): Long = (vm.repository as? RemoteRepository)?.featureUpdates?.collectAsStateWithLifecycle()?.value ?: 0L
internal fun epochLabel(value: Long) = if (value <= 0) "—" else DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(value))

/** The official schedule caption (`scheduled_task_daily` …) for a task's repeat rule; a cron rule that is a time of day on some weekdays reads like the others. */
@Composable internal fun scheduleLabel(task: JSONObject): String {
    val repeat = task.optJSONObject("repeat") ?: return stringResource(R.string.scheduled_task_not_scheduled_here)
    var kind = repeat.optString("kind"); var time = repeat.optString("time"); var day = repeat.optInt("day")
    val days: List<Int>? = when (kind) {
        "custom" -> repeat.optJSONArray("days")?.let { array -> (0 until array.length()).map { array.optInt(it) } }
        "cron" -> CronRule.asDays(repeat.optString("expression"))?.also { time = it.first }?.second
        else -> null
    }
    if (kind == "cron" && days == null) return stringResource(R.string.claudex_schedule_cron, repeat.optString("expression"))
    if (days != null) {
        val distinct = days.distinct()
        when {
            distinct.size == 7 -> kind = "daily"
            distinct.size == 1 -> { kind = "weekly"; day = distinct[0] }
            distinct.toSet() == setOf(1, 2, 3, 4, 5) -> kind = "weekdays"
            else -> return stringResource(R.string.claudex_schedule_custom, time)
        }
    }
    return when (kind) {
        "manual" -> stringResource(R.string.scheduled_task_manual_only)
        "once" -> stringResource(R.string.scheduled_task_once, epochLabel(repeat.optLong("at")))
        "hourly" -> stringResource(R.string.scheduled_task_hourly) + " · :" + repeat.optInt("minute").toString().padStart(2, '0')
        "daily" -> stringResource(R.string.scheduled_task_daily, time)
        "weekdays" -> stringResource(R.string.scheduled_task_weekdays, time)
        "weekly" -> stringResource(R.string.scheduled_task_weekly, java.text.DateFormatSymbols.getInstance().weekdays.getOrElse(day + 1) { "?" }, time)
        else -> stringResource(R.string.claudex_schedule_custom, time)
    }
}

/** A run's status in the official words: Running / Completed / Cancelled; a failed run keeps Claudex's own word. */
@Composable private fun runStatus(value: String): String = stringResource(when (value) {
    "starting", "running" -> R.string.routine_run_status_running
    "completed" -> R.string.routine_run_status_completed
    "failed" -> R.string.scheduled_task_run_failed
    "interrupted" -> R.string.routine_run_status_cancelled
    else -> R.string.claudex_schedule_not_run
})

/** Starts the official "New task" chat: a new chat with the prefilled request (`scheduled_tasks_new_task_prompt`). */
internal fun startScheduledTaskChat(vm: AppViewModel, nav: NavHostController, prompt: String) {
    vm.switchDraft(null, null, Mode.CHAT); vm.resetNewDraft(); vm.draft.value = prompt
    nav.navigate("home") { popUpTo(nav.graph.id); launchSingleTop = true }
}

/**
 * Scheduled tasks: Active and Inactive sections; each row has the schedule caption and the next
 * run (a paused task is simply in Inactive); a one-time task that has had its run moves to Completed. "New task" offers
 * the official chat entry (the prefilled request) and the Claudex form editor.
 */
@Composable fun RoutinesScreen(vm: AppViewModel, nav: NavHostController) {
    val api = remember(vm.repository) { (vm.repository as? RemoteRepository)?.let(::ManagementApi) }
    val work = rememberPanelWork(); var tasks by remember { mutableStateOf<List<JSONObject>?>(null) }
    var newMenu by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle(); val tick = featureTick(vm)
    fun load() { if (api != null) work.run(alert = false) { tasks = api.schedules() } }
    LaunchedEffect(tick) { load() }
    val prompt = stringResource(R.string.scheduled_tasks_new_task_prompt)
    val canCreate = api != null && (snapshot.cloudCode || snapshot.cloudCowork)
    val c = Claude.colors
    OfficialPage(stringResource(R.string.scheduled_tasks_title), actions = {
        Box {
            ClaudeIconButton(AppGlyphs.add, stringResource(R.string.scheduled_tasks_new_task), { newMenu = true })
            ClaudeDropdownMenu(newMenu, { newMenu = false }) {
                ClaudeMenuItem(stringResource(R.string.claudex_schedule_new_in_chat), { newMenu = false; startScheduledTaskChat(vm, nav, prompt) }, AppGlyphs.chat)
                ClaudeMenuItem(stringResource(R.string.claudex_schedule_new_form), { newMenu = false; nav.navigate("routine-edit/new") }, AppGlyphs.edit, enabled = canCreate)
            }
        }
    }) {
        PullToRefreshBox(refreshing, onRefresh = { scope.launch { refreshing = true; if (api != null) runCatching { tasks = api.schedules() }; refreshing = false } }, Modifier.weight(1f).fillMaxWidth()) {
            val list = tasks
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 12.dp)) {
                when {
                    api == null -> item { OfficialEmptyState(AppGlyphs.clock, stringResource(R.string.claudex_demo_unavailable), Modifier.padding(top = 48.dp)) }
                    list == null && work.failure != null -> item { OfficialErrorState(stringResource(R.string.scheduled_tasks_error_retry), ::load, Modifier.padding(top = 48.dp)) }
                    list == null -> item { LoadingState() }
                    list.isEmpty() -> item {
                        OfficialEmptyState(AppGlyphs.clock, stringResource(R.string.scheduled_tasks_empty_title), Modifier.padding(top = 48.dp), subtitle = stringResource(R.string.scheduled_tasks_empty_subtitle),
                            action = { ClaudeButton(stringResource(R.string.scheduled_tasks_new_task), { startScheduledTaskChat(vm, nav, prompt) }, icon = AppGlyphs.add) })
                    }
                    else -> ManagementApi.sections(list).let { (active, inactive, completed) -> listOf(R.string.scheduled_tasks_section_active to active, R.string.scheduled_tasks_section_inactive to inactive, R.string.scheduled_tasks_section_completed to completed) }
                        .filter { it.second.isNotEmpty() }.forEach { (header, rows) ->
                            item(key = "header:$header") { SettingsSectionHeader(stringResource(header), Modifier.padding(top = 8.dp)) }
                            items(rows.sortedBy { it.optLong("nextRunAt", Long.MAX_VALUE) }, key = { it.optString("id") }) { task ->
                                val repeatKind = task.optJSONObject("repeat")?.optString("kind")
                                val manual = repeatKind == "manual"
                                val next = task.optLong("nextRunAt").takeIf { it > 0 && task.optBoolean("enabled") && !manual && repeatKind != "once" }
                                val ranOnce = ManagementApi.isCompletedOnce(task)
                                val running = task.optString("lastRunStatus") in listOf("starting", "running")
                                OfficialListRow(task.optString("name").ifBlank { stringResource(R.string.untitled_task) }, { nav.navigate("routine/${android.net.Uri.encode(task.getString("id"))}") },
                                    subtitle = listOfNotNull(scheduleLabel(task), next?.let { stringResource(R.string.scheduled_task_next_at, epochLabel(it)) }, if (ranOnce) stringResource(R.string.routine_badge_ran_once) else null).joinToString(" · "),
                                    startPadding = 12.dp, leading = { Icon(AppGlyphs.clock, null, Modifier.size(20.dp), tint = c.text500) },
                                    trailing = if (running) ({ StatusMark(RowStatus.Working) }) else null)
                            }
                        }
                }
            }
        }
    }
    PanelFailureDialog(work)
}

/**
 * A scheduled task (`routine_detail_*`): Status (with the Task active switch), Schedule, Next run, Last run,
 * Model, Instructions; Run now and Edit task; the run history; Delete task.
 */
@Composable fun RoutineScreen(vm: AppViewModel, nav: NavHostController, id: String) {
    val api = remember(vm.repository) { (vm.repository as? RemoteRepository)?.let(::ManagementApi) }
    val work = rememberPanelWork(); var task by remember(id) { mutableStateOf<JSONObject?>(null) }; var runs by remember(id) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var loaded by remember(id) { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }; var toast by remember { mutableStateOf<String?>(null) }; val tick = featureTick(vm)
    val started = stringResource(R.string.scheduled_task_run_started)
    LaunchedEffect(toast) { if (toast != null) { delay(2500); toast = null } }
    suspend fun read() { task = api!!.schedules().find { it.optString("id") == id }; runs = if (task != null) api.routineRuns(id) else emptyList(); loaded = true }
    fun load() { if (api != null) work.run(alert = false) { read() } }
    LaunchedEffect(id, tick) { load() }
    val c = Claude.colors
    val current = task
    Box(Modifier.fillMaxSize()) {
    OfficialPage(current?.optString("name")?.ifBlank { stringResource(R.string.untitled_task) } ?: stringResource(R.string.scheduled_tasks_title), onBack = { nav.popBackStack() }, actions = {
        if (current != null) ClaudeIconButton(AppGlyphs.edit, stringResource(R.string.scheduled_task_edit), { nav.navigate("routine-edit/${android.net.Uri.encode(id)}") }, enabled = !work.busy)
    }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            if (current == null) {
                if (loaded || api == null) OfficialEmptyState(AppGlyphs.clock, stringResource(R.string.claudex_schedule_missing), Modifier.padding(top = 48.dp))
                else if (work.failure != null) OfficialErrorState(stringResource(R.string.scheduled_tasks_error_retry), ::load, Modifier.padding(top = 48.dp)) else LoadingState()
                return@Column
            }
            val running = current.optString("lastRunStatus") in listOf("starting", "running")
            SettingsSectionHeader(stringResource(R.string.scheduled_task_detail_details))
            SettingsGroup {
                SettingsSwitchRow(stringResource(R.string.scheduled_task_toggle_description), current.optBoolean("enabled"),
                    { value -> if (api != null) work.run { task = api.saveSchedule(ManagementApi.schedulePatch(current, enabled = value)); runs = api.routineRuns(id) } }, AppGlyphs.clock,
                    helper = if (current.optBoolean("enabled")) stringResource(R.string.scheduled_task_detail_active) else stringResource(R.string.scheduled_task_paused), enabled = !work.busy)
                SettingsValueRow(stringResource(R.string.scheduled_task_detail_repeats), scheduleLabel(current))
                if (current.optJSONObject("repeat")?.optString("kind") != "manual" && !ManagementApi.isCompletedOnce(current)) SettingsValueRow(stringResource(R.string.routine_detail_next_run), epochLabel(current.optLong("nextRunAt")))
                SettingsValueRow(stringResource(R.string.routine_detail_last_run), runStatus(current.optString("lastRunStatus")))
                SettingsValueRow(stringResource(R.string.scheduled_task_model), current.optString("model").ifBlank { stringResource(R.string.scheduled_task_model_default) })
            }
            current.stringOrNull("lastError")?.let { SettingsFootnote(it) }
            if (current.optJSONObject("repeat")?.optString("kind") !in listOf(null, "manual", "once")) SettingsFootnote(stringResource(R.string.claudex_schedule_server_time, TimeZone.getDefault().id))
            ManagementApi.permissionOf(current)?.let { mode ->
                GroupGap()
                SettingsSectionHeader(stringResource(R.string.scheduled_task_detail_permissions))
                SettingsGroup { SettingsTile {
                    Text(stringResource(permissionTitle(mode)), style = Claude.type.body17, color = c.text100)
                    Text(stringResource(permissionDescription(mode)), style = Claude.type.body15, color = c.text500)
                } }
            }
            AlwaysAllowedSection(ManagementApi.allowed(current))
            GroupGap()
            SettingsSectionHeader(stringResource(R.string.routine_detail_instructions))
            SettingsGroup { SettingsTile { SelectionContainer { Text(current.optString("prompt"), style = Claude.type.body15, color = c.text100) } } }
            GroupGap()
            SettingsGroup {
                SettingsRow(stringResource(R.string.scheduled_task_run_now), { if (api != null) work.run { task = api.runSchedule(id); runs = api.routineRuns(id); toast = started } }, AppGlyphs.play, enabled = !work.busy && !running)
                SettingsRow(stringResource(R.string.scheduled_task_edit), { nav.navigate("routine-edit/${android.net.Uri.encode(id)}") }, AppGlyphs.edit, enabled = !work.busy)
            }
            GroupGap()
            SettingsSectionHeader(stringResource(R.string.scheduled_task_detail_history))
            if (runs.isEmpty()) Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(stringResource(R.string.cowork_scheduled_empty_title), style = Claude.type.body17, color = c.text500, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                Spacer(Modifier.height(4.dp))
                Text(stringResource(R.string.cowork_scheduled_empty_subtitle), style = Claude.type.body15, color = c.text500, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
            else SettingsGroup {
                runs.forEach { run ->
                    val conversation = run.stringOrNull("conversationId")
                    SettingsRow(runStatus(run.optString("status")), { conversation?.let { work.run { vm.repository.refresh(); nav.navigate("task/${android.net.Uri.encode(it)}") } } },
                        if (run.optString("trigger") == "manual") AppGlyphs.play else AppGlyphs.clock,
                        subtitle = listOfNotNull(epochLabel(run.optLong("startedAt")), run.stringOrNull("error")).joinToString(" · "), subtitleMaxLines = 3, enabled = conversation != null && !work.busy)
                }
            }
            GroupGap()
            SettingsGroup { SettingsRow(stringResource(R.string.scheduled_task_delete), { confirmDelete = true }, AppGlyphs.trash, titleColor = c.dangerText, enabled = !work.busy) }
            Spacer(Modifier.height(24.dp))
        }
    }
    if (confirmDelete && current != null && api != null) {
        ClaudeDialog(
            title = stringResource(R.string.scheduled_task_delete), body = stringResource(R.string.scheduled_task_delete_dialog_description),
            confirmLabel = stringResource(R.string.scheduled_task_delete_confirm),
            onConfirm = { work.run { api.deleteSchedule(id); confirmDelete = false; nav.popBackStack() } },
            onDismiss = { confirmDelete = false }, destructive = true, busy = work.busy)
    }
    toast?.let { PillToast(it, Modifier.align(Alignment.BottomCenter).padding(bottom = 32.dp)) { toast = null } }
    }
    PanelFailureDialog(work)
}

/**
 * The task's edit screen: name, instructions, the model (and for a new task where it runs), and the
 * Schedule section: Repeats (Manual only / Hourly / Daily / Weekdays / Weekly / Custom, a cron expression), Day, Time,
 * in the service's time. Once takes a date and a time in this phone's time zone (an absolute moment); Permission picks how
 * the task's runs are approved (Manual, Auto, Skip all approvals). Discarding changes asks first.
 */
@Composable fun RoutineEditorScreen(vm: AppViewModel, nav: NavHostController, id: String) {
    val api = remember(vm.repository) { (vm.repository as? RemoteRepository)?.let(::ManagementApi) }
    val work = rememberPanelWork()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val isNew = id == "new"
    var original by remember(id) { mutableStateOf<JSONObject?>(null) }
    var ready by remember(id) { mutableStateOf(isNew) }
    LaunchedEffect(id) { if (!isNew && api != null) work.run(alert = false) { original = api.schedules().find { it.optString("id") == id }; ready = true } }
    OfficialPage(stringResource(if (isNew) R.string.scheduled_tasks_new_task else R.string.scheduled_task_edit), onBack = { nav.popBackStack() }) {
        if (api == null) { OfficialEmptyState(AppGlyphs.clock, stringResource(R.string.claudex_demo_unavailable), Modifier.weight(1f)); return@OfficialPage }
        if (!ready) { Box(Modifier.weight(1f).fillMaxWidth()) { LoadingState() }; return@OfficialPage }
        if (!isNew && original == null) { OfficialEmptyState(AppGlyphs.clock, stringResource(R.string.claudex_schedule_missing), Modifier.weight(1f)); return@OfficialPage }
        RoutineForm(vm, snapshot, original, work.busy, Modifier.weight(1f), onDone = { nav.popBackStack() }) { input ->
            work.run { val saved = api.saveSchedule(input)
                if (isNew) nav.navigate("routine/${android.net.Uri.encode(saved.getString("id"))}") { popUpTo("routines") } else nav.popBackStack() }
        }
    }
    PanelFailureDialog(work)
}

@Composable private fun RoutineForm(vm: AppViewModel, snapshot: Snapshot, original: JSONObject?, busy: Boolean, modifier: Modifier, onDone: () -> Unit, save: (JSONObject) -> Unit) {
    val originalRepeat = original?.optJSONObject("repeat")
    val originalKind = originalRepeat?.optString("kind") ?: "manual"
    // Chosen days from before (and a cron rule) are the editor's Custom: a cron expression.
    val initialKind = if (originalKind == "cron") "custom" else originalKind
    val initialCron = when (originalKind) {
        "cron" -> originalRepeat?.optString("expression").orEmpty()
        "custom" -> CronRule.forDays(originalRepeat?.optString("time").orEmpty().ifBlank { "09:00" }, originalRepeat?.optJSONArray("days")?.let { a -> (0 until a.length()).map { a.optInt(it) } }.orEmpty())
        else -> ""
    }
    var name by rememberSaveable { mutableStateOf(original?.optString("name").orEmpty()) }; var prompt by rememberSaveable { mutableStateOf(original?.optString("prompt").orEmpty()) }
    var mode by rememberSaveable { mutableStateOf(original?.optString("mode") ?: if (snapshot.cloudCowork) "cowork" else "code") }
    var selected by remember { mutableStateOf(original?.let { o -> snapshot.models.find { it.id == o.optString("model") && it.providerId == o.optString("providerId") } } ?: if (original == null) vm.model() else null) }
    var modelTouched by remember { mutableStateOf(false) }
    var kind by rememberSaveable { mutableStateOf(initialKind) }
    var time by rememberSaveable { mutableStateOf(originalRepeat?.optString("time")?.takeIf { it.isNotBlank() } ?: "09:00") }
    var minute by rememberSaveable { mutableStateOf((originalRepeat?.optInt("minute") ?: 0).toString()) }
    var day by rememberSaveable { mutableStateOf((originalRepeat?.optInt("day") ?: 1).toString()) }
    var cron by rememberSaveable { mutableStateOf(initialCron) }
    var failure by remember { mutableStateOf<String?>(null) }
    var picker by remember { mutableStateOf<String?>(null) }
    var discard by remember { mutableStateOf(false) }
    val ruleKnown = initialKind in listOf("manual", "once", "hourly", "daily", "weekdays", "weekly", "custom")
    val originalAt = if (originalKind == "once") originalRepeat?.optLong("at") ?: 0L else 0L
    // One-time: the moment is absolute (picked in this phone's time zone); a new one starts tomorrow at the next whole hour.
    var onceAt by rememberSaveable { mutableStateOf(originalAt.takeIf { it > 0 } ?: defaultOnceMoment(System.currentTimeMillis())) }
    val originalPermission = original?.let { ManagementApi.permissionOf(it) }
    var permission by rememberSaveable { mutableStateOf(originalPermission ?: "bypass") }
    var permissionTouched by rememberSaveable { mutableStateOf(false) }
    val completedOriginal = original != null && ManagementApi.isCompletedOnce(original)
    // A moment that has passed can only be kept by a one-time task that is merely waiting for its run (or paused).
    val oncePast = kind == "once" && ManagementApi.oncePast(onceAt, System.currentTimeMillis()) && (original == null || kind != originalKind || onceAt != originalAt || completedOriginal)
    val cronProblem = if (kind == "custom") CronRule.problem(cron) else null
    val dirty = name != original?.optString("name").orEmpty() || prompt != original?.optString("prompt").orEmpty() || kind != initialKind || modelTouched || permissionTouched || (original != null && kind == "once" && onceAt != originalAt) ||
        (original != null && (time != (originalRepeat?.optString("time")?.takeIf { it.isNotBlank() } ?: "09:00") || minute != (originalRepeat?.optInt("minute") ?: 0).toString() || day != (originalRepeat?.optInt("day") ?: 1).toString() || cron != initialCron))
    androidx.activity.compose.BackHandler(dirty && !busy) { discard = true }
    val kinds = listOf("manual" to stringResource(R.string.scheduled_task_manual_only), "once" to stringResource(R.string.routine_create_frequency_once), "hourly" to stringResource(R.string.routine_create_frequency_hourly),
        "daily" to stringResource(R.string.routine_create_frequency_daily), "weekdays" to stringResource(R.string.routine_create_frequency_weekdays),
        "weekly" to stringResource(R.string.routine_create_frequency_weekly), "custom" to stringResource(R.string.routine_create_frequency_custom))
    val c = Claude.colors
    Column(modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            Column(Modifier.padding(horizontal = 16.dp)) {
                FieldLabel(stringResource(R.string.generic_name_label))
                SettingsTextField(name, { name = it.take(120) })
                Spacer(Modifier.height(16.dp))
                FieldLabel(stringResource(R.string.routine_detail_instructions))
                SettingsTextField(prompt, { prompt = it.take(100_000) }, singleLine = false, minLines = 4, maxLines = 12)
            }
            GroupGap()
            SettingsGroup {
                if (original == null) SettingsRow(stringResource(R.string.claudex_schedule_runs_in), { picker = "mode" }, if (mode == "cowork") AppGlyphs.tasks else AppGlyphs.code,
                    subtitle = stringResource(if (mode == "cowork") R.string.dramatic_shrimp_screen_title else R.string.code_screen_title))
                SettingsRow(stringResource(R.string.scheduled_task_model), { picker = "model" }, AppGlyphs.agent,
                    subtitle = selected?.name ?: original?.takeIf { !it.optBoolean("defaultModel", true) }?.optString("model")?.ifBlank { null } ?: stringResource(R.string.scheduled_task_model_default))
            }
            GroupGap()
            SettingsSectionHeader(stringResource(R.string.scheduled_task_edit_schedule))
            SettingsGroup {
                SettingsRow(stringResource(R.string.scheduled_task_detail_repeats), { picker = "kind" }, AppGlyphs.clock, subtitle = kinds.find { it.first == kind }?.second ?: kind, enabled = ruleKnown)
                if (kind == "once") {
                    SettingsRow(stringResource(R.string.scheduled_task_edit_date), { picker = "date" }, AppGlyphs.calendar, subtitle = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(onceAt)))
                    SettingsRow(stringResource(R.string.routine_create_time_label), { picker = "time" }, AppGlyphs.clock, subtitle = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(onceAt)))
                }
                if (kind == "hourly") SettingsTile { FieldLabel(stringResource(R.string.claudex_schedule_minute)); SettingsTextField(minute, { minute = it.filter(Char::isDigit).take(2) }) }
                if (kind == "weekly") SettingsRow(stringResource(R.string.routine_create_day_label), { picker = "day" }, AppGlyphs.calendar,
                    subtitle = java.text.DateFormatSymbols.getInstance().weekdays.getOrElse((day.toIntOrNull() ?: 1) + 1) { "?" })
                if (kind in listOf("daily", "weekdays", "weekly")) SettingsTile { FieldLabel(stringResource(R.string.routine_create_time_label)); SettingsTextField(time, { time = it.take(5) }, placeholder = "09:00") }
                if (kind == "custom") SettingsTile { FieldLabel(stringResource(R.string.scheduled_task_edit_cron_expression)); SettingsTextField(cron, { cron = it.take(100) }, placeholder = stringResource(R.string.routine_create_custom_cron_placeholder)) }
            }
            if (!ruleKnown) SettingsFootnote(stringResource(R.string.claudex_schedule_rule_web))
            if (cronProblem != null && cron.isNotBlank()) Text(stringResource(when (cronProblem) {
                CronRule.Problem.SUB_HOURLY -> R.string.routine_create_custom_cron_subhourly_error
                CronRule.Problem.NUMERIC_ONLY -> R.string.claudex_schedule_cron_numeric
                CronRule.Problem.SUNDAY_IS_ZERO -> R.string.claudex_schedule_cron_sunday
                CronRule.Problem.INVALID -> R.string.claudex_schedule_cron_invalid
            }), Modifier.padding(horizontal = 24.dp, vertical = 8.dp), style = Claude.type.body13, color = c.dangerText)
            if (oncePast) Text(stringResource(R.string.routine_create_time_past_error), Modifier.padding(horizontal = 24.dp, vertical = 8.dp), style = Claude.type.body13, color = c.dangerText)
            if (kind == "once") SettingsFootnote(stringResource(R.string.claudex_schedule_once_zone, TimeZone.getDefault().id))
            else if (kind != "manual") SettingsFootnote(stringResource(R.string.claudex_schedule_server_time, TimeZone.getDefault().id))
            GroupGap()
            SettingsGroup {
                SettingsRow(stringResource(R.string.scheduled_task_edit_permission), { picker = "permission" },
                    when (permission) { "default" -> AppGlyphs.hand; "auto" -> AppGlyphs.lightning; else -> AppGlyphs.warningShield },
                    subtitle = if (original != null && originalPermission == null && !permissionTouched) stringResource(R.string.claudex_schedule_permission_code_setting) else stringResource(permissionTitle(permission)))
            }
            failure?.let { Text(it, Modifier.padding(horizontal = 24.dp, vertical = 8.dp), style = Claude.type.body13, color = c.dangerText) }
            Spacer(Modifier.height(24.dp))
        }
        ClaudeButton(stringResource(R.string.generic_save), {
            runCatching {
                var base = if (original != null) ManagementApi.schedulePatch(original, name, prompt) else ManagementApi.manualSchedule(name, prompt, mode, selected ?: error("model"), System.currentTimeMillis())
                if (original != null && modelTouched) selected?.let { base = base.put("providerId", it.providerId).put("model", it.id).put("defaultModel", false) }
                if (ruleKnown && (original == null || kind != originalKind || kind != "manual")) base = ManagementApi.withRepeat(base, ManagementApi.repeatRule(kind, time, minute.toIntOrNull() ?: -1, day.toIntOrNull() ?: -1, cron, onceAt))
                // A one-time task that has had its run is switched on again by its new moment.
                if (kind == "once" && completedOriginal) base = JSONObject(base.toString()).put("enabled", true)
                if (permissionTouched || original == null) base = ManagementApi.withPermission(base, permission)
                base
            }.onSuccess { failure = null; save(it) }.onFailure { failure = it.message?.takeIf { m -> m.length > 3 } ?: "—" }
        }, Modifier.padding(16.dp).navigationBarsPadding(), size = ButtonSize.Large, fillWidth = true, loading = busy,
            enabled = !busy && name.isNotBlank() && prompt.isNotBlank() && (original != null || selected != null) && (kind != "custom" || cronProblem == null) && !oncePast)
    }
    when (picker) {
        "mode" -> OfficialPickerDialog(stringResource(R.string.claudex_schedule_runs_in), listOf(
            PickerOption("cowork", stringResource(R.string.dramatic_shrimp_screen_title), AppGlyphs.tasks, enabled = snapshot.cloudCowork),
            PickerOption("code", stringResource(R.string.code_screen_title), AppGlyphs.code, enabled = snapshot.cloudCode)), mode, { mode = it; picker = null }, { picker = null })
        "model" -> OfficialPickerDialog(stringResource(R.string.ccr_select_model_title), snapshot.models.map { PickerOption(it.providerId + "\u0000" + it.id, it.name) },
            selected?.let { it.providerId + "\u0000" + it.id }, { value -> selected = snapshot.models.find { it.providerId + "\u0000" + it.id == value }; modelTouched = true; picker = null }, { picker = null })
        "kind" -> OfficialPickerDialog(stringResource(R.string.scheduled_task_detail_repeats), kinds.map { PickerOption(it.first, it.second) }, kind, { kind = it; picker = null }, { picker = null })
        "date" -> OnceDateDialog(onceAt, { onceAt = it; picker = null }, { picker = null })
        "time" -> OnceTimeDialog(onceAt, { onceAt = it; picker = null }, { picker = null })
        "permission" -> OfficialPickerDialog(stringResource(R.string.scheduled_task_edit_permission), ManagementApi.permissionModes.map { PickerOption(it, stringResource(permissionTitle(it)), when (it) { "default" -> AppGlyphs.hand; "auto" -> AppGlyphs.lightning; else -> AppGlyphs.warningShield }, stringResource(permissionDescription(it))) },
            permission, { permission = it; permissionTouched = true; picker = null }, { picker = null })
        "day" -> OfficialPickerDialog(stringResource(R.string.routine_create_day_label), (0..6).map { PickerOption(it.toString(), java.text.DateFormatSymbols.getInstance().weekdays[it + 1]) }, day, { day = it; picker = null }, { picker = null })
    }
    if (discard) ClaudeDialog(stringResource(R.string.scheduled_task_edit_discard_title), null, stringResource(R.string.scheduled_task_edit_discard), { discard = false; onDone() }, { discard = false },
        destructive = true, cancelLabel = stringResource(R.string.scheduled_task_edit_keep_editing))
}

/** The official approval-mode words (`approval_mode_*`) for a task's permission mode. */
internal fun permissionTitle(mode: String) = when (mode) { "default" -> R.string.approval_mode_manual_title; "auto" -> R.string.approval_mode_auto_title; else -> R.string.approval_mode_skip_title }
internal fun permissionDescription(mode: String) = when (mode) { "default" -> R.string.approval_mode_manual_description; "auto" -> R.string.approval_mode_auto_description; else -> R.string.approval_mode_skip_description }

/** A new one-time task starts tomorrow at the next whole hour (this phone's time zone). */
internal fun defaultOnceMoment(now: Long): Long = java.time.Instant.ofEpochMilli(now).atZone(java.time.ZoneId.systemDefault())
    .plusHours(1).truncatedTo(java.time.temporal.ChronoUnit.HOURS).plusDays(1).toInstant().toEpochMilli()

/** "Always allowed" (`scheduled_task_detail_always_allowed`): the approvals kept for the task, three at first, then Show all. */
@Composable private fun AlwaysAllowedSection(items: List<ScheduleAllowed>) {
    if (items.isEmpty()) return
    var all by remember { mutableStateOf(false) }
    val c = Claude.colors
    GroupGap()
    SettingsSectionHeader(stringResource(R.string.scheduled_task_detail_always_allowed))
    SettingsGroup {
        (if (all) items else items.take(3)).forEach { entry ->
            val tool = when {
                entry.kind == "command" && entry.tool == "Network" -> stringResource(R.string.claudex_allowed_network)
                entry.kind == "command" -> stringResource(R.string.claudex_allowed_command)
                entry.kind == "edit" -> stringResource(R.string.claudex_allowed_edit)
                entry.kind == "permission" -> stringResource(R.string.claudex_allowed_permission)
                else -> entry.tool
            }
            SettingsTile { Text(if (entry.pattern != null) stringResource(R.string.scheduled_task_detail_allowed_tool_with_pattern, tool, entry.pattern) else tool, style = Claude.type.body15, color = c.text100, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        }
        if (items.size > 3) SettingsRow(stringResource(if (all) R.string.scheduled_task_detail_allowed_tools_show_less else R.string.scheduled_task_detail_allowed_tools_show_all), { all = !all })
    }
}
