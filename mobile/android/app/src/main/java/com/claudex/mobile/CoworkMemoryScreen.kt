package com.claudex.mobile

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController

/** The account's Cowork memory files: open one, save it, delete it, or reset them all. */
@Composable fun CoworkMemoryScreen(vm: AppViewModel, nav: NavHostController) {
    val api = vm.api
    val work = rememberPanelWork()
    var snapshot by remember { mutableStateOf<CoworkMemory.Snapshot?>(null) }
    var editing by remember { mutableStateOf<String?>(null) }
    var draft by rememberSaveable { mutableStateOf("") }
    var deleting by remember { mutableStateOf<String?>(null) }
    var resetting by remember { mutableStateOf(false) }
    fun load() { work.run(alert = false) { snapshot = CoworkMemory.load(api) } }
    LaunchedEffect(Unit) { load() }
    OfficialPage(stringResource(R.string.cowork_memory_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            val current = snapshot
            if (current == null) {
                if (work.failure != null) OfficialErrorState(stringResource(R.string.generic_error_something_went_wrong), ::load, Modifier.padding(top = 48.dp))
                else LoadingState()
            } else if (current.files.isEmpty()) {
                OfficialEmptyState(Anthropicons.memory, stringResource(R.string.cowork_memory_empty), Modifier.padding(top = 48.dp))
            } else {
                SettingsGroup {
                    current.files.forEach { file ->
                        SettingsRow(file.path, { editing = file.path; draft = file.content }, Anthropicons.file,
                            trailing = { ClaudeIconButton(Anthropicons.trash, stringResource(R.string.chat_menu_delete), { deleting = file.path }, enabled = !work.busy) },
                            enabled = !work.busy)
                    }
                }
                Spacer(Modifier.height(12.dp))
                SettingsGroup {
                    SettingsRow(stringResource(R.string.cowork_memory_reset), { resetting = true }, Anthropicons.trash, titleColor = Claude.colors.dangerText, enabled = !work.busy)
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    editing?.let { path ->
        TextInputDialog(stringResource(R.string.cowork_memory_edit), draft, { draft = it.take(262_144) }, stringResource(R.string.generic_save), {
            work.run {
                val current = snapshot ?: return@run
                try { snapshot = CoworkMemory.write(api, current, path, draft); editing = null }
                catch (error: kotlinx.coroutines.CancellationException) { throw error }
                catch (error: Exception) { if (CoworkMemory.conflict(error)) snapshot = CoworkMemory.load(api); throw error }
            }
        }, { editing = null }, singleLine = false, minLines = 8, busy = work.busy, enabled = CoworkMemory.validKey(path))
    }
    deleting?.let { path ->
        ClaudeDialog(stringResource(R.string.cowork_memory_delete_title), stringResource(R.string.cowork_memory_delete_body), stringResource(R.string.chat_menu_delete), {
            work.run {
                val current = snapshot ?: return@run
                try { snapshot = CoworkMemory.delete(api, current, path); deleting = null }
                catch (error: kotlinx.coroutines.CancellationException) { throw error }
                catch (error: Exception) { if (CoworkMemory.conflict(error)) snapshot = CoworkMemory.load(api); throw error }
            }
        }, { deleting = null }, destructive = true, busy = work.busy)
    }
    if (resetting) ClaudeDialog(stringResource(R.string.cowork_memory_reset), stringResource(R.string.cowork_memory_reset_body), stringResource(R.string.cowork_memory_reset), {
        work.run {
            val current = snapshot ?: return@run
            try { snapshot = CoworkMemory.reset(api, current); resetting = false }
            catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (error: Exception) { if (CoworkMemory.conflict(error)) snapshot = CoworkMemory.load(api); throw error }
        }
    }, { resetting = false }, destructive = true, busy = work.busy)
    PanelFailureDialog(work)
}
