@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
package com.claudex.mobile

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.Mode
import com.claudex.core.Project
import com.claudex.core.newId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** When a project last moved: its newest chat, else when it was made. */
private fun projectActivity(project: Project, snapshot: com.claudex.core.Snapshot): Long =
    maxOf(project.createdAt, snapshot.conversations.filter { it.projectId == project.id }.maxOfOrNull { it.updatedAt } ?: 0L)

/**
 * Projects list: search field in the list, project rows (title,
 * description or "Private", trailing relative time), long press = the project menu, and the extended
 * "New project" button. Filters are left out: the service keeps no pinned, shared or archived projects.
 */
@Composable fun WorkScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var search by rememberSaveable { mutableStateOf("") }
    var editing by remember { mutableStateOf<Project?>(null) }
    var deleting by remember { mutableStateOf<Project?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val projects = snapshot.projects.filter { search.isBlank() || (it.name + " " + it.description).contains(search.trim(), true) }
        .sortedByDescending { projectActivity(it, snapshot) }
    OfficialPage(stringResource(R.string.project_list_screen_title_simple)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            PullToRefreshBox(refreshing, onRefresh = {
                scope.launch { refreshing = true; try { vm.repository.refresh() } catch (e: CancellationException) { throw e } catch (_: Exception) {} finally { refreshing = false } }
            }, Modifier.fillMaxSize()) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                    item(key = "search") { ListSearchField(search, { search = it.take(200) }, stringResource(R.string.project_list_search_placeholder), Modifier.padding(12.dp)) }
                    if (projects.isEmpty()) item(key = "empty") {
                        if (search.isNotBlank()) OfficialEmptyState(AppGlyphs.searchCircle, stringResource(R.string.empty_state_search_title, search.trim()), Modifier.padding(top = 48.dp))
                        else OfficialEmptyState(AppGlyphs.projects, stringResource(R.string.empty_state_project_title), Modifier.padding(top = 96.dp))
                    }
                    items(projects, key = { it.id }) { project ->
                        var menu by remember { mutableStateOf(false) }
                        Box(Modifier.animateItem()) {
                            OfficialListRow(project.name.ifBlank { stringResource(R.string.generic_project) }, { nav.navigate("project/${project.id}") },
                                subtitle = project.description.trim().ifBlank { stringResource(R.string.project_badge_private) },
                                onLongClick = { menu = true }, startPadding = 12.dp,
                                trailing = { Text(relativeTime(projectActivity(project, snapshot), capitalise = false), style = Claude.type.body13, color = Claude.colors.text500) })
                            ProjectItemMenu(menu, { menu = false }, onEdit = { editing = project }, onDelete = { deleting = project })
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                }
            }
            ExtendedFloatingActionButton({ nav.navigate("project-new") }, Modifier.align(Alignment.BottomEnd).padding(16.dp),
                containerColor = Claude.colors.text100, contentColor = Claude.colors.bg100, shape = Claude.shapes.pill) {
                Icon(AppGlyphs.add, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.project_list_new_project), style = Claude.type.body15Strong)
            }
        }
    }
    editing?.let { project -> ProjectDetailsDialog(project, { editing = null }) { vm.saveProject(it); editing = null } }
    deleting?.let { project -> DeleteProjectDialog(vm, project, { deleting = null }) {} }
}

/** Project item menu (`project/menu/e.a`): Edit details and Delete. Pin, visibility, share link and archive are left out (the service has none of them). */
@Composable private fun ProjectItemMenu(expanded: Boolean, dismiss: () -> Unit, onEdit: () -> Unit, onDelete: () -> Unit) {
    ClaudeDropdownMenu(expanded, dismiss) {
        ClaudeMenuItem(stringResource(R.string.project_edit_details), { dismiss(); onEdit() }, AppGlyphs.note)
        ClaudeMenuItem(stringResource(R.string.project_delete), { dismiss(); onDelete() }, AppGlyphs.trash, destructive = true)
    }
}

/** Edit details: name and description in the Cds dialog. */
@Composable fun ProjectDetailsDialog(project: Project, dismiss: () -> Unit, save: (Project) -> Unit) {
    var name by remember(project.id) { mutableStateOf(project.name) }
    var description by remember(project.id) { mutableStateOf(project.description) }
    ClaudeAlertDialog(onDismissRequest = dismiss, title = { Text(stringResource(R.string.project_edit_details)) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FieldLabel(stringResource(R.string.project_create_screen_project_title_input_label))
            SettingsTextField(name, { name = it.take(200) }, placeholder = stringResource(R.string.project_create_screen_project_title_input_placeholder))
            Spacer(Modifier.height(4.dp))
            FieldLabel(stringResource(R.string.project_create_screen_project_description_label))
            SettingsTextField(description, { description = it.take(2000) }, placeholder = stringResource(R.string.project_create_screen_project_description_placeholder), singleLine = false, minLines = 3)
        }
    }, dismissButton = { ClaudeButton(stringResource(R.string.generic_button_cancel), dismiss, variant = ButtonVariant.Secondary, size = ButtonSize.Small) },
        confirmButton = { ClaudeButton(stringResource(R.string.generic_save), { save(project.copy(name = name.trim(), description = description.trim())) }, size = ButtonSize.Small, enabled = name.isNotBlank()) })
}

/** Delete project: "Delete project" / "Are you sure you want to delete “name”?" / destructive Delete. */
@Composable private fun DeleteProjectDialog(vm: AppViewModel, project: Project, dismiss: () -> Unit, deleted: () -> Unit) {
    val operations by vm.conversationActions.collectAsStateWithLifecycle()
    ClaudeDialog(stringResource(R.string.project_delete_dialog_title), stringResource(R.string.project_delete_dialog_subtitle, project.name),
        stringResource(R.string.project_delete), { vm.deleteProject(project) { dismiss(); deleted() } }, dismiss, destructive = true, busy = "project:${project.id}" in operations)
}

/** Create a project (`project_create_screen_*`): name, description and "Create project". Visibility is left out (every project is the account's own). */
@Composable fun CreateProjectScreen(vm: AppViewModel, nav: NavHostController) {
    var name by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    OfficialPage(stringResource(R.string.project_create_screen_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp)) {
            FieldLabel(stringResource(R.string.project_create_screen_project_title_input_label))
            SettingsTextField(name, { name = it.take(200) }, placeholder = stringResource(R.string.project_create_screen_project_title_input_placeholder))
            Spacer(Modifier.height(16.dp))
            FieldLabel(stringResource(R.string.project_create_screen_project_description_label))
            SettingsTextField(description, { description = it.take(2000) }, placeholder = stringResource(R.string.project_create_screen_project_description_placeholder), singleLine = false, minLines = 4)
        }
        ClaudeButton(stringResource(R.string.project_create_submit_button_text), {
            val project = Project(newId(), name.trim(), description.trim(), "")
            vm.saveProject(project)
            nav.navigate("project/${project.id}") { popUpTo("work") }
        }, Modifier.padding(16.dp).navigationBarsPadding(), size = ButtonSize.Large, fillWidth = true, enabled = name.isNotBlank())
    }
}

/**
 * Project screen: top bar with the project name and its menu; description
 * (tap to expand) and the Private badge; the Project knowledge and Custom instructions cards; the
 * project's chats; the composer starts a new chat in the project.
 */
@Composable fun ProjectScreen(vm: AppViewModel, nav: NavHostController, id: String) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val project = snapshot.projects.find { it.id == id }
    var menu by remember { mutableStateOf(false) }
    var edit by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var instructions by remember { mutableStateOf(false) }
    var expanded by rememberSaveable { mutableStateOf(false) }
    var knowledge by remember(id) { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(id) { vm.mode.value = Mode.CHAT }
    LaunchedEffect(id) { (vm.repository as? RemoteRepository)?.let { repo -> runCatching { knowledge = repo.rpc("listProjectKnowledge", id) as? JSONObject } } }
    val c = Claude.colors
    OfficialPage(project?.name?.ifBlank { null } ?: stringResource(R.string.generic_project), onBack = { nav.popBackStack() }, actions = {
        if (project != null) Box {
            ClaudeIconButton(AppGlyphs.dotsHorizontal, stringResource(R.string.generic_button_more_options), { menu = true })
            ProjectItemMenu(menu, { menu = false }, onEdit = { edit = true }, onDelete = { deleting = true })
        }
    }) {
        if (project == null) {
            OfficialEmptyState(AppGlyphs.projects, stringResource(R.string.claudex_project_not_found), Modifier.weight(1f))
            return@OfficialPage
        }
        val chats = snapshot.conversations.filter { it.projectId == id && !it.archived }.sortedByDescending { it.updatedAt }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 16.dp)) {
            item(key = "header") {
                Column(Modifier.padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (project.description.isNotBlank()) AnimatedContent(expanded, label = "InfoFooter expanded") { open ->
                        Text(project.description, Modifier.clip(Claude.shapes.r8).clickable { expanded = !open }, style = Claude.type.body15, color = c.text300,
                            maxLines = if (open) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis)
                    }
                    Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ProjectBadge(stringResource(R.string.project_badge_private))
                    }
                }
            }
            item(key = "cards") {
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    val files = knowledge?.optJSONArray("files")?.length() ?: 0
                    ProjectCard(stringResource(R.string.project_details_knowledge_title),
                        if (files > 0) pluralStringResource(R.plurals.project_details_knowledge_file_count, files, files) else null,
                        stringResource(R.string.project_details_knowledge_empty_label), Modifier.weight(1f)) { nav.navigate("project/$id/knowledge") }
                    ProjectCard(stringResource(R.string.project_details_custom_instructions_item_title), project.instructions.trim().ifBlank { null },
                        stringResource(R.string.project_details_custom_instructions_item_empty_label), Modifier.weight(1f), previewLines = 3) { instructions = true }
                }
                Spacer(Modifier.height(16.dp))
            }
            if (chats.isEmpty()) item(key = "empty") { OfficialEmptyState(AppGlyphs.chats, stringResource(R.string.project_details_chats_empty_state), Modifier.padding(top = 24.dp)) }
            items(chats, key = { it.id }) { chat ->
                OfficialListRow(chat.title.ifBlank { stringResource(R.string.generic_untitled) }, { nav.navigate("conversation/${chat.id}") },
                    subtitle = relativeTime(chat.updatedAt), pinned = chat.pinned,
                    leading = { StatusMark(if (chat.unread) RowStatus.New else RowStatus.Quiet) })
            }
        }
        Composer(vm, nav, projectId = id)
    }
    val current = project ?: return
    if (edit) ProjectDetailsDialog(current, { edit = false }) { vm.saveProject(it); edit = false }
    if (deleting) DeleteProjectDialog(vm, current, { deleting = false }) { nav.navigate("work") { popUpTo("home"); launchSingleTop = true } }
    if (instructions) {
        var text by remember(current.id) { mutableStateOf(current.instructions) }
        TextInputDialog(stringResource(R.string.project_details_custom_instructions_dialog_title), text, { text = it.take(20_000) }, stringResource(R.string.generic_save),
            { vm.saveProject(current.copy(instructions = text.trim())); instructions = false }, { instructions = false },
            description = stringResource(R.string.project_details_custom_instructions_dialog_description, current.name),
            placeholder = stringResource(R.string.project_details_custom_instructions_dialog_placeholder), singleLine = false, minLines = 4, enabled = true)
    }
}

/** Badge chip in the project header: 13/400 on the 10 % fill, lock glyph. */
@Composable private fun ProjectBadge(text: String) {
    val c = Claude.colors
    Row(Modifier.clip(Claude.shapes.pill).background(c.fill10).padding(horizontal = 8.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(AppGlyphs.lock, null, Modifier.size(12.dp), tint = c.text300)
        Text(text, style = Claude.type.body13, color = c.text300)
    }
}

/** Knowledge / instructions card: bg-300 surface, 12 dp corners, 12 dp padding, ≥ 80 dp; 13/550 title, 13/400 body or the clay "Add …" label. */
@Composable private fun ProjectCard(title: String, body: String?, addLabel: String, modifier: Modifier, previewLines: Int = 1, onClick: () -> Unit) {
    val c = Claude.colors
    Surface(onClick, modifier.fillMaxHeight().heightIn(min = 80.dp), shape = Claude.shapes.r12, color = c.bg300, contentColor = c.text300) {
        Column(Modifier.fillMaxHeight().padding(12.dp)) {
            Text(title, style = Claude.type.body13Strong, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.heightIn(min = 12.dp).weight(1f))
            if (body != null) Text(body, style = Claude.type.body13, maxLines = previewLines, overflow = TextOverflow.Ellipsis)
            else Text(addLabel, style = Claude.type.body13Strong, color = c.clay)
        }
    }
}

/**
 * Project Knowledge: capacity bar and "%d%% of project capacity used",
 * an adaptive grid of file tiles (long press = Delete), "Uploading…" tiles while a file goes up, and
 * the full-width "Add Content" button opening the Add Content sheet.
 */
@Composable fun ProjectKnowledgeScreen(vm: AppViewModel, nav: NavHostController, projectId: String) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val project = snapshot.projects.find { it.id == projectId }
    val repo = vm.repository as? RemoteRepository
    val context = LocalContext.current
    val c = Claude.colors
    var knowledge by remember(projectId) { mutableStateOf<JSONObject?>(null) }
    var loadFailed by remember { mutableStateOf(false) }
    var uploading by remember { mutableStateOf(listOf<String>()) }
    var addSheet by remember { mutableStateOf(false) }
    var createDoc by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun load() { if (repo != null) scope.launch { try { loadFailed = false; knowledge = repo.rpc("listProjectKnowledge", projectId) as? JSONObject } catch (e: CancellationException) { throw e } catch (_: Exception) { loadFailed = true } } }
    LaunchedEffect(projectId) { load() }
    fun upload(label: String, block: suspend () -> JSONObject) {
        uploading = uploading + label
        scope.launch {
            try { knowledge = block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { vm.error.value = e.message?.takeIf { it.isNotBlank() } ?: context.getString(R.string.project_knowledge_upload_failed) }
            finally { uploading = uploading - label }
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null && repo != null) {
            var name = context.getString(R.string.claudex_knowledge_default_file_name)
            runCatching { context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) name = it.getString(0) ?: name } }
            upload(name) {
                val bytes = withContext(Dispatchers.IO) {
                    require(name.substringAfterLast('.').lowercase() in KnowledgeUpload.extensions) { context.getString(R.string.project_knowledge_file_type_error) }
                    val output = java.io.ByteArrayOutputStream()
                    context.contentResolver.openInputStream(uri)?.use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break
                        require(output.size() + n <= KnowledgeUpload.FILE_LIMIT) { context.getString(R.string.claudex_knowledge_file_too_large) }; output.write(buffer, 0, n) } }
                        ?: error(context.getString(R.string.project_knowledge_upload_failed))
                    require(output.size() > 0) { context.getString(R.string.project_knowledge_upload_failed) }
                    output.toByteArray()
                }
                val data = repo.uploadReference(name, context.contentResolver.getType(uri) ?: "application/octet-stream", bytes)
                repo.rpc("addProjectKnowledgeFiles", projectId, JSONArray(listOf(JSONObject().put("name", name).put("data", data)))) as JSONObject
            }
        }
    }
    OfficialPage(stringResource(R.string.project_knowledge_screen_title), onBack = { nav.popBackStack() }) {
        val files = knowledge?.optJSONArray("files")?.objects().orEmpty()
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                repo == null -> OfficialEmptyState(AppGlyphs.fileAdd, stringResource(R.string.claudex_demo_unavailable), Modifier.align(Alignment.Center))
                knowledge == null && loadFailed -> OfficialErrorState(stringResource(R.string.generic_error_something_went_wrong), ::load, Modifier.align(Alignment.Center))
                knowledge == null -> LoadingState(Modifier.align(Alignment.Center))
                files.isEmpty() && uploading.isEmpty() -> OfficialEmptyState(AppGlyphs.fileAdd,
                    if (project != null) stringResource(R.string.project_knowledge_screen_empty_state_title, project.name) else stringResource(R.string.project_knowledge_screen_empty_state_title_no_name),
                    Modifier.align(Alignment.Center))
                else -> LazyVerticalGrid(GridCells.Adaptive(120.dp), Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, top = 0.dp, end = 16.dp, bottom = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item(span = { GridItemSpan(maxLineSpan) }, key = "capacity") { CapacityHeader(knowledge!!) }
                    items(files.sortedBy { it.optString("name").lowercase() }, key = { "file:" + it.optString("name") }) { file ->
                        var menu by remember { mutableStateOf(false) }
                        Box {
                            KnowledgeTile(file.optString("name"), SearchLibraryPolicy.sizeLabel(file.optLong("bytes")), onClick = { menu = true }, onLongClick = { menu = true })
                            ClaudeDropdownMenu(menu, { menu = false }) {
                                ClaudeMenuItem(stringResource(R.string.project_knowledge_delete_doc_button), { menu = false; removing = file.optString("name") }, AppGlyphs.trash, destructive = true)
                            }
                        }
                    }
                    items(uploading, key = { "up:$it" }) { name -> KnowledgeTile(name, stringResource(R.string.project_knowledge_uploading), uploading = true) }
                }
            }
        }
        ClaudeButton(stringResource(R.string.project_knowledge_add_content_button), { addSheet = true }, Modifier.padding(16.dp).navigationBarsPadding(),
            size = ButtonSize.Large, fillWidth = true, enabled = repo != null && knowledge != null)
    }
    if (addSheet) ClaudeModalBottomSheet({ addSheet = false }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).navigationBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.project_knowledge_add_content_sheet_title), style = Claude.type.body17Strong, color = c.text100, textAlign = TextAlign.Center)
            Text(stringResource(R.string.project_knowledge_add_content_sheet_subtitle), style = Claude.type.body15, color = c.text500, textAlign = TextAlign.Center)
            Spacer(Modifier.height(12.dp))
            AddContentOption(stringResource(R.string.project_knowledge_upload_button), AppGlyphs.fileUpload) { addSheet = false; picker.launch(arrayOf("*/*")) }
            Spacer(Modifier.height(8.dp))
            AddContentOption(stringResource(R.string.project_knowledge_create_button), AppGlyphs.edit) { addSheet = false; createDoc = true }
            Spacer(Modifier.height(16.dp))
        }
    }
    if (createDoc) {
        var title by rememberSaveable { mutableStateOf("") }
        var body by rememberSaveable { mutableStateOf("") }
        ClaudeAlertDialog(onDismissRequest = { createDoc = false }, title = { Text(stringResource(R.string.project_knowledge_create_button)) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                FieldLabel(stringResource(R.string.create_project_doc_title_field_label))
                SettingsTextField(title, { title = it.take(200) })
                Spacer(Modifier.height(8.dp))
                FieldLabel(stringResource(R.string.create_project_doc_content_field_label))
                SettingsTextField(body, { body = it.take(1_000_000) }, singleLine = false, minLines = 3, maxLines = 10)
            }
        }, dismissButton = { ClaudeButton(stringResource(R.string.generic_button_cancel), { createDoc = false }, variant = ButtonVariant.Secondary, size = ButtonSize.Small) },
            confirmButton = { ClaudeButton(stringResource(R.string.generic_save), {
                val name = KnowledgeUpload.documentName(title)
                createDoc = false
                if (repo != null) upload(name) { repo.rpc("addProjectKnowledgeText", projectId, JSONObject().put("name", name).put("text", body)) as JSONObject }
            }, size = ButtonSize.Small, enabled = title.isNotBlank() && body.isNotBlank()) })
    }
    removing?.let { name -> ClaudeDialog(stringResource(R.string.project_knowledge_delete_doc_dialog_title), stringResource(R.string.delete_dialog_default_subtitle),
        stringResource(R.string.project_knowledge_delete_doc_button), {
            removing = null
            if (repo != null) scope.launch { try { knowledge = repo.rpc("removeProjectKnowledge", projectId, name) as JSONObject } catch (e: CancellationException) { throw e } catch (e: Exception) { vm.error.value = e.message } }
        }, { removing = null }, destructive = true) }
}

/** Knowledge file rules shared with the web (shared/collections-api.ts): text files and PDFs, 10 MB each. */
internal object KnowledgeUpload {
    const val FILE_LIMIT = 10_000_000
    val extensions = "txt md markdown csv tsv json jsonl yaml yml xml html htm svg mermaid css js mjs cjs ts tsx jsx py java c h cpp hpp cs go rs rb php swift kt sh sql toml ini log tex rst pdf".split(' ').toSet()
    /** A created document is kept as Markdown under its title. */
    fun documentName(title: String): String {
        val clean = title.trim().replace(Regex("[\\\\/:*?\"<>|]"), " ").trim().take(120).ifBlank { "Document" }
        return if (clean.substringAfterLast('.', "").lowercase() in extensions) clean else "$clean.md"
    }
}

@Composable private fun CapacityHeader(knowledge: JSONObject) {
    val limit = knowledge.optLong("limit")
    if (limit <= 0) return
    val used = knowledge.optLong("bytes").toDouble() / limit
    Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp)) {
        MeterBar(used.toFloat())
        Text(stringResource(R.string.project_knowledge_capacity_used, (used * 100).toInt().coerceIn(0, 100)), Modifier.padding(top = 8.dp),
            style = Claude.type.body15, color = Claude.colors.text300)
    }
}

/** File tile: square, bg-300, 16 dp corners, file glyph, name (2 lines) and size. */
@Composable private fun KnowledgeTile(name: String, meta: String, onClick: () -> Unit = {}, onLongClick: () -> Unit = {}, uploading: Boolean = false) {
    val c = Claude.colors
    Column(Modifier.fillMaxWidth().aspectRatio(1f).clip(Claude.shapes.r16).background(c.bg300)
        .combinedClickable(enabled = !uploading, onClick = onClick, onLongClick = onLongClick).padding(12.dp)) {
        if (uploading) ClaudeSpinner(SpinnerSize.Small) else Icon(AppGlyphs.file, null, Modifier.size(24.dp), tint = c.text300)
        Spacer(Modifier.weight(1f))
        Text(name, style = Claude.type.body13Strong, color = c.text100, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(meta, style = Claude.type.body13, color = c.text500, maxLines = 2)
    }
}

/** Add Content option button: 12 dp corners, bg-300, text-100, 12 dp padding, icon + label. */
@Composable private fun AddContentOption(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    val c = Claude.colors
    Row(Modifier.fillMaxWidth().clip(Claude.shapes.r12).background(c.bg300).clickable(role = Role.Button, onClick = onClick).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally)) {
        Icon(icon, null, Modifier.size(24.dp), tint = c.text100)
        Text(label, style = Claude.type.body15Strong, color = c.text100)
    }
}
