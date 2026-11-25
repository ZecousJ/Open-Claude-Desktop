@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.foundation.Image
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.IosShare
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.*

/** Chat state changes within this composition; NavHost never owns a pending-message page. */
@Composable internal fun ChatSurface(vm: AppViewModel, nav: NavHostController, selectedId: String?, active: Boolean = true, coveredByFilePreview: Boolean = false, onTranscriptPainted: (String) -> Unit = {}) {
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
    LaunchedEffect(toast, vm.popupAutoDismiss) { if (toast != null && vm.popupAutoDismiss) { kotlinx.coroutines.delay(2500); toast = null } }
    LaunchedEffect(id, stored?.unread, active) { if (active && stored?.unread == true) vm.markConversationRead(stored) }
    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        // Official top bar (§5.3): menu · title · New chat (in a conversation) · More options (chat menu, §6.2).
        val openSidebar = LocalOpenSidebar.current
        var more by remember { mutableStateOf(false) }
        ClaudeTopBar(TopBarNavigation.Menu(openSidebar), centerTitle = true,
            title = { if (stored != null) ClaudeTopBarTitle(stored.title.ifBlank { stringResource(R.string.generic_untitled) }) },
            actions = {
                if (stored != null) {
                    ClaudeIconButton(Anthropicons.chatAddFilled, stringResource(R.string.chat_new_chat), {
                        vm.resetNewDraft(); nav.navigate("home") { popUpTo(nav.graph.id); launchSingleTop = true } })
                    Box {
                        ClaudeIconButton(Anthropicons.dotsVertical, stringResource(R.string.generic_button_more_options), { more = true })
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
                promotePending = true, active = active, coveredByFilePreview = coveredByFilePreview,
                onTranscriptPainted = { if (stored != null && !stored.slim) onTranscriptPainted(it) })
            if (id == null && pending == null) Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                ClaudeGreeting(Modifier.padding(vertical = 24.dp))
            }
        }
        if (id != null && stored != null) PendingApprovals(vm, id)
        if (id != null) stored?.takeIf { it.mode == Mode.CODE }?.let { PullRequestOffer(vm, nav, it) }
        val uploadingReply by vm.uploadingAttachments.collectAsStateWithLifecycle()
        if (id != null && uploadingReply) Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp, androidx.compose.ui.Alignment.End)
        ) {
            Text(stringResource(R.string.chat_message_pending_uploads_caption), style = Claude.type.body13, color = Claude.colors.text500)
            ClaudeButton(stringResource(R.string.chat_waiting_message_menu_undo_send), vm::cancelUpload, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
        }
        // The first message stays above the composer until it is accepted: uploading, then sending, or a failure.
        if (pending != null && pending.resultId == null && (pending.attachments.isNotEmpty() || pending.sending || pending.failure != null))
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

/** The code session's branch row: local changes, a branch still on the computer, and the pull-request button. */
@Composable private fun PullRequestOffer(vm: AppViewModel, nav: NavHostController, conversation: Conversation) {
    val running = conversation.turns.any { it.status == TurnStatus.IN_PROGRESS }
    var offer by remember(conversation.id) { mutableStateOf<BranchOffer?>(null) }
    LaunchedEffect(conversation.id, conversation.updatedAt) {
        val repo = vm.repository as? RemoteRepository
        val raw = runCatching { org.json.JSONObject(conversation.rawJson ?: "{}") }.getOrNull()
        val cloud = raw?.optJSONObject("environment")?.optString("kind") == "space"
        val cwd = raw?.optString("cwd")?.takeIf { it.isNotBlank() && !cloud }
        offer = if (repo == null) null else try {
            branchOffer(repo.rpc("codeGitStatus", conversation.id) as? org.json.JSONObject, cloud, cwd)
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled } catch (_: Exception) { null }
    }
    val shown = offer
    val requestKey = SessionGit.facts(conversation).pullRequestKey
    val page = pullRequestUrl(requestKey)
    val mark = pullRequestMark(requestKey)
    val identity = pullRequestIdentity(requestKey)
    var draft by remember(requestKey) { mutableStateOf(SessionGit.facts(conversation).pullRequestState == "draft") }
    var chip by remember(requestKey) { mutableStateOf<CiChip?>(null) }
    var hold by remember(requestKey) { mutableStateOf<MergeHold?>(null) }
    var review by remember(requestKey) { mutableStateOf<PullReview?>(null) }
    var noChecks by remember(requestKey) { mutableStateOf(false) }
    var pullFailed by remember(requestKey) { mutableStateOf(false) }
    var readyFailed by remember(requestKey) { mutableStateOf(false) }
    LaunchedEffect(requestKey) {
        val who = identity ?: return@LaunchedEffect
        val value = try { vm.api.request("/api/v1/claudex/web/github/pull?repo=${android.net.Uri.encode(who.repository)}&number=${who.number}", null, true, "GET") }
        catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled } catch (_: Exception) { pullFailed = true; chip = null; hold = null; review = null; noChecks = false; return@LaunchedEffect }
        val data = value.optJSONObject("data") ?: value
        val state = data.optString("state").takeIf { it.isNotEmpty() }
        pullFailed = false
        val checks = if (data.has("checks")) data.optString("checks") else null
        chip = ciChip(checks, state)
        noChecks = noChecksReported(checks, state)
        hold = mergeHold(state, data.optBoolean("conflicting"), data.optString("merge_state").takeIf { it.isNotEmpty() })
        review = pullReview(data.optString("review").takeIf { it.isNotEmpty() })
        if (state != null) draft = state == "draft"
    }
    val canCreate = shown != null && offersPullRequest(shown, running)
    if (shown == null && page == null) return
    if (shown != null && !canCreate && shown.pushed && !shown.dirty && page == null) return
    val context = androidx.compose.ui.platform.LocalContext.current
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (page != null && mark != null) {
            val spoken = stringResource(R.string.ccr_pr_open)
            Text(stringResource(R.string.ccr_pr_chip, mark),
                Modifier.fillMaxWidth().combinedClickable(
                    onClick = { runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(page))) } },
                    onLongClick = { clipboard.setText(androidx.compose.ui.text.AnnotatedString(mark)) })
                    .semantics { contentDescription = spoken },
                style = Claude.type.body15, color = Claude.colors.text100)
        }
        chip?.let { status ->
            val spoken = stringResource(when (status) {
                CiChip.PENDING -> R.string.ccr_ci_pending
                CiChip.PASSED -> R.string.ccr_ci_passed
                CiChip.FAILED -> R.string.ccr_ci_failed
                CiChip.UNAVAILABLE -> R.string.ccr_ci_unavailable
            })
            Text(stringResource(R.string.ccr_ci), Modifier.semantics { contentDescription = spoken }, style = Claude.type.body15, color = Claude.colors.text100)
        }
        if (noChecks) Text(stringResource(R.string.ccr_pr_no_checks), style = Claude.type.body13, color = Claude.colors.text500)
        hold?.let { Text(stringResource(when (it) {
            MergeHold.CONFLICTS -> R.string.ccr_pr_conflicts
            MergeHold.BLOCKED -> R.string.ccr_pr_blocked
            MergeHold.BEHIND -> R.string.ccr_pr_behind
            MergeHold.DRAFT -> R.string.ccr_pr_draft
            MergeHold.QUEUED -> R.string.ccr_pr_queued
            MergeHold.CHECKING -> R.string.ccr_pr_checking
        }), style = Claude.type.body13, color = Claude.colors.text500) }
        review?.let { Text(stringResource(when (it) {
            PullReview.NONE -> R.string.ccr_pr_review_none
            PullReview.APPROVED -> R.string.ccr_pr_review_approved
            PullReview.CHANGES -> R.string.ccr_pr_review_changes
            PullReview.REQUIRED -> R.string.ccr_pr_review_required
        }), style = Claude.type.body13, color = Claude.colors.text500) }
        if (pullFailed) Text(stringResource(R.string.ccr_pr_load_failed), style = Claude.type.body13, color = Claude.colors.text500)
        if (draft && identity != null) Text(stringResource(R.string.session_filter_ready_for_review),
            Modifier.fillMaxWidth().clickable(role = androidx.compose.ui.semantics.Role.Button) {
                readyFailed = false
                vm.work {
                    val answer = try { vm.api.request("/api/v1/claudex/web/github/pull/action", org.json.JSONObject().put("repo", identity.repository).put("number", identity.number).put("action", "ready"), true) }
                    catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled } catch (_: Exception) { readyFailed = true; return@work }
                    if ((answer.optJSONObject("data") ?: answer).optBoolean("ok")) { draft = false; readyFailed = false } else readyFailed = true
                }
            },
            style = Claude.type.body15, color = Claude.colors.text100)
        if (readyFailed) Text(stringResource(R.string.ccr_pr_ready_failed), style = Claude.type.body13, color = Claude.colors.text500)
        if (shown != null && !shown.pushed) Text(stringResource(R.string.ccr_pr_local), style = Claude.type.body13, color = Claude.colors.text500)
        if (shown != null && shown.dirty) Text(stringResource(R.string.ccr_pr_local_changes),
            Modifier.fillMaxWidth().clickable(role = androidx.compose.ui.semantics.Role.Button) { nav.navigate("diff/${android.net.Uri.encode(conversation.id)}") },
            style = Claude.type.body15, color = Claude.colors.text100)
        if (canCreate && shown != null) {
            val label = stringResource(if (shown.pushed) R.string.ccr_pr_create else R.string.ccr_pr_push)
            val spoken = if (shown.pushed) label else stringResource(R.string.ccr_pr_push_a11y)
            Text(label,
                Modifier.fillMaxWidth().clickable(role = androidx.compose.ui.semantics.Role.Button) { vm.sendSessionText(conversation.id, createPrPrompt(shown)) }
                    .semantics { contentDescription = spoken },
                style = Claude.type.body15, color = Claude.colors.text100)
        }
    }
}

/** A first message that has not reached the service yet. While files upload, the caption is
 *  "Uploading… will send when done"; once the send itself starts, it is "Sending…". Undo send stays
 *  available. After it fails, the caption is "Not delivered": Try again when the upload failed,
 *  then Edit message and Delete message. */
@Composable private fun PendingSendStatus(vm: AppViewModel, pending: PendingSend) {
    val c = Claude.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), horizontalAlignment = androidx.compose.ui.Alignment.End) {
        if (pending.failure == null) Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(if (pending.sending || pending.attachments.isEmpty()) R.string.chat_input_hint_sending else R.string.chat_message_pending_uploads_caption), style = Claude.type.body13, color = c.text500)
            ClaudeButton(stringResource(R.string.chat_waiting_message_menu_undo_send), vm::cancelUpload, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
        } else {
            Row(Modifier.heightIn(min = 48.dp).padding(top = 4.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(Anthropicons.warningCircle, null, Modifier.size(16.dp), tint = c.dangerText)
                Text(stringResource(R.string.chat_message_not_sent), style = Claude.type.body13, color = c.dangerText)
                Spacer(Modifier.width(8.dp))
                if (pending.uploadFailed) ClaudeButton(stringResource(R.string.chat_response_try_again), vm::retryPendingUpload, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
                ClaudeButton(stringResource(R.string.chat_message_not_sent_edit), vm::editPendingSend, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
                ClaudeButton(stringResource(R.string.chat_message_delete), vm::discardPendingSend, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
            }
            Text(pending.failure, style = Claude.type.body13, color = c.text500, textAlign = TextAlign.End)
        }
    }
}

