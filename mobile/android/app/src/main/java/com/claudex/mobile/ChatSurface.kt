@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.IosShare
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.*

/** Chat state changes within this composition; NavHost never owns a pending-message page. */
@Composable internal fun ChatSurface(vm: AppViewModel, nav: NavHostController, selectedId: String?, active: Boolean = true) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val submission by vm.pendingSend.collectAsStateWithLifecycle()
    val pending = submission?.takeIf { selectedId == null }
    val id = selectedId ?: pending?.resultId
    val stored = snapshot.conversations.find { it.id == id }
    val pageKey = "chat"
    val surfaceIdentity = remember { Any() }
    LaunchedEffect(selectedId, id, pending?.id, pending?.failure) {
        if (BuildConfig.DEMO_MODE) android.util.Log.i("ClaudexChatPage", "surface=${System.identityHashCode(surfaceIdentity)} selected=$selectedId pending=${pending?.id} confirmed=$id failed=${pending?.failure != null}")
    }
    val virtualId = "local:${pending?.id ?: "draft"}"
    val fallback = remember(id, pending) { Conversation(id ?: virtualId, UserText.get(R.string.chat_new_chat), providerId = "", model = "", turns =
        if (pending == null) emptyList() else listOf(Turn("local:${pending.id}", pending.text,
            status = if (pending.failure == null) TurnStatus.IN_PROGRESS else TurnStatus.FAILED,
            error = pending.failure))) }
    val conversation = stored ?: fallback
    var sheet by remember(id) { mutableStateOf<ChatMenuAction?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }
    val removedFromProject = stringResource(R.string.chat_removed_from_project_toast)
    val sessionIdCopied = stringResource(R.string.ccr_session_id_copied)
    val branchCopied = stringResource(R.string.ccr_branch_copied)
    val context = androidx.compose.ui.platform.LocalContext.current
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    LaunchedEffect(toast) { if (toast != null) { kotlinx.coroutines.delay(2500); toast = null } }
    LaunchedEffect(id, stored?.unread, active) { if (active && stored?.unread == true) vm.markConversationRead(stored) }
    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        // Official top bar: menu · title · New chat (in a conversation) · More options.
        val openSidebar = LocalOpenSidebar.current
        var more by remember { mutableStateOf(false) }
        ClaudeTopBar(TopBarNavigation.Menu(openSidebar), centerTitle = true,
            title = { if (stored != null) ClaudeTopBarTitle(stored.title.ifBlank { stringResource(R.string.generic_untitled) }) },
            actions = {
                if (stored != null) {
                    ClaudeIconButton(AppGlyphs.chatAddFilled, stringResource(R.string.chat_new_chat), {
                        vm.resetNewDraft(); nav.navigate("home") { popUpTo(nav.graph.id); launchSingleTop = true } })
                    Box {
                        ClaudeIconButton(AppGlyphs.dotsVertical, stringResource(R.string.generic_button_more_options), { more = true })
                        ChatMoreMenu(stored, more, { more = false }) { action ->
                            when (action) {
                                ChatMenuAction.PIN -> vm.updateConversation(stored, pinned = !stored.pinned)
                                ChatMenuAction.ARCHIVE -> vm.updateConversation(stored, archived = !stored.archived)
                                ChatMenuAction.COPY_BRANCH -> SessionGit.branch(stored)?.let { clipboard.setText(androidx.compose.ui.text.AnnotatedString(it)); toast = branchCopied }
                                ChatMenuAction.COPY_ID -> { clipboard.setText(androidx.compose.ui.text.AnnotatedString(stored.id)); toast = sessionIdCopied }
                                ChatMenuAction.REMOVE_FROM_PROJECT -> vm.moveConversation(stored, null) { toast = removedFromProject }
                                else -> sheet = action
                            }
                        }
                    }
                }
            })
        DemoLabel()
        id?.let { ConversationContentStatus(vm, it) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            SharedConversationView(vm, nav, conversation, Modifier.fillMaxSize(), surfaceKey = pageKey,
                promotePending = true, active = active)
            if (id == null && pending == null) Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                ClaudeGreeting(Modifier.padding(vertical = 24.dp))
            }
        }
        if (id != null && stored != null) PendingApprovals(vm, id)
        // The composer stays put while a first message is on its way (official): only uploads in progress
        // ("will send when done", Undo send) or a failed send show a status above it.
        if (pending != null && pending.resultId == null && (pending.attachments.isNotEmpty() || pending.failure != null))
            PendingSendStatus(vm, pending)
        // Cowork is its own drawer destination now (official IA), not a composer switch.
        Composer(vm, nav, id, stored?.projectId,
            stored?.turns?.any { it.status == TurnStatus.IN_PROGRESS } == true,
            stored?.mode ?: Mode.CHAT, inPlace = selectedId == null)
        if (id == null && pending == null) Text(stringResource(R.string.conversation_disclaimer_1),
            Modifier.fillMaxWidth().padding(bottom = 10.dp), style = Claude.type.body11, textAlign = TextAlign.Center, color = Claude.colors.text500)
    }
    toast?.let { PillToast(it, Modifier.align(androidx.compose.ui.Alignment.BottomCenter).padding(bottom = 96.dp)) { toast = null } }
    }
    if (stored != null) when (sheet) {
        ChatMenuAction.SHARE -> HostedShareSheet(vm, stored) { sheet = null }
        ChatMenuAction.CHANGE_MODEL -> ModelSelectorSheet(vm, { sheet = null }, conversation = stored)
        ChatMenuAction.RENAME -> RenameConversationDialog(stored, { sheet = null }) { title -> vm.updateConversation(stored, title = title); sheet = null }
        ChatMenuAction.PROJECT -> MoveToProjectSheet(vm, stored, { sheet = null }) { name -> sheet = null; toast = context.getString(R.string.chat_moved_to_project_toast, name) }
        ChatMenuAction.DELETE -> DeleteConversationDialog(vm, stored, { sheet = null }) { vm.resetNewDraft(); nav.navigate("home") { popUpTo(nav.graph.id); launchSingleTop = true } }
        else -> Unit
    }
}

/** A first message that has not reached the service yet: "Uploading… will send when done" with Undo send while
 *  it uploads; once it failed, "Not delivered" with its reason and Edit message (puts the text back in the composer). */
@Composable private fun PendingSendStatus(vm: AppViewModel, pending: PendingSend) {
    val c = Claude.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), horizontalAlignment = androidx.compose.ui.Alignment.End) {
        if (pending.failure == null) Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (pending.attachments.isNotEmpty()) Text(stringResource(R.string.chat_message_pending_uploads_caption), style = Claude.type.body13, color = c.text500)
            ClaudeButton(stringResource(R.string.chat_waiting_message_menu_undo_send), vm::cancelUpload, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
        } else {
            Row(Modifier.heightIn(min = 48.dp).padding(top = 4.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(AppGlyphs.warningCircle, null, Modifier.size(16.dp), tint = c.dangerText)
                Text(stringResource(R.string.chat_message_not_sent), style = Claude.type.body13, color = c.dangerText)
                Spacer(Modifier.width(8.dp))
                ClaudeButton(stringResource(R.string.chat_message_not_sent_edit), { vm.pendingSend.value = null }, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
            }
            Text(pending.failure, style = Claude.type.body13, color = c.text500, textAlign = TextAlign.End)
        }
    }
}

