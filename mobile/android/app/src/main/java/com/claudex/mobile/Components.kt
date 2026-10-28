@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.*

@Composable fun Brand() { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { ClaudexMark(28.dp); Text("Claudex", style = Claude.type.topBarTitle, color = Claude.colors.text100) } }
/** Legacy page header on the official three-slot top bar: menu (or back) · title · actions. */
@Composable fun PageHeader(title: String? = null, nav: NavHostController? = null, back: (() -> Unit)? = null, menu: Boolean = false, actions: @Composable RowScope.() -> Unit = {}) {
    val openSidebar = LocalOpenSidebar.current
    val navigation = when {
        menu || nav == null && back == null -> TopBarNavigation.Menu(openSidebar)
        else -> TopBarNavigation.Back { if (back != null) back() else nav?.popBackStack() }
    }
    ClaudeTopBar(navigation, centerTitle = true, title = { title?.let { ClaudeTopBarTitle(it) } }, actions = actions)
}
/** Demo builds label sample data in debug only; release builds never show demo labels. */
@Composable fun DemoLabel() { if (BuildConfig.DEMO_MODE && BuildConfig.DEBUG) Text("本地演示 · 示例数据", modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp), color = Claude.colors.text500, style = Claude.type.body11) }
@Composable fun Heading(title: String, subtitle: String? = null) { Column(Modifier.padding(vertical = 12.dp)) { Text(title, style = Claude.type.screenTitle, color = Claude.colors.text100); subtitle?.let { Text(it, color = Claude.colors.text300, modifier = Modifier.padding(top = 6.dp), style = Claude.type.readingBody) } } }
@Composable fun SectionTitle(title: String, modifier: Modifier = Modifier) { Text(title, modifier.padding(top = 14.dp, bottom = 8.dp), style = Claude.type.body15Strong, color = Claude.colors.text500) }
/** Neutral notice card: bg-300, 12 dp corners, 15/400 text-300. */
@Composable fun Notice(text: String, icon: ImageVector = AppGlyphs.info) { Surface(color = Claude.colors.bg300, shape = Claude.shapes.r12) { Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) { Icon(icon, null, tint = Claude.colors.text300, modifier = Modifier.size(20.dp)); Text(text, style = Claude.type.body15, color = Claude.colors.text300) } } }
@Composable fun EmptyState(title: String, body: String) { Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 38.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) { Icon(AppGlyphs.chats, null, Modifier.size(32.dp), tint = Claude.colors.text500); Text(title, style = Claude.type.body17, color = Claude.colors.text100); Text(body, style = Claude.type.body15, color = Claude.colors.text500, textAlign = androidx.compose.ui.text.style.TextAlign.Center) } }
/** Legacy row = the settings navigation row (56 dp, 24 dp icon, 17/400 title, 15/400 subtitle, no chevron). */
@Composable fun ActionRow(title: String, subtitle: String = "", icon: ImageVector = AppGlyphs.file, onClick: () -> Unit, trailing: @Composable (() -> Unit)? = null, enabled: Boolean = true) {
    SettingsRow(title, onClick, icon, subtitle = subtitle.takeIf { it.isNotEmpty() }, enabled = enabled, subtitleMaxLines = 4, trailing = trailing)
}
/** Shared by chat and task details; the view lease prevents late navigation callbacks. */
@Composable fun ConversationContentStatus(vm: AppViewModel, conversationId: String) {
    val repository = vm.repository as? RemoteRepository ?: return
    val snapshot by repository.snapshot.collectAsStateWithLifecycle()
    val loads by repository.contentLoads.collectAsStateWithLifecycle()
    DisposableEffect(repository, conversationId) {
        val lease = repository.beginViewingConversation(conversationId)
        onDispose { repository.endViewingConversation(lease) }
    }
    val conversation = snapshot.conversations.find { it.id == conversationId } ?: return
    if (!conversation.slim) return
    val load = loads[conversationId]
    // No plumbing text (product rule): a quiet spinner while the full content loads; words only on failure.
    if (load is ContentLoadState.Failed) NoticeCard(load.message, Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
        androidx.compose.ui.res.stringResource(R.string.generic_retry), { repository.retryConversationContent(conversationId) }, icon = AppGlyphs.warningCircle)
    else Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) { ClaudeSpinner(SpinnerSize.Small) }
}
