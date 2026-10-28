@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.claudex.core.RepositoryChoice
import com.claudex.core.TurnStatus
import org.json.JSONObject
import java.net.URLEncoder

private fun query(value: String) = URLEncoder.encode(value, "UTF-8")

/**
 * Repositories sheet (`CodeRemoteBottomSheetDestination.RepositorySelection`, "Repositories"), then
 * "Choose base branch". Not connected: the Connect to GitHub state, which opens GitHub in the browser
 * after a confirmation.
 */
@Composable fun RepositorySheet(vm: AppViewModel, dismiss: () -> Unit) {
    var search by remember { mutableStateOf("") }; var repos by remember { mutableStateOf<List<JSONObject>>(emptyList()) }; var branches by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var selected by remember { mutableStateOf<JSONObject?>(null) }; var branch by remember { mutableStateOf("") }; var nextPage by remember { mutableIntStateOf(1) }
    var loading by remember { mutableStateOf(false) }; var status by remember { mutableStateOf<JSONObject?>(null) }; var failure by remember { mutableStateOf<String?>(null) }; var loaded by remember { mutableStateOf(false) }; var confirmConnect by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val c = Claude.colors
    fun fetch(reset: Boolean = false) { loading = true; failure = null; vm.work { try {
        if (BuildConfig.DEMO_MODE) { repos = listOf(JSONObject().put("full_name", "ZecousJ/Open-Claude-Desktop").put("clone_url", "https://github.com/ZecousJ/Open-Claude-Desktop.git").put("default_branch", "main")); nextPage = 0 }
        else { status = vm.api.request("/api/v1/claudex/web/github", authorized = true, method = "GET").getJSONObject("data"); if (status?.optBoolean("connected") == true) { val page = if (reset) 1 else nextPage; val data = vm.api.request("/api/v1/claudex/web/github/repos?query=${query(search)}&page=$page", authorized = true, method = "GET").getJSONObject("data"); repos = (if (reset) emptyList() else repos) + data.optJSONArray("items")?.objects().orEmpty(); nextPage = data.optInt("next_page", 0) } }
    } catch (e: Exception) { failure = context.getString(R.string.ccr_failed_to_load_repositories) } finally { loading = false; loaded = true } } }
    fun select(repo: JSONObject) { selected = repo; branch = repo.optString("default_branch"); loading = true; failure = null; vm.work { try { branches = if (BuildConfig.DEMO_MODE) listOf(JSONObject().put("name", "main")) else vm.api.request("/api/v1/claudex/web/github/branches?repo=${query(repo.getString("full_name"))}&page=1", authorized = true, method = "GET").getJSONObject("data").optJSONArray("items")?.objects().orEmpty() } catch (e: Exception) { failure = context.getString(R.string.ccr_failed_to_load_branches) } finally { loading = false } } }
    LaunchedEffect(Unit) { fetch(true) }
    LaunchedEffect(search) { if (selected == null && status?.optBoolean("connected") == true) { kotlinx.coroutines.delay(300); fetch(true) } }
    ClaudeModalBottomSheet(onDismissRequest = dismiss) {
        val current = selected
        ClaudeSheetHeader(stringResource(if (current == null) R.string.code_project_repos_title else R.string.ccr_choose_base_branch), onClose = if (current == null) dismiss else ({ selected = null }))
        failure?.let { Text(it, Modifier.padding(horizontal = 20.dp, vertical = 4.dp), style = Claude.type.body13, color = c.dangerText) }
        if (current == null) {
            if (!BuildConfig.DEMO_MODE && status?.optBoolean("connected") == false) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 24.dp).navigationBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Icon(AppGlyphs.github, null, Modifier.size(48.dp), tint = c.textSecondary)
                    Text(stringResource(R.string.ccr_connect_github_title), style = Claude.type.body17Strong, color = c.text100)
                    Text(stringResource(R.string.ccr_connect_github_description), style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
                    ClaudeButton(stringResource(R.string.ccr_connect_github_title), { confirmConnect = true }, enabled = status?.optBoolean("configured") == true, size = ButtonSize.Large, fillWidth = true)
                }
            } else {
                ListSearchField(search, { search = it.take(200) }, stringResource(R.string.ccr_search_repositories), Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 520.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
                    if (loading && repos.isEmpty()) item { LoadingState() }
                    else if (loaded && repos.isEmpty() && failure == null) item { Text(stringResource(R.string.ccr_no_repositories_found), Modifier.fillMaxWidth().padding(24.dp), style = Claude.type.body15, color = c.text500, textAlign = TextAlign.Center) }
                    items(repos, key = { it.optString("full_name") }) { repo ->
                        SheetActionRow(repo.optString("full_name"), { select(repo) }, if (repo.optBoolean("private")) AppGlyphs.lock else AppGlyphs.github)
                    }
                    if (nextPage > 0 && repos.isNotEmpty()) item { SheetActionRow(stringResource(R.string.claudex_load_more), { fetch() }, AppGlyphs.caretDown, enabled = !loading) }
                }
            }
        } else {
            Text(current.optString("full_name"), Modifier.padding(horizontal = 20.dp, vertical = 4.dp), style = Claude.type.body15, color = c.text500)
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp)) {
                if (loading && branches.isEmpty()) item { LoadingState() }
                else if (!loading && branches.isEmpty() && failure == null) item { Text(stringResource(R.string.ccr_no_branches_found), Modifier.fillMaxWidth().padding(24.dp), style = Claude.type.body15, color = c.text500, textAlign = TextAlign.Center) }
                items(branches, key = { it.optString("name") }) { item ->
                    val name = item.optString("name")
                    val isDefault = name == current.optString("default_branch")
                    SheetActionRow(name, { branch = name }, AppGlyphs.branch, trailing = if (branch == name) ({ Icon(AppGlyphs.check, null, Modifier.size(20.dp), tint = c.text100) }) else null,
                        suffix = if (isDefault) stringResource(R.string.ccr_default_branch_label) else null)
                }
            }
            Column(Modifier.padding(16.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SettingsTextField(branch, { branch = it.take(250) }, placeholder = stringResource(R.string.ccr_choose_base_branch))
                ClaudeButton(stringResource(R.string.generic_button_done), {
                    val url = current.getString("clone_url"); val parsed = runCatching { java.net.URI(url) }.getOrNull()
                    if (parsed?.scheme != "https" || parsed.host.isNullOrBlank() || parsed.userInfo != null || parsed.query != null || parsed.fragment != null) failure = context.getString(R.string.claudex_repository_invalid)
                    else { vm.selectedRepository.value = RepositoryChoice(current.getString("full_name"), url, branch.trim()); dismiss() }
                }, enabled = branch.isNotBlank() && !loading, size = ButtonSize.Large, fillWidth = true)
            }
        }
    }
    if (confirmConnect) ClaudeDialog(stringResource(R.string.ccr_connect_github_title), stringResource(R.string.claudex_github_connect_body), stringResource(R.string.generic_button_continue), {
        confirmConnect = false
        vm.work { val url = vm.api.request("/api/v1/claudex/web/github/connect", JSONObject(), true).getJSONObject("data").getString("authorize_url"); val uri = Uri.parse(url); require(uri.scheme == "https" && uri.host == "github.com") { context.getString(R.string.claudex_repository_invalid) }; context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
    }, { confirmConnect = false })
}

private data class ModeRow(val mode: String, val title: Int, val description: Int, val icon: () -> ImageVector)
private val modeRows = listOf(
    ModeRow("manual", R.string.ccr_permission_mode_ask_title, R.string.ccr_permission_mode_ask_description) { AppGlyphs.hand },
    ModeRow("acceptEdits", R.string.ccr_permission_mode_act_title, R.string.ccr_permission_mode_act_description) { AppGlyphs.code },
    ModeRow("plan", R.string.ccr_permission_mode_plan_title, R.string.ccr_permission_mode_plan_description) { AppGlyphs.scroll },
    ModeRow("auto", R.string.ccr_permission_mode_auto_title, R.string.ccr_permission_mode_auto_description) { AppGlyphs.lightning },
    ModeRow("bypass", R.string.ccr_mode_bypass, R.string.claudex_permission_mode_bypass_description) { AppGlyphs.warningShield },
)

/**
 * Permission mode sheet: "Select mode" / "Choose how Claude should work"; one row per
 * mode the service offers (icon, title — 17/550 when selected — description, check). Bypass asks first.
 */
@Composable fun PermissionSheet(vm: AppViewModel, dismiss: () -> Unit) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    val sending by vm.busy.collectAsStateWithLifecycle()
    val operations by vm.conversationActions.collectAsStateWithLifecycle()
    var working by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf<PermissionChoiceContext?>(null) }
    var failure by remember { mutableStateOf(false) }
    val allowed = if (BuildConfig.DEMO_MODE) listOf("manual", "auto", "acceptEdits", "plan") else CodeModePolicy.offered(WireCodec.rawHost?.optJSONObject("cloud")?.optJSONArray("permissionModes"))
    val settings = WireCodec.rawSettings
    val current = CodeModePolicy.current(settings)
    val context = CodePermissionSelection.context(vm.api.sessionGeneration, allowed, settings, snapshot.cloudCode)
    val running = sending || operations.isNotEmpty() || snapshot.conversations.any { c -> c.turns.any { it.status == TurnStatus.IN_PROGRESS } }
    val c = Claude.colors
    LaunchedEffect(context) { confirming = null; failure = false }
    fun save(mode: String, confirmed: Boolean, expected: PermissionChoiceContext) {
        if (BuildConfig.DEMO_MODE || working) return
        working = true; failure = false
        vm.work {
            try { vm.api.withCurrentSession {
                val nowSettings = WireCodec.rawSettings ?: error("settings")
                val offeredNow = CodeModePolicy.offered(WireCodec.rawHost?.optJSONObject("cloud")?.optJSONArray("permissionModes"))
                val now = CodePermissionSelection.context(vm.api.sessionGeneration, offeredNow, nowSettings, vm.snapshot.value.cloudCode)
                val runningNow = vm.busy.value || vm.conversationActions.value.isNotEmpty() || vm.snapshot.value.conversations.any { c -> c.turns.any { it.status == TurnStatus.IN_PROGRESS } }
                CodePermissionSelection.requireChoice(mode, expected, now, vm.signedIn.value, runningNow, false, confirmed)
                val patch = CodeModePolicy.patch(mode, offeredNow)
                val copy = JSONObject(nowSettings.toString())
                patch.keys().asSequence().forEach { key -> copy.put(key, patch.get(key)) }
                val repo = vm.repository as RemoteRepository
                repo.rpc("saveSettings", copy); repo.refresh()
            }; dismiss()
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
              catch (_: Exception) { failure = true }
              finally { working = false }
        }
    }
    ClaudeModalBottomSheet(onDismissRequest = { if (!working) dismiss() }) {
        ClaudeSheetHeader(stringResource(R.string.ccr_permission_mode_title))
        Text(stringResource(R.string.ccr_permission_mode_subtitle), Modifier.padding(horizontal = 16.dp), style = Claude.type.body15, color = c.text500)
        Spacer(Modifier.height(8.dp))
        if (running) Text(stringResource(R.string.claudex_permission_mode_running), Modifier.padding(horizontal = 16.dp, vertical = 4.dp), style = Claude.type.body13, color = c.text500)
        if (failure) Text(stringResource(R.string.ccr_permission_mode_apply_failed), Modifier.padding(horizontal = 16.dp, vertical = 4.dp), style = Claude.type.body13, color = c.dangerText)
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp).navigationBarsPadding()) {
            modeRows.filter { it.mode in allowed }.forEach { row ->
                val isCurrent = row.mode == current
                val enabled = !BuildConfig.DEMO_MODE && !isCurrent && CodePermissionSelection.canSelect(row.mode, context, signedIn, running, working)
                Row(Modifier.fillMaxWidth().selectable(isCurrent, enabled = enabled || isCurrent, role = Role.RadioButton) {
                    if (enabled) { if (row.mode == "bypass") confirming = context else save(row.mode, false, context) }
                }.padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(row.icon(), null, Modifier.size(24.dp), tint = c.text100.copy(alpha = if (enabled || isCurrent) 1f else .38f))
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(row.title), style = if (isCurrent) Claude.type.body17Strong else Claude.type.body17, color = c.text100.copy(alpha = if (enabled || isCurrent) 1f else .38f))
                        Text(stringResource(row.description), style = Claude.type.body15, color = c.text500, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (isCurrent) Icon(AppGlyphs.check, null, Modifier.size(20.dp), tint = c.text100)
                }
            }
            if (allowed.isEmpty()) Text(stringResource(R.string.ccr_permission_mode_rejected), Modifier.padding(20.dp), style = Claude.type.body15, color = c.text500)
        }
    }
    confirming?.let { expected -> ClaudeDialog(stringResource(R.string.claudex_permission_mode_bypass_confirm_title), stringResource(R.string.claudex_permission_mode_bypass_confirm_body),
        stringResource(R.string.ccr_mode_bypass), { confirming = null; if (expected == context && CodePermissionSelection.canSelect("bypass", context, signedIn, running, working)) save("bypass", true, expected) },
        { confirming = null }, destructive = true) }
}
