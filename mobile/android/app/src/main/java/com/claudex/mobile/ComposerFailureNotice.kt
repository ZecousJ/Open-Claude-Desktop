package com.claudex.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.claudex.core.QueuedState
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** The official offline line while a reply is still running and the event socket is down. */
@Composable internal fun LongTaskOfflineNotice(vm: AppViewModel, conversationId: String?, modifier: Modifier = Modifier) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val connection by vm.repository.connection.collectAsStateWithLifecycle()
    val queues by vm.queuedComposer.messages.collectAsStateWithLifecycle()
    val queued = queues[conversationId].orEmpty().any { it.state == QueuedState.QUEUED }
    val message = LongTaskStatus.message(snapshot.conversations.find { it.id == conversationId }, connection, queued) ?: return
    Text(stringResource(message), modifier, style = Claude.type.body13, color = Claude.colors.text500)
}

/** A failed reply, above the composer card in the composer's notice slot: the usage-card layout
 *  (`np7`: sunken fill, 16 dp corners, 12 dp padding, 13/550 text) with Retry / Continue and a dismiss. */
@Composable internal fun ComposerFailureNotice(vm: AppViewModel, conversationId: String?, modifier: Modifier = Modifier) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val actions by vm.conversationActions.collectAsStateWithLifecycle()
    var dismissed by rememberSaveable(conversationId) { mutableStateOf<String?>(null) }
    val c = snapshot.conversations.find { it.id == conversationId }
    val notice = ReplyFailurePresentation.notice(c, busy || conversationId in actions) ?: return
    if (dismissed == notice.turnId) return
    val colors = Claude.colors
    Surface(modifier, shape = Claude.shapes.card, color = colors.bg300) {
        Row(Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp, end = 0.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(notice.message), Modifier.weight(1f).padding(vertical = 8.dp), style = Claude.type.body13Strong, color = colors.text100)
            if (notice.retryable) ClaudeButton(stringResource(R.string.chat_response_try_again), { c?.turns?.lastOrNull()?.let { vm.retryResponse(c, it) } }, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
            if (notice.continuable) ClaudeButton(stringResource(R.string.generic_button_continue), { c?.let { vm.continueFailedResponse(it, notice.turnId) } }, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
            ClaudeIconButton(Anthropicons.x, stringResource(R.string.generic_button_content_description_dismiss), { dismissed = notice.turnId }, tint = colors.text300, iconSize = 20.dp)
        }
    }
}
