@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.claudex.core.*
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/*
 * Chat screen chrome around the transcript:
 * the notice card, the chat menu and its dialogs, moving a chat to a project, the share
 * sheet and the in-chat approval card.
 */

// ───────────────────────────── Notice card ─────────────────────────────

/** Notice card: 16 dp corners, page fill, 1 dp x border, 16/6/12/6 padding, ≥ 48 dp, infoCircle 20 dp,
 *  15 sp text in text-300, trailing Small Secondary button. */
@Composable fun NoticeCard(message: String, modifier: Modifier = Modifier, actionLabel: String? = null, onAction: (() -> Unit)? = null,
    icon: ImageVector = AppGlyphs.infoCircle, actionEnabled: Boolean = true, tint: androidx.compose.ui.graphics.Color = Claude.colors.text300) {
    val c = Claude.colors
    Surface(modifier.fillMaxWidth(), shape = Claude.shapes.card, color = c.bg100, contentColor = tint, border = BorderStroke(1.dp, c.border300)) {
        Row(Modifier.heightIn(min = 48.dp).padding(start = 16.dp, top = 6.dp, end = 12.dp, bottom = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(20.dp), tint = tint)
            Text(message, Modifier.weight(1f), style = Claude.type.body15, color = tint)
            if (actionLabel != null && onAction != null) ClaudeButton(actionLabel, onAction, variant = ButtonVariant.Secondary, size = ButtonSize.Small, enabled = actionEnabled)
        }
    }
}

// ───────────────────────────── Chat menu ─────────────────────────────

internal enum class ChatMenuAction { SHARE, PIN, RENAME, CHANGE_MODEL, PROJECT, REMOVE_FROM_PROJECT, ARCHIVE, COPY_ID, COPY_BRANCH, DELETE }

/** "More options" menu of an open chat: Share · Pin/Unpin · Rename · Add to / Change project · Remove from
 *  project · (Claudex) Archive · Delete in the danger colour. A Code session has the official session menu:
 * Copy branch (when it has one) · Share · Rename · project items · Archive/Unarchive · Copy session ID · Delete, with no Pin
 *  (only Unpin for a session that is already pinned). */
@Composable internal fun ChatMoreMenu(conversation: Conversation, expanded: Boolean, dismiss: () -> Unit, pick: (ChatMenuAction) -> Unit) {
    ClaudeDropdownMenu(expanded, dismiss) {
        fun go(action: ChatMenuAction) { dismiss(); pick(action) }
        val code = conversation.mode == Mode.CODE
        // Copy branch comes first, and only when the session has a branch.
        if (code && SessionGit.branch(conversation) != null) ClaudeMenuItem(stringResource(R.string.session_menu_copy_branch), { go(ChatMenuAction.COPY_BRANCH) }, AppGlyphs.copy)
        ClaudeMenuItem(stringResource(R.string.generic_share), { go(ChatMenuAction.SHARE) }, AppGlyphs.share)
        if (!code || conversation.pinned) ClaudeMenuItem(stringResource(if (conversation.pinned) R.string.chat_unstar else R.string.chat_star), { go(ChatMenuAction.PIN) },
            if (conversation.pinned) AppGlyphs.pinSlash else AppGlyphs.pin)
        ClaudeMenuItem(stringResource(R.string.chat_menu_rename), { go(ChatMenuAction.RENAME) }, AppGlyphs.edit)
        // `session_menu_change_model`: the session's own model, used from its next message.
        if (code) ClaudeMenuItem(stringResource(R.string.session_menu_change_model), { go(ChatMenuAction.CHANGE_MODEL) }, AppGlyphs.memory)
        ClaudeMenuItem(stringResource(if (conversation.projectId != null) R.string.chat_change_project else R.string.chat_add_project), { go(ChatMenuAction.PROJECT) }, AppGlyphs.projects)
        if (conversation.projectId != null) ClaudeMenuItem(stringResource(R.string.chat_remove_from_project), { go(ChatMenuAction.REMOVE_FROM_PROJECT) }, AppGlyphs.projectsX)
        ClaudeMenuItem(stringResource(if (conversation.archived) R.string.claudex_chat_menu_unarchive else R.string.claudex_chat_menu_archive), { go(ChatMenuAction.ARCHIVE) }, AppGlyphs.archive)
        if (code) ClaudeMenuItem(stringResource(R.string.session_menu_copy_session_id), { go(ChatMenuAction.COPY_ID) }, AppGlyphs.copy)
        ClaudeMenuItem(stringResource(R.string.chat_menu_delete), { go(ChatMenuAction.DELETE) }, AppGlyphs.trash, destructive = true)
    }
}

// ───────────────────────────── Move to project ─────────────────────────────

/** Project picker sheet ("Add to project" / "Change project"): search field and the project list; the current
 *  project carries a check. [moved] gets the chosen project's name once the service confirmed the move. */
@Composable internal fun MoveToProjectSheet(vm: AppViewModel, conversation: Conversation, dismiss: () -> Unit, moved: (String) -> Unit) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var query by remember { mutableStateOf("") }
    var working by remember { mutableStateOf<String?>(null) }
    val projects = snapshot.projects.filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) }
    val c = Claude.colors
    ClaudeModalBottomSheet(onDismissRequest = { if (working == null) dismiss() }) {
        ClaudeSheetHeader(stringResource(if (conversation.projectId != null) R.string.chat_change_project else R.string.chat_add_project), dismiss)
        Text(stringResource(R.string.move_chats_description), Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp),
            style = Claude.type.body15, color = c.textSecondary, textAlign = TextAlign.Center)
        ClaudeSearchField(query, { query = it }, stringResource(R.string.project_picker_search_placeholder), Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        Column(Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            if (snapshot.projects.isEmpty()) Text(stringResource(R.string.claudex_project_picker_empty), Modifier.fillMaxWidth().padding(24.dp),
                style = Claude.type.body15, color = c.text500, textAlign = TextAlign.Center)
            projects.forEach { project ->
                val current = project.id == conversation.projectId
                SheetActionRow(project.name, {
                    if (!current && working == null) { working = project.id; vm.moveConversation(conversation, project.id) { working = null; moved(project.name) } }
                }, AppGlyphs.folder, enabled = working == null, trailing = {
                    if (working == project.id) ClaudeSpinner(SpinnerSize.XSmall)
                    else if (current) Icon(AppGlyphs.check, null, Modifier.size(20.dp), tint = c.text500)
                })
            }
        }
    }
    // A failed move reports through the app snackbar; the sheet becomes usable again.
    val error by vm.error.collectAsStateWithLifecycle()
    LaunchedEffect(error) { if (error != null) working = null }
}

// ───────────────────────────── Share sheet ─────────────────────────────

private enum class ShareAccess(val wire: String?, val label: Int, val description: Int, val icon: ImageVector) {
    PRIVATE(null, R.string.share_status_private_description, R.string.share_private_icon_content_description, AppGlyphs.lock),
    INVITED("invited", R.string.share_status_invite_only_description, R.string.share_invite_only_icon_content_description, AppGlyphs.users),
    PUBLIC("link", R.string.share_status_public_description, R.string.share_public_icon_content_description, AppGlyphs.globe),
}

/**
 * Share snapshot sheet: the chat, "Who has access" over a bordered access card, a full-width
 * Primary "Share link" / "Update and share link", then "Only messages up to this point will be shared".
 * Choosing "Only you" on a shared chat unshares it. Invite-only keeps Claudex's email invitations.
 */
@Composable fun HostedShareSheet(vm: AppViewModel, conversation: Conversation, dismiss: () -> Unit) {
    val repo = vm.repository as? RemoteRepository
    val c = Claude.colors
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var status by remember { mutableStateOf<JSONObject?>(null) }
    var share by remember { mutableStateOf<JSONObject?>(null) }
    var loaded by remember { mutableStateOf(repo == null) }
    var access by remember { mutableStateOf(ShareAccess.INVITED) }
    var email by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }
    fun run(action: suspend () -> Unit) { busy = true; failure = null; vm.work { try { action() } catch (e: Exception) { failure = e.message } finally { busy = false } } }
    fun link(hosted: JSONObject?) = hosted?.let { if (it.optString("access") == "invited") it.optString("inviteUrl") else it.optString("url") }.orEmpty()
    fun shareUrl(url: String) { if (url.isNotBlank()) context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), null)) }
    LaunchedEffect(conversation.id) {
        if (repo != null) run {
            status = repo.rpc("sharingStatus") as? JSONObject
            share = repo.rpc("conversationShare", conversation.id) as? JSONObject
            ShareAccess.entries.find { it.wire != null && it.wire == share?.optString("access") }?.let { access = it }
            loaded = true
        }
    }
    val available = repo != null && status?.optBoolean("conversations") == true
    val shared = share != null
    fun submit() {
        val target = access
        if (target == ShareAccess.PRIVATE) { if (shared) confirm = "unshare"; return }
        if (target == ShareAccess.PUBLIC && share?.optString("access") != "link") { confirm = "public"; return }
        commitShare(repo, conversation, target.wire!!, share, ::run) { share = it; shareUrl(link(it)) }
    }
    ClaudeModalBottomSheet(onDismissRequest = dismiss) {
        ClaudeSheetHeader(stringResource(R.string.chat_sharing_snapshot_title), dismiss)
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            // Preview of what is shared.
            Surface(Modifier.fillMaxWidth(), shape = Claude.shapes.r12, color = c.bg000, border = BorderStroke(1.dp, c.border300)) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(AppGlyphs.chat, null, Modifier.size(20.dp), tint = c.text500)
                    Text(conversation.title.ifBlank { stringResource(R.string.generic_untitled) }, Modifier.weight(1f), style = Claude.type.body15, color = c.text100, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (!loaded) LoadingState()
            else {
                if (!available) NoticeCard(stringResource(R.string.chat_share_blocked_generic), icon = AppGlyphs.warningCircle)
                failure?.let { NoticeCard(it, icon = AppGlyphs.warningCircle) }
                Spacer(Modifier.height(4.dp))
                Text(stringResource(R.string.who_has_access_title), style = Claude.type.body13Strong, color = c.text500)
                Column(Modifier.fillMaxWidth().clip(Claude.shapes.r12).background(c.bg000).border(1.dp, c.border200, Claude.shapes.r12)) {
                    ShareAccess.entries.forEachIndexed { index, option ->
                        if (index > 0) HorizontalDivider(thickness = 1.dp, color = c.border300)
                        val enabled = !busy && (option == ShareAccess.PRIVATE || available)
                        val description = stringResource(option.description)
                        Row(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.RadioButton) { access = option }
                            .semantics { selected = access == option; contentDescription = description }
                            .heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(option.icon, null, Modifier.size(20.dp), tint = if (enabled) c.text300 else c.text500)
                            Text(stringResource(option.label), Modifier.weight(1f), style = Claude.type.body15, color = if (enabled) c.text100 else c.text500)
                            if (access == option) Icon(AppGlyphs.check, null, Modifier.size(20.dp), tint = c.text100)
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                ClaudeButton(stringResource(if (shared) R.string.share_update_link_button else R.string.share_link_button), ::submit,
                    size = ButtonSize.Large, fillWidth = true, loading = busy,
                    enabled = !busy && repo != null && (if (access == ShareAccess.PRIVATE) shared else available))
                Text(stringResource(R.string.chat_sharing_subtext), Modifier.fillMaxWidth(), style = Claude.type.body13, color = c.text500, textAlign = TextAlign.Center)
                share?.let { hosted ->
                    val url = link(hosted)
                    if (url.isNotBlank()) Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(url, Modifier.weight(1f), style = Claude.type.body13, color = c.text300, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        ClaudeButton(stringResource(if (copied) R.string.generic_copied_toast else R.string.copy_link), { clipboard.setText(AnnotatedString(url)); copied = true },
                            variant = ButtonVariant.Secondary, size = ButtonSize.Small, icon = if (copied) AppGlyphs.check else AppGlyphs.link)
                    }
                    if (hosted.optString("access") == "invited") {
                        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            ClaudeTextField(email, { email = it.trim() }, Modifier.weight(1f), placeholder = stringResource(R.string.claudex_share_invite_placeholder),
                                shape = Claude.shapes.field, container = c.bg000, border = c.border300, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Email))
                            ClaudeButton(stringResource(R.string.claudex_share_invite_button), { confirm = "invite" }, variant = ButtonVariant.Secondary, size = ButtonSize.Small,
                                enabled = !busy && email.contains('@') && available)
                        }
                        val invites = hosted.optJSONArray("invites")
                        if (invites != null && invites.length() > 0) {
                            Text(stringResource(R.string.claudex_share_invited_header), Modifier.padding(top = 8.dp), style = Claude.type.body13Strong, color = c.text500)
                            repeat(invites.length()) { index -> Text(invites.optString(index), style = Claude.type.body15, color = c.text100) }
                        }
                    }
                }
            }
        }
    }
    when (confirm) {
        "unshare" -> ClaudeDialog(stringResource(R.string.shared_links_unshare_dialog_title),
            stringResource(R.string.shared_links_unshare_dialog_description, conversation.title), stringResource(R.string.shared_links_unshare_button),
            { confirm = null; if (repo != null) run { repo.rpc("unshareConversation", conversation.id); share = null } }, { confirm = null }, destructive = true)
        "public" -> ClaudeDialog(stringResource(R.string.claudex_share_public_confirm_title), stringResource(R.string.claudex_share_public_confirm_body),
            stringResource(R.string.share_link_button), { confirm = null; commitShare(repo, conversation, "link", share, ::run) { share = it; shareUrl(link(it)) } }, { confirm = null })
        "invite" -> ClaudeDialog(stringResource(R.string.claudex_share_invite_confirm_title, email), stringResource(R.string.claudex_share_invite_confirm_body),
            stringResource(R.string.claudex_share_invite_button), { confirm = null; val address = email; if (repo != null) run {
                share = (repo.rpc("inviteToShare", conversation.id, address) as JSONObject).getJSONObject("share"); email = "" } }, { confirm = null })
    }
}

/** Creates or updates the hosted snapshot with [access]; the same RPCs the sheet always used. */
private fun commitShare(repo: RemoteRepository?, conversation: Conversation, access: String, current: JSONObject?, run: (suspend () -> Unit) -> Unit, done: (JSONObject) -> Unit) {
    if (repo == null) return
    run {
        if (current != null && current.optString("access") != access) repo.rpc("setShareAccess", conversation.id, access)
        done(repo.rpc("shareConversation", conversation.id, access) as JSONObject)
    }
}

// ───────────────────────────── Approvals ─────────────────────────────

internal object ApprovalKinds {
    private val command = setOf("item/commandExecution/requestApproval")
    private val fileChange = setOf("item/fileChange/requestApproval")
    private val permissions = setOf("item/permissions/requestApproval")
    private val elicitation = setOf("mcpServer/elicitation/request")
    private val question = setOf("item/tool/requestUserInput", "tool/requestUserInput")
    fun isCommand(method: String) = method in command
    fun isFileChange(method: String) = method in fileChange
    fun isPermissions(method: String) = method in permissions
    fun isElicitation(method: String) = method in elicitation
    fun isQuestion(method: String) = method in question
    /** Commands, file changes and extra permissions are answered on the phone with buttons. */
    fun answerable(method: String) = isCommand(method) || isFileChange(method) || isPermissions(method)
    /** A tool's own request (MCP elicitation) is answered on the phone: a connector tool's approval with its
     *  buttons, a form with its fields, a page to open (http or https only) with Open page. */
    fun answerable(method: String, params: JSONObject) = answerable(method) ||
        (isElicitation(method) && (params.optString("mode") != "url" || ElicitationForm.openablePage(params.optString("url")) != null))
    /** Short commands go in the header ("Allow Claudex to run `x`?"); long ones only in the input block. */
    fun headerContent(command: String): String? = command.trim().takeIf { it.isNotEmpty() && '\n' !in it && it.length <= 48 }

    /** Whether the card offers "Always allow for this session": Codex has the grant for commands, file edits and
     *  permissions, and the administrator can turn it off (`approvalsAlwaysAllow` of the client policy; the engine
     *  refuses it again). A policy not read yet allows it, as the open policy does. */
    fun sessionOffered(method: String, approvalsAlwaysAllow: Boolean?) = answerable(method) && approvalsAlwaysAllow != false

    /** The app-server answer for Allow once ([allow]) or Deny. */
    fun response(method: String, params: JSONObject, allow: Boolean): JSONObject = response(method, params, if (allow) ApprovalAnswer.Once else ApprovalAnswer.Deny)

    /** The app-server answer for a button (`approvalResponse` of `shared/approval-response.ts`). */
    fun response(method: String, params: JSONObject, answer: ApprovalAnswer): JSONObject = when {
        isPermissions(method) -> if (answer == ApprovalAnswer.Deny) JSONObject().put("permissions", JSONObject()).put("scope", "turn")
            else JSONObject().put("permissions", grantedPermissions(params.optJSONObject("permissions"))).put("scope", if (answer == ApprovalAnswer.Session) "session" else "turn")
        // A connector tool's choice outlives the request through `_meta.persist`.
        isElicitation(method) -> ConnectorToolApproval.parse(method, params)?.response(answer)
            ?: JSONObject().put("action", if (answer == ApprovalAnswer.Deny) "decline" else "accept").put("content", JSONObject.NULL).put("_meta", JSONObject.NULL)
        else -> JSONObject().put("decision", when (answer) { ApprovalAnswer.Deny -> "decline"; ApprovalAnswer.Session -> "acceptForSession"; else -> "accept" })
    }

    /** The requested permission profile as a grant; the app server rejects null members in it. */
    fun grantedPermissions(requested: JSONObject?): JSONObject {
        val granted = JSONObject()
        requested?.optJSONObject("network")?.let { granted.put("network", it) }
        requested?.optJSONObject("fileSystem")?.let { fileSystem ->
            val out = JSONObject().put("read", JSONObject.NULL).put("write", JSONObject.NULL)
            fileSystem.keys().forEach { key -> if (!fileSystem.isNull(key)) out.put(key, fileSystem.get(key)) }
            granted.put("fileSystem", out)
        }
        return granted
    }

    /** One line of an additional-permissions request: "network", "read", "write" or "block", and its target. */
    class PermissionRow(val kind: String, val value: String, @androidx.annotation.StringRes val valueRes: Int? = null)

    fun permissionRows(requested: JSONObject?): List<PermissionRow> {
        val rows = mutableListOf<PermissionRow>()
        if (requested?.optJSONObject("network")?.optBoolean("enabled") == true) rows += PermissionRow("network", "")
        val fileSystem = requested?.optJSONObject("fileSystem")
        fileSystem?.optJSONArray("read")?.let { list -> (0 until list.length()).forEach { rows += PermissionRow("read", list.optString(it)) } }
        fileSystem?.optJSONArray("write")?.let { list -> (0 until list.length()).forEach { rows += PermissionRow("write", list.optString(it)) } }
        fileSystem?.optJSONArray("entries")?.objects()?.forEach { entry ->
            val kind = when (entry.optString("access")) { "write" -> "write"; "deny" -> "block"; else -> "read" }
            val path = entry.optJSONObject("path")
            val special = path?.takeIf { it.optString("type") == "special" }?.optJSONObject("value")
            val res = when (special?.optString("kind")) {
                "root" -> R.string.claudex_permission_path_root; "minimal" -> R.string.claudex_permission_path_system
                "tmpdir" -> R.string.claudex_permission_path_temp; "project_roots" -> R.string.claudex_permission_path_project; else -> null }
            val text = when {
                special != null -> special.optString("subpath").takeIf { it.isNotBlank() } ?: special.optString("path").takeIf { it.isNotBlank() && res == null }.orEmpty()
                path?.optString("type") == "glob_pattern" -> path.optString("pattern")
                else -> path?.optString("path").orEmpty()
            }
            rows += PermissionRow(kind, if (special == null && text.isBlank()) entry.optString("path") else text, res)
        }
        return rows
    }
    fun permissionTitleRes(rows: List<PermissionRow>): Int {
        val network = rows.any { it.kind == "network" }; val files = rows.any { it.kind != "network" }
        return if (network && !files) R.string.claudex_permission_title_network else if (files && !network) R.string.claudex_permission_title_files else R.string.claudex_permission_title_generic
    }
}

/**
 * In-session approval card: 24 dp corners, 16/12 padding; header 15 sp text-100 "Allow Claudex to run
 * `…`?", reason and "On <folder>" in 13 sp text-300, the raw input in an r @30 % block with "Show full input" /
 * "Show less", then full-width "Allow once" (Primary), "Always allow for this session" (Secondary, where the
 * administrator allows session grants) and "Deny" (Secondary). Extra-permission requests are answered the same way.
 * A connector tool's approval is the official bottom sheet ([ConnectorToolSheet]) that opens by itself, with a
 * "Waiting for you" row to open it again; a tool's form ([ElicitationFormFields]) is filled in the card and sent
 * with Submit, and a page to open (http or https) with Open page. Requests the phone can't answer say so and offer
 * [onOpenElsewhere]. A failed send reads as the official "Failed to send tool decision".
 * [extended] is false for a computer's approvals, whose extra permissions are reviewed on the computer itself;
 * [approvalsAlwaysAllow] is the client policy's switch for the session grant (null until it is read).
 */
@Composable internal fun ApprovalCard(approval: Approval, modifier: Modifier = Modifier, changes: List<Change> = emptyList(),
    elsewhereMessage: String = stringResource(R.string.claudex_approval_review_on_web), onOpenElsewhere: (() -> Unit)? = null,
    extended: Boolean = true, approvalsAlwaysAllow: Boolean? = null, answer: suspend (JSONObject) -> Unit) {
    val c = Claude.colors
    val params = remember(approval.params) { runCatching { JSONObject(approval.params) }.getOrDefault(JSONObject()) }
    val method = approval.method
    val phoneAnswers = ApprovalKinds.answerable(method, params) && (extended || !ApprovalKinds.isPermissions(method))
    val connector = remember(approval.params) { ConnectorToolApproval.parse(method, params) }
    val isPage = ApprovalKinds.isElicitation(method) && params.optString("mode") == "url"
    val isForm = ApprovalKinds.isElicitation(method) && connector == null && !isPage
    val formFields = remember(approval.params) {
        if (isForm) ElicitationForm.fields(params.optJSONObject("requestedSchema"), params.optJSONArray("claudexFieldOrder")?.let { list -> (0 until list.length()).mapNotNull { list.opt(it) as? String } }) else emptyList()
    }
    val formValues = remember(approval.id) { mutableStateMapOf<String, ElicitationForm.Value>() }
    var formProblem by remember(approval.id) { mutableStateOf<ElicitationForm.Problem?>(null) }
    val sessionOffered = ApprovalKinds.sessionOffered(method, approvalsAlwaysAllow) && (extended || !ApprovalKinds.isPermissions(method))
    val permissionRows = remember(params) { if (ApprovalKinds.isPermissions(method)) ApprovalKinds.permissionRows(params.optJSONObject("permissions")) else emptyList() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val failedText = stringResource(R.string.agent_chat_error_tool_approval_failed)
    var busy by remember(approval.id) { mutableStateOf(false) }
    var failure by remember(approval.id) { mutableStateOf<String?>(null) }
    var expanded by remember(approval.id) { mutableStateOf(false) }
    var sheetOpen by remember(approval.id) { mutableStateOf(connector != null && phoneAnswers) }
    fun reply(result: JSONObject) { busy = true; failure = null; scope.launch { try { answer(result) } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) { failure = failedText } finally { busy = false } } }
    fun submitForm() {
        if (isPage) {
            val page = ElicitationForm.openablePage(params.optString("url")) ?: return
            val opened = runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(page)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
            if (!opened) { failure = failedText; return }
            reply(JSONObject().put("action", "accept").put("content", JSONObject.NULL).put("_meta", JSONObject.NULL))
            return
        }
        when (val result = ElicitationForm.content(formFields, formValues.toMap())) {
            is ElicitationForm.Result.Invalid -> formProblem = result.problem
            is ElicitationForm.Result.Content -> { formProblem = null; reply(JSONObject().put("action", "accept").put("content", result.content).put("_meta", JSONObject.NULL)) }
        }
    }
    if (connector != null) {
        ConnectorToolWaitingRow(connector, modifier) { sheetOpen = true }
        if (sheetOpen) ConnectorToolSheet(connector, busy, failure, { sheetOpen = false }) { choice -> if (phoneAnswers) reply(ApprovalKinds.response(method, params, choice)) }
        return
    }
    Surface(modifier.fillMaxWidth(), shape = Claude.shapes.r24, color = c.bg000, contentColor = c.text100, border = BorderStroke(1.dp, c.border300)) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp).heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val command = params.optString("command")
            val rowLines = permissionRows.map { row ->
                val target = row.valueRes?.let { stringResource(it) + row.value.takeIf { sub -> sub.isNotBlank() }?.let { sub -> "/$sub" }.orEmpty() } ?: row.value
                stringResource(when (row.kind) { "network" -> R.string.claudex_permission_network; "write" -> R.string.claudex_permission_write; "block" -> R.string.claudex_permission_block; else -> R.string.claudex_permission_read }, target)
            }
            val raw = when {
                ApprovalKinds.isCommand(method) -> command
                ApprovalKinds.isFileChange(method) -> changes.joinToString("\n\n") { it.path + "\n" + it.diff }.ifBlank { params.optJSONArray("changes")?.let { arr -> (0 until arr.length()).joinToString("\n") { arr.optJSONObject(it)?.optString("path").orEmpty() } }.orEmpty() }
                ApprovalKinds.isPermissions(method) -> rowLines.joinToString("\n")
                ApprovalKinds.isQuestion(method) || ApprovalKinds.isElicitation(method) -> ""
                else -> params.toString(2)
            }
            val header = when {
                ApprovalKinds.isCommand(method) -> ApprovalKinds.headerContent(command)?.let { stringResource(R.string.ccr_tool_approval_header, stringResource(R.string.ccr_tool_action_run), it) }
                    ?: stringResource(R.string.ccr_tool_approval_header_no_content, stringResource(R.string.ccr_tool_action_run))
                ApprovalKinds.isFileChange(method) -> stringResource(R.string.ccr_tool_approval_header_no_content, stringResource(R.string.ccr_tool_action_edit))
                ApprovalKinds.isPermissions(method) -> stringResource(ApprovalKinds.permissionTitleRes(permissionRows))
                // A form or a page speaks in the tool's own words; without any, the official generic line.
                ApprovalKinds.isElicitation(method) -> params.stringOrNull("message")?.trim() ?: stringResource(R.string.tool_approval_sentence_generic)
                else -> stringResource(R.string.tool_approval_sentence_generic)
            }
            if (!ApprovalKinds.isQuestion(method)) Text(header, style = Claude.type.body15, color = c.text100)
            params.stringOrNull("reason")?.let { Text(it, style = Claude.type.body13, color = c.text300) }
            if (isPage) params.stringOrNull("url")?.let { Text(it, style = Claude.type.body13, color = c.text300, maxLines = 3, overflow = TextOverflow.Ellipsis) }
            params.stringOrNull("cwd")?.let { Text(stringResource(R.string.ccr_folder_consent_device, it), style = Claude.type.body13, color = c.text300) }
            if (raw.isNotBlank() && (ApprovalKinds.headerContent(command) == null || !ApprovalKinds.isCommand(method))) {
                Spacer(Modifier.height(8.dp))
                Column(Modifier.fillMaxWidth().clip(Claude.shapes.r8).background(c.bg200.copy(alpha = .3f).compositeOver(c.bg000)).padding(12.dp)) {
                    Text(raw, Modifier.horizontalScroll(rememberScrollState()), style = Claude.type.code, color = c.text100,
                        maxLines = if (expanded) Int.MAX_VALUE else 6, overflow = TextOverflow.Ellipsis, softWrap = false)
                }
                if (raw.lines().size > 6) Text(stringResource(if (expanded) R.string.ccr_tool_approval_raw_args_show_less else R.string.ccr_tool_approval_raw_args_show_full),
                    Modifier.clip(Claude.shapes.r6).clickable(role = Role.Button) { expanded = !expanded }.heightIn(min = 40.dp).padding(horizontal = 8.dp, vertical = 10.dp),
                    style = Claude.type.body13, color = c.text300)
            }
            if (isForm && phoneAnswers && formFields.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                ElicitationFormFields(formFields, formValues, formProblem, !busy) { formProblem = null }
            }
            if (ApprovalKinds.isQuestion(method)) QuestionForm(params, busy) { reply(it) }
            failure?.let { Spacer(Modifier.height(8.dp)); NoticeCard(it, icon = AppGlyphs.warningCircle) }
            Spacer(Modifier.height(10.dp))
            when {
                phoneAnswers && (isForm || isPage) -> Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // Submit (or Open page) is the default (Primary), Decline the Secondary under it.
                    ClaudeButton(stringResource(if (isPage) R.string.claudex_form_open_page else R.string.ask_user_input_submit), { submitForm() }, size = ButtonSize.MediumLarge, fillWidth = true, enabled = !busy, loading = busy)
                    ClaudeButton(stringResource(R.string.tool_approval_button_decline), { reply(ApprovalKinds.response(method, params, ApprovalAnswer.Deny)) }, variant = ButtonVariant.Secondary, size = ButtonSize.MediumLarge, fillWidth = true, enabled = !busy)
                }
                phoneAnswers -> Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // Allow once is the default (Primary); the session grant (where allowed) and Deny are Secondary under it.
                    ClaudeButton(stringResource(R.string.ccr_tool_approval_allow_once), { reply(ApprovalKinds.response(method, params, ApprovalAnswer.Once)) }, size = ButtonSize.MediumLarge, fillWidth = true, enabled = !busy, loading = busy)
                    if (sessionOffered) ClaudeButton(stringResource(R.string.ccr_tool_approval_always_allow_for_session), { reply(ApprovalKinds.response(method, params, ApprovalAnswer.Session)) }, variant = ButtonVariant.Secondary, size = ButtonSize.MediumLarge, fillWidth = true, enabled = !busy)
                    ClaudeButton(stringResource(R.string.ccr_tool_approval_deny), { reply(ApprovalKinds.response(method, params, ApprovalAnswer.Deny)) }, variant = ButtonVariant.Secondary, size = ButtonSize.MediumLarge, fillWidth = true, enabled = !busy)
                }
                ApprovalKinds.isQuestion(method) -> Unit
                else -> {
                    Text(elsewhereMessage, style = Claude.type.body13, color = c.text300)
                    if (onOpenElsewhere != null) { Spacer(Modifier.height(8.dp)); ClaudeButton(stringResource(R.string.claudex_approval_open_web), onOpenElsewhere, variant = ButtonVariant.Secondary, size = ButtonSize.MediumLarge, fillWidth = true) }
                }
            }
        }
    }
}

/**
 * The questions a task asks: one question per page with "n of N" at the top left and a
 * 32 dp close (Dismiss) at the top right, the options as 48 dp rows with a radio (12 dp corners, accent @10 %
 * when chosen), "Type your own answer…" as the last row where allowed, and one Next / Submit button under them.
 * Swiping sideways moves between pages. Dismiss sends every question unanswered. Codex questions take one
 * answer each, so there are no multi-select or ranked pages (the service never sends them).
 */
@Composable private fun QuestionForm(params: JSONObject, busy: Boolean, submit: (JSONObject) -> Unit) {
    val c = Claude.colors
    val questions = remember(params) { params.optJSONArray("questions")?.objects().orEmpty() }
    val answers = remember(params) { mutableStateMapOf<String, String>() }
    var page by remember(params) { mutableIntStateOf(0) }
    if (questions.isEmpty()) return
    val index = page.coerceIn(0, questions.lastIndex)
    val q = questions[index]; val id = q.optString("id"); val last = index == questions.lastIndex
    val options = q.optJSONArray("options")?.objects().orEmpty()
    val allowOther = options.isEmpty() || q.optBoolean("isOther")
    val current = answers[id].orEmpty().trim()
    val dismissLabel = stringResource(R.string.ask_user_input_dismiss)
    fun result(blank: Boolean): JSONObject {
        val out = JSONObject()
        questions.forEach { question -> val value = if (blank) "" else answers[question.optString("id")].orEmpty().trim()
            out.put(question.optString("id"), JSONObject().put("answers", JSONArray(if (value.isEmpty()) emptyList<String>() else listOf(value)))) }
        return JSONObject().put("answers", out)
    }
    var drag by remember { mutableFloatStateOf(0f) }
    Column(Modifier.fillMaxWidth().pointerInput(index, current) {
        detectHorizontalDragGestures(onDragStart = { drag = 0f }, onDragEnd = {
            if (drag < -80f && current.isNotEmpty() && !last) page = index + 1 else if (drag > 80f && index > 0) page = index - 1
        }) { _, amount -> drag += amount }
    }) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (questions.size > 1) Text(stringResource(R.string.ask_user_input_question_indicator, index + 1, questions.size), Modifier.weight(1f).padding(vertical = 6.dp), style = Claude.type.body13, color = c.text500)
            else Spacer(Modifier.weight(1f))
            Box(Modifier.size(32.dp).clip(Claude.shapes.r8).clickable(enabled = !busy, role = Role.Button) { submit(result(blank = true)) }, contentAlignment = Alignment.Center) {
                Icon(AppGlyphs.x, dismissLabel, Modifier.size(20.dp), tint = c.text500)
            }
        }
        Text(q.optString("question"), Modifier.padding(vertical = 4.dp), style = Claude.type.body15, color = c.text100)
        Spacer(Modifier.height(4.dp))
        Column(Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { option ->
                val label = option.optString("label"); val chosen = answers[id] == label
                QuestionRow(chosen, !busy, { answers[id] = label }) {
                    Column(Modifier.weight(1f)) {
                        Text(label, style = Claude.type.body15, color = c.text100)
                        option.stringOrNull("description")?.let { Text(it, style = Claude.type.body13, color = c.text500) }
                    }
                }
            }
            if (allowOther) {
                val custom = answers[id]?.takeIf { value -> options.none { it.optString("label") == value } }.orEmpty()
                QuestionRow(custom.isNotBlank(), !busy, {}) {
                    ClaudeTextField(custom, { answers[id] = it }, Modifier.weight(1f), placeholder = stringResource(R.string.ask_user_input_custom_answer),
                        singleLine = options.isNotEmpty(), maxLines = 4, shape = Claude.shapes.field, container = androidx.compose.ui.graphics.Color.Transparent, border = androidx.compose.ui.graphics.Color.Transparent,
                        contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp), enabled = !busy,
                        visualTransformation = if (q.optBoolean("isSecret")) PasswordVisualTransformation() else VisualTransformation.None)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        ClaudeButton(stringResource(if (last) R.string.ask_user_input_submit else R.string.ask_user_input_next), {
            if (last) submit(result(blank = false)) else page = index + 1
        }, size = ButtonSize.MediumLarge, fillWidth = true, loading = busy && last, enabled = !busy && current.isNotEmpty())
    }
}

/** One answer row: ≥ 48 dp, 12 dp corners, 8/12 padding; accent @10 % when chosen, bg-000 otherwise; a radio, 16 dp gap, content. */
@Composable private fun QuestionRow(chosen: Boolean, enabled: Boolean, onClick: () -> Unit, content: @Composable RowScope.() -> Unit) {
    val c = Claude.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(Claude.shapes.r12)
        .background(if (chosen) c.accentMain100.copy(alpha = .1f).compositeOver(c.bg000) else c.bg000)
        .border(1.dp, c.border300, Claude.shapes.r12)
        .clickable(enabled = enabled, role = Role.RadioButton, onClick = onClick).semantics { selected = chosen }.padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(20.dp).clip(androidx.compose.foundation.shape.CircleShape).background(if (chosen) c.accentBlue else androidx.compose.ui.graphics.Color.Transparent)
            .border(1.dp, if (chosen) c.accentBlue else c.textTertiary, androidx.compose.foundation.shape.CircleShape), contentAlignment = Alignment.Center) {
            if (chosen) Box(Modifier.size(8.dp).clip(androidx.compose.foundation.shape.CircleShape).background(c.checkGlyph))
        }
        content()
    }
}

/** Approvals waiting in a cloud chat or task, above the composer: one card each, newest last. */
@Composable fun PendingApprovals(vm: AppViewModel, conversationId: String) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val pending = snapshot.approvals.filter { it.conversationId == conversationId }
    val context = LocalContext.current
    val alwaysAllow = rememberApprovalsAlwaysAllow(vm)
    if (pending.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        pending.forEach { approval ->
            val changes = remember(approval.id, snapshot) {
                val itemId = runCatching { JSONObject(approval.params).optString("itemId") }.getOrDefault("")
                snapshot.conversations.find { it.id == conversationId }?.turns?.flatMap { it.items }?.filter { it.id == itemId }?.flatMap { it.changes }.orEmpty()
            }
            ApprovalCard(approval, changes = changes, approvalsAlwaysAllow = alwaysAllow, onOpenElsewhere = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(vm.api.origin))) }) { result ->
                val repo = vm.repository as? RemoteRepository ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
                repo.rpc("approve", if (approval.numericId) approval.id.toLong() else approval.id, result)
                repo.refresh()
            }
        }
    }
}
