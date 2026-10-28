package com.claudex.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import org.json.JSONObject

/**
 * Capabilities with its Memory group: the two switch rows, "Memory from past
 * chats" (the recap), the scope (account or a project), the memory itself with Edit and its saved edits, Reset
 * memory, and — Claudex only — Import memory as an extra row in the same style. The Tool access group is left
 * out: the service has no per-account tool switches (and web search is not offered on mobile).
 */
@Composable fun MemoryScreen(vm: AppViewModel, nav: NavHostController) {
    val api = remember(vm.repository) { (vm.repository as? RemoteRepository)?.let(::ManagementApi) }; val work = rememberPanelWork()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle(); val tick = featureTick(vm)
    var status by remember { mutableStateOf<JSONObject?>(null) }; var document by remember { mutableStateOf<JSONObject?>(null) }; var projectId by rememberSaveable { mutableStateOf<String?>(null) }
    var scopePicker by remember { mutableStateOf(false) }
    var editor by remember { mutableStateOf(false) }; var editText by rememberSaveable { mutableStateOf("") }; var editResult by remember { mutableStateOf<String?>(null) }; var toast by remember { mutableStateOf<String?>(null) }
    var reset by remember { mutableStateOf(false) }; var targetEdit by remember { mutableStateOf<JSONObject?>(null) }
    var importOpen by remember { mutableStateOf(false) }; var importText by rememberSaveable { mutableStateOf("") }; var preview by remember { mutableStateOf<JSONObject?>(null) }; var reflection by remember { mutableStateOf<JSONObject?>(null) }
    suspend fun read() { status = api!!.memoryStatus(); document = if (projectId == null) status?.optJSONObject("global") else api.memoryDoc(projectId) }
    fun load() { if (api != null) work.run(alert = false) { read() } }
    LaunchedEffect(projectId, tick) { load() }
    val editable = api != null && status?.optBoolean("available") == true && status?.optString("reason") != "offline" && !work.busy
    val globalLabel = stringResource(R.string.claudex_memory_scope_account)
    val label = projectId?.let { id -> snapshot.projects.find { it.id == id }?.name } ?: globalLabel
    val c = Claude.colors
    LaunchedEffect(toast) { if (toast != null) { kotlinx.coroutines.delay(2500); toast = null } }
    Box(Modifier.fillMaxSize()) {
    OfficialPage(stringResource(R.string.capabilities_setting_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            if (api == null) { OfficialEmptyState(AppGlyphs.memory, stringResource(R.string.claudex_demo_unavailable), Modifier.padding(top = 48.dp)); return@Column }
            val current = status
            if (current == null) { if (work.failure != null) OfficialErrorState(stringResource(R.string.generic_error_something_went_wrong), ::load, Modifier.padding(top = 48.dp)) else LoadingState(); return@Column }
            SettingsSectionHeader(stringResource(R.string.memory_title))
            val prefs = current.optJSONObject("prefs"); val allowed = current.optJSONObject("allowed")
            SettingsGroup {
                SettingsSwitchRow(stringResource(R.string.memory_search_setting_title), prefs?.optBoolean("searchChats") == true,
                    { on -> work.run { status = api.setMemoryPrefs(searchChats = on) } }, AppGlyphs.search,
                    helper = stringResource(R.string.claudex_memory_search_description), enabled = editable && allowed?.optBoolean("searchChats") == true)
                SettingsSwitchRow(stringResource(R.string.memory_setting_title), prefs?.optBoolean("generate") == true,
                    { on -> work.run { status = api.setMemoryPrefs(generate = on) } }, AppGlyphs.memory,
                    helper = stringResource(R.string.claudex_memory_generate_description), enabled = editable && allowed?.optBoolean("generate") == true)
                val lastRun = current.optJSONObject("lastRun")
                SettingsRow(stringResource(R.string.memory_summary_button_title), { work.run { reflection = api.memoryReflection() } }, AppGlyphs.history,
                    subtitle = if (lastRun != null && lastRun.optLong("at") > 0) stringResource(R.string.memory_preview_last_updated, relativeTime(lastRun.optLong("at"), capitalise = false))
                        else stringResource(R.string.memory_summary_button_description_null_state), subtitleMaxLines = 2, enabled = editable)
            }
            if (!current.optBoolean("available") || current.optString("reason") == "offline") SettingsFootnote(stringResource(when (current.optString("reason")) {
                "policy" -> R.string.claudex_memory_off_policy; "offline" -> R.string.claudex_memory_offline; "server" -> R.string.claudex_memory_off_server; else -> R.string.claudex_memory_off_other }))
            GroupGap()
            SettingsSectionHeader(label)
            SettingsGroup {
                SettingsRow(stringResource(R.string.claudex_memory_scope), { scopePicker = true }, if (projectId == null) AppGlyphs.user else AppGlyphs.projects, subtitle = label, enabled = !work.busy)
                val doc = document
                SettingsTile {
                    if (doc == null || doc.optString("content").isBlank()) Text(stringResource(R.string.claudex_memory_empty), style = Claude.type.body15, color = c.text500)
                    else {
                        SelectionContainer { Text(doc.optString("content"), style = Claude.type.body15, color = c.text100, maxLines = 40, overflow = TextOverflow.Ellipsis) }
                        Spacer(Modifier.height(6.dp))
                        Text(stringResource(R.string.memory_file_updated, epochLabel(doc.optLong("updatedAt"))), style = Claude.type.body13, color = c.text500)
                    }
                }
                SettingsRow(stringResource(R.string.claudex_memory_edit), { editText = ""; editResult = null; editor = true },
                    AppGlyphs.edit, enabled = editable && (projectId == null || snapshot.projects.any { it.id == projectId }))
                doc?.optJSONArray("edits")?.objects().orEmpty().forEach { edit ->
                    SettingsRow(edit.optString("text"), { targetEdit = edit }, AppGlyphs.note, subtitle = epochLabel(edit.optLong("createdAt")), enabled = editable,
                        trailing = { ClaudeIconButton(AppGlyphs.trash, stringResource(R.string.chat_menu_delete), { targetEdit = edit }, enabled = editable, tint = c.text500) })
                }
                if (projectId == null) SettingsRow(stringResource(R.string.claudex_memory_import), { importOpen = true }, AppGlyphs.upload, subtitle = stringResource(R.string.claudex_memory_import_caption), enabled = editable, subtitleMaxLines = 2)
                SettingsRow(stringResource(R.string.memory_reset_title), { reset = true }, AppGlyphs.trash, titleColor = c.dangerText, enabled = editable && document != null)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    toast?.let { PillToast(it, Modifier.align(androidx.compose.ui.Alignment.BottomCenter).padding(bottom = 96.dp)) { toast = null } }
    }
    if (scopePicker) OfficialPickerDialog(stringResource(R.string.claudex_memory_scope),
        listOf(PickerOption("", globalLabel, AppGlyphs.user)) + snapshot.projects.map { PickerOption(it.id, it.name, AppGlyphs.projects) }, projectId ?: "",
        onSelect = { value -> projectId = value.ifBlank { null }; document = null; scopePicker = false }, onDismiss = { scopePicker = false })
    if (editor) {
        val limit = document?.optJSONObject("limits")?.optInt("editChars", 500)?.takeIf { it > 0 } ?: 500
        // The result card of the official sheet: how the change went, then "Done." (memory_edit_result_*).
        TextInputDialog(stringResource(R.string.claudex_memory_edit_title, label), editText, { editText = it.take(limit); editResult = null }, stringResource(R.string.memory_edit_submit),
            { work.run { val result = api!!.updateMemoryEdits(projectId, add = editText); document = result.document; if (!result.outcome.refused) editText = ""; status = api.memoryStatus(); editResult = MemoryEditLine.card(result.outcome) } }, { editor = false },
            description = if (work.busy) stringResource(R.string.memory_edit_updating) else editResult,
            placeholder = stringResource(R.string.memory_edit_placeholder_all), singleLine = false, minLines = 4, busy = work.busy, enabled = editable && editText.isNotBlank())
    }
    if (importOpen) TextInputDialog(stringResource(R.string.claudex_memory_import), importText, { importText = it }, stringResource(R.string.claudex_memory_import_preview),
        { work.run { preview = api!!.previewMemoryImport(importText); importOpen = false } }, { importOpen = false },
        description = stringResource(R.string.claudex_memory_import_description), singleLine = false, minLines = 5, busy = work.busy, enabled = editable && importText.isNotBlank() && importText.length <= 1_000_000)
    preview?.let { merged -> ClaudeAlertDialog(onDismissRequest = { if (!work.busy) preview = null }, title = { Text(stringResource(R.string.claudex_memory_import_confirm_title)) }, text = {
        SelectionContainer { Text(merged.optString("merged")) }
    }, dismissButton = { ClaudeButton(stringResource(R.string.generic_button_cancel), { preview = null }, variant = ButtonVariant.Secondary, size = ButtonSize.Small, enabled = !work.busy) },
        confirmButton = { ClaudeButton(stringResource(R.string.generic_save), { work.run { val saved = api!!.saveMemory(null, merged.getString("merged"), merged.getLong("revision")); preview = null; importText = ""; if (projectId == null) document = saved; status = api.memoryStatus() } },
            size = ButtonSize.Small, enabled = editable, loading = work.busy) }) }
    if (reset) ClaudeDialog(stringResource(R.string.memory_reset_title), stringResource(R.string.memory_reset_description), stringResource(R.string.claudex_memory_reset_confirm), {
        work.run { status = api!!.resetMemory(projectId); reset = false; document = if (projectId == null) status?.optJSONObject("global") else api.memoryDoc(projectId) }
    }, { reset = false }, destructive = true, busy = work.busy)
    targetEdit?.let { edit -> ClaudeDialog(stringResource(R.string.claudex_memory_remove_edit_title), edit.optString("text"), stringResource(R.string.chat_menu_delete), {
        work.run { val result = api!!.updateMemoryEdits(projectId, remove = listOf(edit.getString("id"))); targetEdit = null; document = result.document; status = api.memoryStatus(); toast = MemoryEditLine.text(result.outcome) }
    }, { targetEdit = null }, destructive = true, busy = work.busy) }
    reflection?.let { value -> ClaudeAlertDialog(onDismissRequest = { reflection = null }, title = { Text(stringResource(R.string.memory_summary_title)) }, text = {
        Text(when (value.optString("state")) { "ready" -> value.optString("text"); "off" -> stringResource(R.string.claudex_memory_recap_off); else -> stringResource(R.string.memory_summary_button_description_null_state) })
    }, confirmButton = { ClaudeButton(stringResource(R.string.generic_button_done), { reflection = null }, size = ButtonSize.Small) }) }
    PanelFailureDialog(work)
}

/**
 * API (Claudex-only, strings-feature-map C24) in the Connectors-page style: one row per provider with the group in
 * use and its rate (tap = the picker dialog, then a confirmation), the image-generation model row, and the
 * personal API keys in the Shared-links row pattern.
 */
@Composable fun ApiGroupsScreen(vm: AppViewModel, nav: NavHostController) {
    val generation by vm.api.sessionChanges.collectAsStateWithLifecycle()
    key(generation) { ApiGroupsForGeneration(vm, nav, generation) }
}
@Composable private fun ApiGroupsForGeneration(vm: AppViewModel, nav: NavHostController, generation: Long) {
    val api = remember(vm.repository) { (vm.repository as? RemoteRepository)?.let(::ManagementApi) }
    val work = rememberPanelWork(); val tick = featureTick(vm)
    var groups by remember { mutableStateOf<JSONObject?>(null) }
    var rates by remember { mutableStateOf<Map<Long, Double>>(emptyMap()) }
    var picking by remember { mutableStateOf<JSONObject?>(null) }
    var pending by remember { mutableStateOf<Pair<JSONObject, JSONObject>?>(null) }
    fun load(fresh: Boolean = false) { if (api != null) work.run(alert = false) {
        check(generation == vm.api.sessionGeneration) { "account changed" }
        groups = vm.api.withCurrentSession { api.apiGroups(fresh) }
        check(generation == vm.api.sessionGeneration) { "account changed" }
        rates = emptyMap()
        // Browser-owned read-only REST contracts; these are not runner RPC methods.
        rates = vm.api.withCurrentSession {
            val available = try { vm.api.request("/api/v1/groups/available", authorized = true, method = "GET").opt("data") } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { null }
            val own = try { vm.api.request("/api/v1/groups/rates", authorized = true, method = "GET").opt("data") } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { null }
            ApiGroupPresentation.rates(available, own)
        }
    } }
    LaunchedEffect(tick) { load() }
    OfficialPage(stringResource(R.string.claudex_api_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            if (api == null) { OfficialEmptyState(AppGlyphs.codeBlock, stringResource(R.string.claudex_demo_unavailable), Modifier.padding(top = 48.dp)); return@Column }
            val providers = groups?.optJSONArray("providers")?.objects()
            if (providers == null) { if (work.failure != null) OfficialErrorState(stringResource(R.string.generic_error_something_went_wrong), { load(true) }, Modifier.padding(top = 48.dp)) else LoadingState(); return@Column }
            SettingsSectionHeader(stringResource(R.string.claudex_api_groups))
            if (providers.isEmpty()) SettingsFootnote(stringResource(R.string.claudex_api_no_providers))
            else SettingsGroup {
                providers.forEach { provider ->
                    val choices = provider.optJSONArray("groups")?.objects().orEmpty()
                    val selected = choices.find { !provider.isNull("selected") && it.optLong("id") == provider.optLong("selected") }
                    SettingsRow(provider.optString("name"), { picking = provider }, AppGlyphs.connector,
                        subtitle = selected?.let { it.optString("name") + " · " + ApiGroupPresentation.rateText(rates[it.optLong("id")]) } ?: stringResource(R.string.claudex_api_no_group),
                        enabled = choices.isNotEmpty() && !work.busy)
                }
            }
            SettingsFootnote(stringResource(R.string.claudex_api_groups_footnote) + (ApiGroupPresentation.origin(vm.api.origin)?.let { "\n" + it } ?: ""))
            GroupGap()
            ImageModelSelector(vm, groups) { groups = it }
            GroupGap()
            AccountKeysPanel(vm, groups, rates)
            Spacer(Modifier.height(24.dp))
        }
    }
    picking?.let { provider ->
        val choices = provider.optJSONArray("groups")?.objects().orEmpty()
        OfficialPickerDialog(provider.optString("name"), choices.map { group ->
            PickerOption(group.optLong("id").toString(), group.optString("name"),
                description = stringResource(R.string.claudex_api_group_meta, group.optInt("models"), ApiGroupPresentation.rateText(rates[group.optLong("id")])) +
                    if (group.optBoolean("primary")) " · " + stringResource(R.string.ccr_device_picker_default_badge) else "")
        }, if (provider.isNull("selected")) null else provider.optLong("selected").toString(), onSelect = { value ->
            picking = null
            choices.find { it.optLong("id").toString() == value }?.let { group -> if (provider.isNull("selected") || provider.optLong("selected") != group.optLong("id")) pending = provider to group }
        }, onDismiss = { picking = null })
    }
    pending?.let { (provider, group) -> ClaudeDialog(stringResource(R.string.claudex_api_switch_title),
        stringResource(R.string.claudex_api_switch_body, provider.optString("name"), group.optString("name"), ApiGroupPresentation.rateText(rates[group.optLong("id")])),
        stringResource(R.string.claudex_api_switch_confirm), { work.run {
            check(generation == vm.api.sessionGeneration) { "account changed" }
            val result = vm.api.withCurrentSession { api!!.setApiGroup(provider.getString("id"), group.getLong("id")) }
            check(generation == vm.api.sessionGeneration) { "account changed" }
            groups = result; pending = null
            vm.selectedModel.value = null; vm.repository.refresh()
        } }, { pending = null }, busy = work.busy) }
    PanelFailureDialog(work)
}
