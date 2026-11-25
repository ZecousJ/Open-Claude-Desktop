@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.claudex.core.Artifact
import com.claudex.core.Conversation

/** Artifacts and ready files already attached to this conversation. The two list tabs share them. */
internal data class ConversationOutputLists(val artifacts: List<Artifact>, val files: List<Artifact>) {
    val rows: List<Artifact> = artifacts + files
    val only: Artifact? = if (rows.size == 1) rows.first() else null
}

@Composable internal fun rememberConversationOutputs(vm: AppViewModel, conversation: Conversation): ConversationOutputLists {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val mine = snapshot.artifacts.filter { it.originConversationId == conversation.id }
    return ConversationOutputLists(mine.filter { it.generatedFile == null }, mine.filter { it.generatedFile != null })
}

/** Artifacts and Files show the same rows. Activity has no parsed pages yet. */
@Composable internal fun ConversationOutputsSheet(lists: ConversationOutputLists, tab: Int, onTab: (Int) -> Unit, onDismiss: () -> Unit, open: (Artifact) -> Unit) {
    val title = stringResource(when (tab) {
        1 -> R.string.ccr_files_tab_files
        2 -> R.string.ccr_files_tab_activity
        else -> R.string.ccr_files_tab_artifacts
    })
    val rows = if (tab == 2) emptyList() else lists.rows
    ClaudeModalBottomSheet(onDismiss) {
        ClaudeSheetHeader(title, onDismiss)
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            OutputTab(stringResource(R.string.ccr_files_tab_artifacts), tab == 0) { onTab(0) }
            OutputTab(stringResource(R.string.ccr_files_tab_files), tab == 1) { onTab(1) }
            OutputTab(stringResource(R.string.ccr_files_tab_activity), tab == 2) { onTab(2) }
        }
        if (rows.isEmpty()) {
            Text(stringResource(R.string.ccr_files_empty), Modifier.padding(20.dp), style = Claude.type.body15, color = Claude.colors.text500)
        } else Column(Modifier.verticalScroll(rememberScrollState())) {
            rows.forEach { artifact ->
                Text(artifact.name.ifBlank { stringResource(R.string.generic_untitled) },
                    Modifier.fillMaxWidth().clickable { open(artifact) }.padding(horizontal = 20.dp, vertical = 12.dp),
                    style = Claude.type.body15, color = Claude.colors.text100)
            }
        }
    }
}

@Composable private fun OutputTab(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(label, Modifier.clickable(onClick = onClick).padding(vertical = 8.dp),
        style = Claude.type.body15, color = if (selected) Claude.colors.text100 else Claude.colors.text500)
}
