@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
package com.claudex.mobile

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One drawer destination: official item, icon and the Claudex routes it covers. */
private data class DrawerItem(val label: Int, val icon: ImageVector, val target: String, val routes: Set<String>)

/**
 * The official navigation drawer: one column on bg-200 — header with the
 * mark (tap = new chat) and search; Chats, Projects, Code, Artifacts, Scheduled, Cowork; then Pinned
 * and Recents (Recents folds after 5 rows); the account row and the New chat pill pinned at the bottom.
 * API, service status and personalization live in Settings now.
 */
@Composable fun SidebarContent(vm: AppViewModel, nav: NavHostController, route: String, dismiss: () -> Unit) {
    val c = Claude.colors
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    var searching by rememberSaveable { mutableStateOf(false) }
    var search by rememberSaveable { mutableStateOf("") }
    var expanded by rememberSaveable { mutableStateOf(false) }
    var serverHits by remember { mutableStateOf<List<StoredHistoryHit>?>(null) }
    var deleting by remember { mutableStateOf<Conversation?>(null) }
    var renaming by remember { mutableStateOf<Conversation?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(search, signedIn, vm.api.sessionGeneration) {
        serverHits = null
        if (search.isBlank() || BuildConfig.DEMO_MODE || !signedIn) return@LaunchedEffect
        try { delay(300); serverHits = (vm.repository as RemoteRepository).searchStoredHistory(search.trim(), false) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { serverHits = null }
    }
    fun navigate(target: String) { dismiss(); nav.navigate(target) { launchSingleTop = true; popUpTo("home") { inclusive = false } } }
    fun newChat() { vm.resetNewDraft(); dismiss(); nav.navigate("home") { popUpTo(nav.graph.id); launchSingleTop = true } }
    val items = buildList {
        add(DrawerItem(R.string.nav_drawer_item_chats, AppGlyphs.chats, "history", setOf("history")))
        add(DrawerItem(R.string.nav_drawer_section_header_projects, AppGlyphs.projects, "work", setOf("work", "project/{id}")))
        add(DrawerItem(R.string.nav_drawer_item_code, AppGlyphs.code, "code", setOf("code", "code-new", "device/{id}", "deviceNew/{device}", "deviceConversation/{device}/{id}", "diff/{id}")))
        add(DrawerItem(R.string.product_name_artifacts, AppGlyphs.artifacts, "library", setOf("library", "artifact/{id}")))
        add(DrawerItem(R.string.nav_drawer_item_scheduled, AppGlyphs.clock, "routines", setOf("routines", "routine/{id}")))
        if (BuildConfig.DEMO_MODE || snapshot.cloudCowork) add(DrawerItem(R.string.nav_drawer_item_dramatic_shrimp, AppGlyphs.tasks, "cowork", setOf("cowork", "task/{id}")))
    }
    val sections = remember(snapshot.conversations) { SidebarPolicy.sections(snapshot.conversations) }
    val selectedChat = if (route == "conversation/{id}") nav.currentBackStackEntry?.arguments?.getString("id") else null
    val density = LocalDensity.current
    val statusTop = with(density) { WindowInsets.statusBars.getTop(this).toDp() }
    val focus = remember { FocusRequester() }
    LaunchedEffect(searching) { if (searching) runCatching { focus.requestFocus() } }

    Box(Modifier.fillMaxSize().background(c.bg200)) {
        PullToRefreshBox(refreshing, onRefresh = {
            scope.launch { refreshing = true; try { vm.repository.refresh() } catch (e: CancellationException) { throw e } catch (_: Exception) {} finally { refreshing = false } }
        }, Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = statusTop + 8.dp, bottom = 72.dp + 24.dp)) {
                item(key = "header") { DrawerHeader(onMark = ::newChat, onSearch = { searching = !searching; if (!searching) search = "" }, searching = searching) }
                if (searching) {
                    item(key = "search") {
                        ClaudeSearchField(search, { search = it.take(400) }, stringResource(R.string.conversation_search),
                            Modifier.padding(horizontal = 12.dp, vertical = 4.dp), focusRequester = focus)
                    }
                    val local = snapshot.conversations.filter { SearchLibraryPolicy.matches(it, search) }.sortedByDescending { it.updatedAt }
                    val hits = serverHits
                    if (search.isNotBlank()) {
                        if (hits != null) items(hits, key = { "hit:" + it.id }) { hit ->
                            DrawerConversationRow(hit.title, selected = hit.id == selectedChat, onClick = {
                                vm.work { if (vm.snapshot.value.conversations.none { it.id == hit.id }) vm.repository.refresh(); navigate("conversation/" + hit.id) }
                            })
                        } else items(local, key = { "local:" + it.id }) { conversation ->
                            DrawerConversationRow(conversation.title, selected = conversation.id == selectedChat, unread = conversation.unread, onClick = { navigate("conversation/${conversation.id}") })
                        }
                        if ((hits ?: local).isEmpty()) item(key = "noResults") {
                            Text(stringResource(R.string.empty_state_search_title, search.trim()), Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp),
                                style = Claude.type.body15, color = c.text500)
                        }
                    }
                } else {
                    items(items, key = { "nav:" + it.target }) { item ->
                        NavigationDrawerItem(
                            label = { Text(stringResource(item.label), style = Claude.type.body15) },
                            selected = route in item.routes, onClick = { navigate(item.target) },
                            icon = { Icon(item.icon, null, Modifier.size(24.dp)) },
                            modifier = Modifier.padding(horizontal = 8.dp).heightIn(min = 56.dp), shape = CircleShape,
                            colors = NavigationDrawerItemDefaults.colors(selectedContainerColor = c.drawerSelected, unselectedContainerColor = Color.Transparent,
                                selectedIconColor = c.text300, selectedTextColor = c.text300, unselectedIconColor = c.text500, unselectedTextColor = c.text500))
                    }
                    if (sections.pinned.isNotEmpty() || sections.recents.isNotEmpty()) item(key = "divider") { ClaudeDivider(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
                    conversationGroup(R.string.section_header_pinned, sections.pinned, selectedChat, ::navigate, { renaming = it }, { deleting = it }, vm)
                    conversationGroup(R.string.section_header_recents, SidebarPolicy.visibleRecents(sections.recents, expanded), selectedChat, ::navigate, { renaming = it }, { deleting = it }, vm)
                    if (SidebarPolicy.collapsible(sections.recents)) item(key = "showAll") {
                        ShowAllRow(expanded, sections.recents.size) { expanded = !expanded }
                    }
                }
            }
        }
        // Status-bar band in the drawer colour with an 8 dp fade, over the list.
        Column(Modifier.fillMaxWidth().align(Alignment.TopCenter)) {
            Box(Modifier.fillMaxWidth().height(statusTop).background(c.bg200))
            Box(Modifier.fillMaxWidth().height(8.dp).background(Brush.verticalGradient(listOf(c.bg200, c.bg200.copy(alpha = 0f)))))
        }
        DrawerAccountBar(vm, snapshot, Modifier.align(Alignment.BottomCenter), onSettings = { navigate("settings") }, onNewChat = ::newChat)
    }
    deleting?.let { conversation -> DeleteConversationDialog(vm, conversation, { deleting = null }) {
        if (nav.currentBackStackEntry?.arguments?.getString("id") == conversation.id || nav.currentBackStackEntry?.arguments?.getString("conversationId") == conversation.id) navigate("home")
    } }
    renaming?.let { conversation -> RenameConversationDialog(conversation, { renaming = null }) { title -> vm.updateConversation(conversation, title = title); renaming = null } }
}

/** Header: the mark and wordmark (tap = new chat, 10 dp ripple) and the search button. */
@Composable private fun DrawerHeader(onMark: () -> Unit, onSearch: () -> Unit, searching: Boolean) {
    val c = Claude.colors
    val newChat = stringResource(R.string.chat_new_chat)
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.padding(vertical = 8.dp).clip(Claude.shapes.r10).clickable(onClickLabel = newChat, role = Role.Button, onClick = onMark)
            .padding(start = 12.dp, top = 12.dp, end = 12.dp, bottom = 4.dp).semantics { contentDescription = "Claudex" },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ClaudexMark(24.dp)
            Text("Claudex", style = Claude.type.topBarTitle.copy(fontSize = Claude.type.greeting.fontSize), color = c.text100)
        }
        Spacer(Modifier.weight(1f))
        ClaudeIconButton(if (searching) AppGlyphs.x else AppGlyphs.search,
            stringResource(if (searching) R.string.generic_search_close else R.string.generic_search), onSearch, tint = c.text100)
    }
}

private fun LazyListScope.conversationGroup(header: Int, rows: List<Conversation>, selected: String?, navigate: (String) -> Unit,
    rename: (Conversation) -> Unit, delete: (Conversation) -> Unit, vm: AppViewModel) {
    if (rows.isEmpty()) return
    item(key = "header:$header") { DrawerSectionHeader(stringResource(header)) }
    items(rows, key = { "row:$header:" + it.id }) { conversation ->
        var menu by remember { mutableStateOf(false) }
        Box {
            val title = conversation.title.ifBlank { stringResource(R.string.generic_untitled) }
            val description = when (conversation.mode) {
                Mode.CODE -> stringResource(R.string.nav_drawer_code_session_row_description, title)
                Mode.COWORK -> stringResource(R.string.nav_drawer_cowork_session_row_description, title)
                else -> title
            }
            DrawerConversationRow(title, selected = conversation.id == selected, unread = conversation.unread, description = description,
                onClick = { navigate("conversation/${conversation.id}") }, onLongClick = { menu = true })
            ClaudeDropdownMenu(menu, { menu = false }) {
                ClaudeMenuItem(stringResource(R.string.chat_menu_rename), { menu = false; rename(conversation) }, AppGlyphs.edit)
                ClaudeMenuItem(stringResource(if (conversation.pinned) R.string.chat_unstar else R.string.chat_star), { menu = false; vm.updateConversation(conversation, pinned = !conversation.pinned) }, AppGlyphs.pin)
                ClaudeMenuItem(stringResource(if (conversation.archived) R.string.claudex_chat_menu_unarchive else R.string.claudex_chat_menu_archive), { menu = false; vm.updateConversation(conversation, archived = !conversation.archived) }, AppGlyphs.archive)
                ClaudeMenuItem(stringResource(R.string.chat_menu_delete), { menu = false; delete(conversation) }, AppGlyphs.trash, destructive = true)
            }
        }
    }
}

/** Section header: 15/550 text-500, 16 × 8 dp padding, one line, heading. */
@Composable fun DrawerSectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() }, style = Claude.type.body15Strong,
        color = Claude.colors.text500, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** Conversation row: 12 dp side margin, 10 dp clip, selected = D0 (animated), padding 12/11,
 *  title 15/400 text-100 one line; an unread reply shows the 8 dp accent dot in front. Long press = menu. */
@Composable fun DrawerConversationRow(title: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier,
    unread: Boolean = false, description: String = title, onLongClick: (() -> Unit)? = null) {
    val c = Claude.colors
    val background by animateColorAsState(if (selected) c.drawerSelected else Color.Transparent, label = "drawer_item_background")
    Row(modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(Claude.shapes.drawerRow).background(background)
        .combinedClickable(onClick = onClick, onLongClick = onLongClick).padding(horizontal = 12.dp, vertical = 11.dp)
        .semantics(mergeDescendants = true) { contentDescription = description },
        verticalAlignment = Alignment.CenterVertically) {
        if (unread) Box(Modifier.padding(start = 4.dp, end = 12.dp).size(8.dp).clip(CircleShape).background(c.accentMain100))
        Text(title, Modifier.weight(1f), style = Claude.type.body15, color = c.text100, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** "Show all %d" / "Show less" with caret, 4 dp above and 8 dp below. */
@Composable private fun ShowAllRow(expanded: Boolean, count: Int, toggle: () -> Unit) {
    val c = Claude.colors
    Column {
        Spacer(Modifier.height(4.dp))
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(Claude.shapes.drawerRow).clickable(role = Role.Button, onClick = toggle)
            .padding(horizontal = 12.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (expanded) stringResource(R.string.nav_drawer_pinned_show_less) else pluralStringResource(R.plurals.nav_drawer_pinned_show_all, count, count),
                style = Claude.type.body15, color = c.text500)
            Icon(if (expanded) AppGlyphs.caretUp else AppGlyphs.caretDown, null, Modifier.size(20.dp), tint = c.text500)
        }
        Spacer(Modifier.height(8.dp))
    }
}

/** Bottom user bar (`lab`): 44 dp fade into bg-200, avatar 44 + name + subtitle (tap = Settings),
 *  and the New chat pill (44 dp, text-100 fill, bg-000 label 15/550, padding 16/8/24/8). */
@Composable private fun DrawerAccountBar(vm: AppViewModel, snapshot: Snapshot, modifier: Modifier, onSettings: () -> Unit, onNewChat: () -> Unit) {
    val c = Claude.colors
    val label = vm.api.session?.accountLabel.orEmpty()
    val name = if (BuildConfig.DEMO_MODE) "示例账户" else snapshot.accountName.ifBlank { label }
    val subtitle = if (BuildConfig.DEMO_MODE) "name@example.com" else label.takeIf { it.isNotBlank() && it != name }
    val a11y = if (name.isBlank()) stringResource(R.string.user_avatar_settings_content_description, stringResource(R.string.user_avatar_default_content_description))
        else stringResource(R.string.user_avatar_settings_content_description, name)
    Column(modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().height(44.dp).background(Brush.verticalGradient(listOf(c.bg200.copy(alpha = 0f), c.bg200))))
        Row(Modifier.fillMaxWidth().background(c.bg200).clickable(enabled = false) {}.navigationBarsPadding()
            .padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).clip(Claude.shapes.r10).clickable(role = Role.Button, onClick = onSettings).semantics(mergeDescendants = true) { contentDescription = a11y },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ClaudeAvatar(name, AvatarSize.Account)
                Column(Modifier.weight(1f, fill = false)) {
                    Text(name.ifBlank { stringResource(R.string.user_avatar_default_content_description) }, style = Claude.type.body15Strong, color = c.text100, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    subtitle?.let { Text(it, style = Claude.type.body13, color = c.text500, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
            Spacer(Modifier.width(12.dp))
            Surface(onClick = onNewChat, shape = CircleShape, color = c.text100, contentColor = c.bg000, modifier = Modifier.height(44.dp)) {
                Row(Modifier.padding(start = 16.dp, top = 8.dp, end = 24.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(AppGlyphs.add, null, Modifier.size(20.dp))
                    Text(stringResource(R.string.chat_new_chat), style = Claude.type.body15Strong, maxLines = 1)
                }
            }
        }
    }
}

/** Rename dialog (`ChatScreenDialog.Rename`): title "Rename", the current title in a field. */
@Composable fun RenameConversationDialog(conversation: Conversation, dismiss: () -> Unit, save: (String) -> Unit) {
    var title by remember(conversation.id) { mutableStateOf(conversation.title) }
    ClaudeAlertDialog(onDismissRequest = dismiss, title = { Text(stringResource(R.string.chat_menu_rename_dialog_title)) },
        text = { ClaudeTextField(title, { title = it }, Modifier.fillMaxWidth(), shape = Claude.shapes.field, container = Claude.colors.bg000, border = Claude.colors.border300) },
        dismissButton = { ClaudeButton(stringResource(R.string.generic_button_cancel), dismiss, variant = ButtonVariant.Secondary, size = ButtonSize.Small) },
        confirmButton = { ClaudeButton(stringResource(R.string.generic_button_done), { save(title.trim()) }, size = ButtonSize.Small, enabled = title.isNotBlank()) })
}
