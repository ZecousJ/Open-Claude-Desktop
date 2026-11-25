@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
package com.claudex.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.Artifact
import com.claudex.core.DemoRepository
import com.claudex.core.Mode
import org.json.JSONObject

private enum class GalleryTab(val label: Int) { ALL(R.string.artifact_gallery_tab_all), PINNED(R.string.artifact_gallery_tab_pinned) }
private enum class GallerySource(val label: Int) { ALL(R.string.artifact_gallery_source_all), CHAT(R.string.artifact_gallery_source_chat), CODE(R.string.artifact_gallery_source_code) }

/** Pin, duplicate: the same calls as the artifact viewer. */
internal object ArtifactActions {
    fun pin(vm: AppViewModel, artifact: Artifact) = vm.work {
        val repo = vm.repository
        val next = !artifact.pinned
        try {
            if (repo is DemoRepository) repo.pinArtifact(artifact.id, next) else { (repo as RemoteRepository).rpc("pinArtifact", artifact.identity, next); repo.refresh() }
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled } catch (_: Exception) {
            error(UserText.get(if (next) R.string.ccr_artifact_pin_failed else R.string.ccr_artifact_unpin_failed))
        }
    }
    fun duplicate(vm: AppViewModel, artifact: Artifact) = vm.work {
        val repo = vm.repository
        if (repo is DemoRepository) repo.duplicateArtifact(artifact)
        else { (repo as RemoteRepository).rpc("duplicateArtifact", JSONObject().put("name", artifact.name).put("language", artifact.language).put("content", artifact.content).put("originConversationId", artifact.originConversationId)); repo.refresh() }
    }
    fun route(artifact: Artifact) = if (artifact.generatedFile != null) "generated/${android.net.Uri.encode(artifact.originConversationId.orEmpty())}/${android.net.Uri.encode(artifact.generatedFile!!.id)}"
        else "artifact/${android.net.Uri.encode(artifact.id)}"
}

/**
 * Artifacts gallery (`ArtifactGallery`, strings §3.13): search "Search artifacts", the All / Pinned tabs and the
 * All / Chat / Code source filter, then a grid of cards (preview, name, kind · size). Long press = Pin, Duplicate,
 * the chat it came from. Yours / Shared with you are left out: every artifact here is the account's own.
 */
@Composable fun LibraryScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(GalleryTab.ALL) }
    var source by rememberSaveable { mutableStateOf(GallerySource.ALL) }
    var sourceMenu by remember { mutableStateOf(false) }
    var search by rememberSaveable { mutableStateOf("") }
    val modes = snapshot.conversations.associate { it.id to it.mode }
    val artifacts = snapshot.artifacts.filter { a ->
        (tab == GalleryTab.ALL || a.pinned) &&
            (source == GallerySource.ALL || (source == GallerySource.CODE) == (modes[a.originConversationId] == Mode.CODE)) &&
            (search.isBlank() || (a.name + " " + a.content).contains(search.trim(), true))
    }.sortedByDescending { it.pinned }
    OfficialPage(stringResource(R.string.product_name_artifacts), actions = {
        Box {
            ClaudeIconButton(Anthropicons.filter, stringResource(if (source == GallerySource.ALL) R.string.artifact_gallery_filter_a11y else R.string.artifact_gallery_filter_change_a11y), { sourceMenu = true })
            ClaudeDropdownMenu(sourceMenu, { sourceMenu = false }) {
                GallerySource.entries.forEach { option -> ClaudeMenuItem(stringResource(option.label), { source = option; sourceMenu = false }, selected = option == source) }
            }
        }
    }) {
        LazyVerticalGrid(GridCells.Adaptive(160.dp), Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item(span = { GridItemSpan(maxLineSpan) }, key = "search") {
                Column {
                    ListSearchField(search, { search = it.take(200) }, stringResource(R.string.artifact_gallery_search), Modifier.padding(vertical = 12.dp))
                    val tabsLabel = stringResource(R.string.artifact_gallery_tabs_a11y)
                    Row(Modifier.horizontalScroll(rememberScrollState()).semantics { contentDescription = tabsLabel }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        GalleryTab.entries.forEach { option -> ClaudeChip(stringResource(option.label), { tab = option }, selected = tab == option, compact = true) }
                    }
                }
            }
            if (artifacts.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }, key = "empty") {
                val unfiltered = tab == GalleryTab.ALL && source == GallerySource.ALL && search.isBlank()
                OfficialEmptyState(Anthropicons.artifacts, stringResource(if (unfiltered) R.string.artifacts_empty_state else R.string.artifact_gallery_no_matches), Modifier.padding(top = 48.dp))
            }
            items(artifacts, key = { it.id }) { artifact -> ArtifactCard(vm, nav, artifact) }
        }
    }
}

/** Text and Markdown are documents, HTML and React are interactive, SVG and pictures are images, Mermaid is a diagram. */
private fun artifactTypeLabel(artifact: Artifact): Int {
    if (artifact.generatedFile?.blob == true) return R.string.artifact_type_document
    return when (artifact.language.lowercase()) {
        "html", "htm", "jsx", "tsx", "react" -> R.string.artifact_type_interactive
        "svg", "png", "jpg", "jpeg", "gif", "webp" -> R.string.artifact_type_image
        "mermaid" -> R.string.artifact_type_diagram
        "md", "markdown", "text", "txt", "" -> R.string.artifact_type_document
        else -> R.string.artifact_type_code
    }
}

/** Gallery card: 4:3 preview tile (bg-200, 12 dp corners, hairline), name 15/550 two lines, meta 13/400 text-500. */
@Composable private fun ArtifactCard(vm: AppViewModel, nav: NavHostController, artifact: Artifact) {
    var menu by remember { mutableStateOf(false) }
    val c = Claude.colors
    val preview = remember(artifact.content) {
        artifact.content.replace(Regex("<(style|script)[^>]*>.*?</(style|script)>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)), " ")
            .replace(Regex("<[^>]*>"), " ").replace(Regex("\\s+"), " ").trim().take(160)
    }
    val open = stringResource(R.string.artifact_gallery_open_a11y)
    Box {
        Column(Modifier.fillMaxWidth().clip(Claude.shapes.r12).combinedClickable(onClickLabel = open, role = Role.Button, onClick = { nav.navigate(ArtifactActions.route(artifact)) }, onLongClick = { menu = true }),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.fillMaxWidth().aspectRatio(4f / 3f).clip(Claude.shapes.r12).background(c.bg200).border(1.dp, c.borderDefault, Claude.shapes.r12).padding(12.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(when (artifact.language) { "html" -> Anthropicons.globe; "svg" -> Anthropicons.image; "markdown", "md" -> Anthropicons.file; else -> Anthropicons.code }, null, Modifier.size(20.dp), tint = c.text500)
                    Text(preview, style = Claude.type.body13, color = c.text500, maxLines = 4, overflow = TextOverflow.Ellipsis)
                }
                if (artifact.pinned) Icon(Anthropicons.pinFilled, stringResource(R.string.artifact_gallery_pinned), Modifier.align(Alignment.TopEnd).size(16.dp), tint = c.text500)
            }
            Column(Modifier.padding(horizontal = 2.dp)) {
                Text(artifact.name.ifBlank { stringResource(R.string.artifact_name_default_title) }, style = Claude.type.body15Strong, color = c.text100, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val type = stringResource(artifactTypeLabel(artifact))
                val editedAt = vm.snapshot.collectAsStateWithLifecycle().value.conversations.find { it.id == artifact.originConversationId }?.updatedAt
                Text(if (editedAt != null && editedAt > 0) stringResource(R.string.artifact_gallery_meta, type, stringResource(R.string.artifact_gallery_edited, relativeTime(editedAt, capitalise = false))) else type,
                    style = Claude.type.body13, color = c.text500, maxLines = 1)
            }
        }
        ClaudeDropdownMenu(menu, { menu = false }) {
            ClaudeMenuItem(stringResource(if (artifact.pinned) R.string.chat_unstar else R.string.chat_star), { menu = false; ArtifactActions.pin(vm, artifact) }, if (artifact.pinned) Anthropicons.pinSlash else Anthropicons.pin)
            if (artifact.generatedFile?.blob != true) ClaudeMenuItem(stringResource(R.string.claudex_artifact_duplicate), { menu = false; ArtifactActions.duplicate(vm, artifact) }, Anthropicons.copy)
            artifact.originConversationId?.let { origin -> ClaudeMenuItem(stringResource(R.string.claudex_artifact_open_chat), { menu = false; nav.navigate("conversation/$origin") }, Anthropicons.chat) }
        }
    }
}
