@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.Conversation
import com.claudex.core.Mode
import com.claudex.core.Project
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Chat list filters: All, Pinned, Archived. Needs input / Working are left out: the service does not report them. */
enum class ChatsFilter(val label: Int, val empty: Int, val icon: () -> ImageVector) {
    ALL(R.string.chats_filter_all, R.string.empty_state_chat_title, { AppGlyphs.chats }),
    PINNED(R.string.chats_filter_starred, R.string.empty_state_chat_starred_title, { AppGlyphs.pin }),
    ARCHIVED(R.string.chats_filter_archived, R.string.empty_state_chat_archived_title, { AppGlyphs.archive })
}

/** Moving chats between projects uses the service's `updateConversation` patch (`projectId`, null = out of the project). */
internal object ChatProjectMoves {
    fun supported(vm: AppViewModel) = vm.repository is RemoteRepository
    suspend fun move(vm: AppViewModel, ids: Collection<String>, projectId: String?) {
        val repo = vm.repository as? RemoteRepository ?: return
        ids.forEach { id -> repo.rpc("updateConversation", id, JSONObject().put("projectId", projectId ?: JSONObject.NULL)) }
        repo.refresh()
    }
}

/**
 * The drawer's "Chats" destination: top bar with the filter
 * menu and Select; a search field that scrolls with the list; rows grouped by recency (no visible headers,
 * 4 dp after each group); long press = the chat menu; Select = multi-select with Move and Delete.
 */
@Composable fun HistoryScreen(vm: AppViewModel, nav: NavHostController) {
    val c = Claude.colors
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val operations by vm.conversationActions.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf(ChatsFilter.ALL) }
    var search by rememberSaveable { mutableStateOf("") }
    var selecting by rememberSaveable { mutableStateOf(false) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var filterMenu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<Conversation?>(null) }
    var deleting by remember { mutableStateOf<Conversation?>(null) }
    var bulkDelete by remember { mutableStateOf(false) }
    var bulkBusy by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf<Set<String>?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    fun endSelection() { selecting = false; selected = emptySet() }
    BackHandler(selecting) { endSelection() }

    val now = remember(snapshot.conversations) { System.currentTimeMillis() }
    val rows = snapshot.conversations.filter {
        when (filter) { ChatsFilter.ALL -> !it.archived; ChatsFilter.PINNED -> it.pinned && !it.archived; ChatsFilter.ARCHIVED -> it.archived }
    }.filter { SearchLibraryPolicy.matches(it, search) }.sortedByDescending { it.updatedAt }
    val groups = remember(rows, now) { RecencyBucket.group(rows, now) { it.updatedAt } }
    val projects = snapshot.projects.associateBy { it.id }
    LaunchedEffect(rows) { selected = selected.filter { id -> rows.any { it.id == id } }.toSet() }

    OfficialPage(stringResource(R.string.chat_list_screen_title), sansTitle = true,
        subtitle = if (selecting) stringResource(R.string.chat_list_selected_count, selected.size) else null,
        actions = {
            AnimatedContent(selecting, label = "Filter or move swap") { inSelection ->
                if (inSelection) ClaudeButton(stringResource(R.string.chat_list_move_selected), { moving = selected }, variant = ButtonVariant.Borderless,
                    size = ButtonSize.Small, icon = AppGlyphs.projects, enabled = selected.isNotEmpty() && ChatProjectMoves.supported(vm) && snapshot.projects.isNotEmpty())
                else Box {
                    ClaudeIconButton(filter.icon(), stringResource(if (filter == ChatsFilter.ALL) R.string.chat_list_filter_chats_a11y else R.string.chat_list_filter_change_a11y), { filterMenu = true }, tint = c.text100)
                    ClaudeDropdownMenu(filterMenu, { filterMenu = false }) {
                        ChatsFilter.entries.forEach { option ->
                            ClaudeMenuItem(stringResource(option.label), { filter = option; filterMenu = false }, option.icon(), selected = option == filter)
                        }
                    }
                }
            }
            AnimatedContent(selecting, label = "Trailing action visibility") { inSelection ->
                if (inSelection) ClaudeIconButton(AppGlyphs.trash, stringResource(R.string.chat_menu_delete), { bulkDelete = true },
                    enabled = selected.isNotEmpty(), tint = if (selected.isNotEmpty()) c.danger100 else c.text500)
                else ClaudeIconButton(AppGlyphs.checklist, stringResource(R.string.chat_list_select_multiple), { selecting = true }, enabled = rows.isNotEmpty(), tint = c.text100)
            }
        }) {
        PullToRefreshBox(refreshing, onRefresh = {
            scope.launch { refreshing = true; try { vm.repository.refresh() } catch (e: CancellationException) { throw e } catch (_: Exception) {} finally { refreshing = false } }
        }, Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                item(key = "search") { ListSearchField(search, { search = it.take(400) }, stringResource(R.string.generic_search), Modifier.padding(12.dp)) }
                if (rows.isEmpty()) item(key = "empty") {
                    if (search.isNotBlank()) OfficialEmptyState(AppGlyphs.searchCircle, stringResource(R.string.empty_state_search_title, search.trim()), Modifier.padding(top = 48.dp))
                    else OfficialEmptyState(filter.icon(), stringResource(filter.empty), Modifier.padding(top = 48.dp))
                }
                groups.forEach { (bucket, conversations) ->
                    items(conversations, key = { it.id }) { conversation ->
                        ChatListRow(vm, nav, conversation, projects[conversation.projectId], selecting, conversation.id in selected,
                            onToggle = { on -> selected = if (on) selected + conversation.id else selected - conversation.id },
                            onRename = { renaming = conversation }, onDelete = { deleting = conversation }, onMove = { moving = setOf(conversation.id) },
                            busy = conversation.id in operations, modifier = Modifier.animateItem())
                    }
                    item(key = "gap:" + bucket.name) { Spacer(Modifier.height(4.dp)) }
                }
            }
        }
    }
    renaming?.let { conversation -> RenameConversationDialog(conversation, { renaming = null }) { title -> vm.updateConversation(conversation, title = title); renaming = null } }
    deleting?.let { conversation -> DeleteConversationDialog(vm, conversation, { deleting = null }) {} }
    if (bulkDelete) {
        val count = selected.size
        ClaudeDialog(pluralStringResource(R.plurals.chat_list_delete_selected_title, count, count), stringResource(R.string.delete_dialog_default_subtitle),
            stringResource(R.string.chat_menu_delete), onConfirm = {
                val targets = snapshot.conversations.filter { it.id in selected }
                bulkBusy = true
                scope.launch {
                    try { targets.forEach { vm.repository.deleteConversation(it.id) } }
                    catch (e: CancellationException) { throw e }
                    catch (e: Exception) { vm.error.value = e.message ?: context.getString(R.string.generic_error_something_went_wrong_try_again) }
                    finally { bulkBusy = false; bulkDelete = false; endSelection() }
                }
            }, onDismiss = { bulkDelete = false }, destructive = true, busy = bulkBusy)
    }
    moving?.let { ids ->
        ProjectPickerSheet(snapshot.projects, current = snapshot.conversations.filter { it.id in ids }.mapNotNull { it.projectId }.distinct().singleOrNull(),
            onDismiss = { moving = null }) { project ->
            moving = null
            vm.work { ChatProjectMoves.move(vm, ids, project.id); vm.error.value = context.getString(R.string.chat_moved_to_project_toast, project.name) }
            endSelection()
        }
    }
}

/** One row of the Chats list with its long-press chat menu (`chat/menu/d`). */
@Composable private fun ChatListRow(vm: AppViewModel, nav: NavHostController, conversation: Conversation, project: Project?, selecting: Boolean, isSelected: Boolean,
    onToggle: (Boolean) -> Unit, onRename: () -> Unit, onDelete: () -> Unit, onMove: () -> Unit, busy: Boolean, modifier: Modifier = Modifier) {
    var menu by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val time = relativeTime(conversation.updatedAt)
    val subtitle = if (project != null) stringResource(R.string.chat_subtitle_time_and_project, time, project.name) else time
    val title = conversation.title.ifBlank { stringResource(R.string.generic_untitled) }
    val running = conversation.turns.lastOrNull()?.status == com.claudex.core.TurnStatus.IN_PROGRESS
    Box(modifier) {
        OfficialListRow(title, onClick = { nav.navigate("conversation/${conversation.id}") { launchSingleTop = true } }, subtitle = subtitle,
            onLongClick = { menu = true }, pinned = conversation.pinned, enabled = !busy,
            leading = { StatusMark(if (running) RowStatus.Working else if (conversation.unread) RowStatus.New else RowStatus.Quiet) },
            trailing = when (conversation.mode) {
                Mode.CODE -> ({ Icon(AppGlyphs.code, stringResource(R.string.nav_drawer_item_code), Modifier.size(16.dp), tint = Claude.colors.text500) })
                Mode.COWORK -> ({ Icon(AppGlyphs.tasks, stringResource(R.string.nav_drawer_item_dramatic_shrimp), Modifier.size(16.dp), tint = Claude.colors.text500) })
                else -> null
            },
            selection = if (selecting) isSelected else null, onToggle = onToggle)
        ClaudeDropdownMenu(menu, { menu = false }, Modifier.padding(start = 0.dp)) {
            ClaudeMenuItem(stringResource(R.string.chat_menu_rename), { menu = false; onRename() }, AppGlyphs.edit)
            ClaudeMenuItem(stringResource(if (conversation.pinned) R.string.chat_unstar else R.string.chat_star), { menu = false; vm.updateConversation(conversation, pinned = !conversation.pinned) },
                if (conversation.pinned) AppGlyphs.pinSlash else AppGlyphs.pin)
            if (ChatProjectMoves.supported(vm) && vm.snapshot.value.projects.isNotEmpty())
                ClaudeMenuItem(stringResource(if (conversation.projectId == null) R.string.chat_add_project else R.string.chat_change_project), { menu = false; onMove() }, AppGlyphs.projects)
            if (conversation.projectId != null && ChatProjectMoves.supported(vm))
                ClaudeMenuItem(stringResource(R.string.chat_remove_from_project), { menu = false
                    vm.work { ChatProjectMoves.move(vm, listOf(conversation.id), null); vm.error.value = context.getString(R.string.chat_removed_from_project_toast) } }, AppGlyphs.projectsX)
            ClaudeMenuItem(stringResource(if (conversation.archived) R.string.claudex_chat_menu_unarchive else R.string.claudex_chat_menu_archive),
                { menu = false; vm.updateConversation(conversation, archived = !conversation.archived) }, AppGlyphs.archive)
            ClaudeMenuItem(stringResource(R.string.chat_menu_delete), { menu = false; onDelete() }, AppGlyphs.trash, destructive = true)
            if (project != null) {
                ClaudeDivider(Modifier.padding(vertical = 4.dp))
                ClaudeMenuItem(project.name, { menu = false; nav.navigate("project/${project.id}") }, AppGlyphs.projects)
            }
        }
    }
}

/** Move to project sheet (`AllChatsListBottomSheetDestination.SelectProject`): "Search projects" and the project list. */
@Composable fun ProjectPickerSheet(projects: List<Project>, current: String?, onDismiss: () -> Unit, onPick: (Project) -> Unit) {
    var query by remember { mutableStateOf("") }
    val shown = projects.filter { query.isBlank() || it.name.contains(query.trim(), true) || it.description.contains(query.trim(), true) }.sortedBy { it.name.lowercase() }
    ClaudeModalBottomSheet(onDismiss) {
        ClaudeSheetHeader(stringResource(if (current == null) R.string.chat_add_project else R.string.chat_change_project))
        ListSearchField(query, { query = it.take(200) }, stringResource(R.string.project_picker_search_placeholder), Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            items(shown, key = { it.id }) { project ->
                SheetActionRow(project.name, { onPick(project) }, AppGlyphs.projects, enabled = project.id != current,
                    trailing = if (project.id == current) ({ Icon(AppGlyphs.check, null, Modifier.size(20.dp), tint = Claude.colors.text500) }) else null)
            }
            if (shown.isEmpty()) item { Text(stringResource(R.string.empty_state_search_title, query.trim()), Modifier.fillMaxWidth().padding(24.dp), style = Claude.type.body15, color = Claude.colors.text500) }
        }
    }
}
