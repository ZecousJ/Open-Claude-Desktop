@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

/** The level colour of a status slot, from the theme's success / warning / danger tokens. */
@Composable private fun levelColor(level: String): Color = when (level) {
    "operational" -> Claude.colors.success100
    "degraded" -> Claude.colors.warning
    "outage" -> Claude.colors.danger100
    else -> Claude.colors.bg400
}

/**
 * Service status (Claudex-only, strings-feature-map C25) in the Usage page's look: the current state and the
 * 24-hour window with earlier / later; one tile per channel with its uptime bars (meter-row style, tap = details);
 * incidents as rows; then the GPT IQ check gallery (C26). Pull to refresh.
 */
@Composable fun StatusScreen(vm: AppViewModel, nav: NavHostController) {
    var result by remember { mutableStateOf<JSONObject?>(null) }
    var failed by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<JSONObject?>(null) }
    var end by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    suspend fun read() {
        if (BuildConfig.DEMO_MODE) return
        loading = true
        try { result = vm.api.request(StatusPresentation.path(end), authorized = true, method = "GET").getJSONObject("data"); failed = false }
        catch (e: CancellationException) { throw e } catch (_: Exception) { failed = true }
        finally { loading = false }
    }
    LaunchedEffect(end, refresh) { read() }
    val c = Claude.colors
    OfficialPage(stringResource(R.string.claudex_status_title), onBack = { nav.popBackStack() }) {
        PullToRefreshBox(refreshing, onRefresh = { scope.launch { refreshing = true; read(); refreshing = false } }, Modifier.weight(1f).fillMaxWidth()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Spacer(Modifier.height(12.dp))
                val data = result
                when {
                    BuildConfig.DEMO_MODE -> OfficialEmptyState(AppGlyphs.activity, stringResource(R.string.claudex_demo_unavailable), Modifier.padding(top = 48.dp))
                    data == null && failed -> OfficialErrorState(stringResource(R.string.claudex_status_load_error), { refresh++ }, Modifier.padding(top = 48.dp))
                    data == null -> LoadingState()
                    else -> {
                        SettingsGroup {
                            SettingsTile(padding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                    Box(Modifier.size(10.dp).clip(Claude.shapes.pill).background(levelColor(data.optString("level"))))
                                    Text(StatusPresentation.label(data.optString("level")), style = Claude.type.body17Strong, color = c.text100)
                                }
                                Spacer(Modifier.height(4.dp))
                                Text(stringResource(R.string.claudex_status_updated, NativeDetailPolicy.localTime(data.optString("generated_at"))), style = Claude.type.body15, color = c.text500)
                            }
                            Row(Modifier.fillMaxWidth().clip(Claude.shapes.settingsRow).background(c.bg000).heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                val previous = StatusPresentation.previous(data.optString("start"))
                                val next = StatusPresentation.next(data.optString("end"), data.optString("timezone"), System.currentTimeMillis())
                                ClaudeIconButton(AppGlyphs.caretLeft, stringResource(R.string.claudex_status_earlier), { end = previous }, enabled = !loading && previous != null)
                                Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text(StatusPresentation.range(data.optString("start"), data.optString("end")), style = Claude.type.body15, color = c.text100, maxLines = 1)
                                    Text(data.optString("timezone"), style = Claude.type.body13, color = c.text500, maxLines = 1)
                                }
                                ClaudeIconButton(AppGlyphs.caretRight, stringResource(R.string.claudex_status_later), { end = next }, enabled = !loading && end != null)
                            }
                            if (end != null) SettingsRow(stringResource(R.string.claudex_status_back_to_now), { end = null }, AppGlyphs.arrowCounterClockwise, enabled = !loading)
                        }
                        val channels = StatusPresentation.channels(data)
                        GroupGap()
                        SettingsSectionHeader(stringResource(R.string.claudex_status_channels))
                        if (channels.isEmpty()) SettingsFootnote(stringResource(R.string.claudex_status_no_channels))
                        else SettingsGroup { channels.forEach { channel -> ChannelTile(channel, data.optBoolean("hourly"), data.optInt("step_minutes", 10)) { selected = channel } } }
                        val incidents = StatusPresentation.incidents(data)
                        GroupGap()
                        SettingsSectionHeader(stringResource(R.string.claudex_status_incidents))
                        if (incidents.isEmpty()) SettingsFootnote(stringResource(R.string.claudex_status_no_incidents))
                        else SettingsGroup { incidents.forEach { item -> SettingsRow(item.optString("title").take(200), { selected = item }, AppGlyphs.warning, subtitle = StatusPresentation.incident(item.optString("status"))) } }
                        IqChecks(data)
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
    selected?.let { item -> StatusDetailDialog(item) { selected = null } }
}

/** A channel as a meter row: name 17/400, the uptime bars (one per slot, level colours, 1 dp apart), caption 15/400 text-500. */
@Composable private fun ChannelTile(channel: JSONObject, hourly: Boolean, stepMinutes: Int, onClick: () -> Unit) {
    val c = Claude.colors
    Column(Modifier.fillMaxWidth().clip(Claude.shapes.settingsRow).background(c.bg000).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp)) {
        Text(channel.optString("name").take(100), style = Claude.type.body17, color = c.text100, maxLines = 2, overflow = TextOverflow.Ellipsis)
        val slots = StatusPresentation.slots(channel)
        if (slots.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth().height(20.dp), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
                slots.forEach { slot -> Box(Modifier.weight(1f).fillMaxHeight().clip(Claude.shapes.r2).background(levelColor(slot.optString("level")))) }
            }
        }
        Spacer(Modifier.height(8.dp))
        val step = if (hourly) stringResource(R.string.claudex_status_step_minutes, stepMinutes) else stringResource(R.string.claudex_status_step_day)
        Text(listOf(StatusPresentation.label(channel.optString("level")), StatusPresentation.uptime(channel.opt("uptime")), step).joinToString(" · "), style = Claude.type.body15, color = c.text500)
    }
}

/** Details of a channel or an incident in the Cds dialog. */
@Composable private fun StatusDetailDialog(item: JSONObject, dismiss: () -> Unit) {
    val c = Claude.colors
    ClaudeAlertDialog(onDismissRequest = dismiss, title = { Text(item.optString("title", item.optString("name")).take(200)) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (item.has("status")) Text(StatusPresentation.incident(item.optString("status")), style = Claude.type.body15Strong, color = c.text100)
            Text(item.optString("message", StatusPresentation.label(item.optString("level"))).take(5000))
            listOf("started_at" to R.string.claudex_status_started, "updated_at" to R.string.claudex_status_updated, "resolved_at" to R.string.claudex_status_resolved).forEach { (key, label) ->
                if (!item.isNull(key) && item.has(key)) Text(stringResource(label, NativeDetailPolicy.localTime(item.optString(key))), style = Claude.type.body13, color = c.text500)
            }
            item.optJSONArray("updates")?.objects().orEmpty().take(50).forEach { update ->
                Text(StatusPresentation.incident(update.optString("status")) + " · " + NativeDetailPolicy.localTime(update.optString("created_at")), style = Claude.type.body13Strong, color = c.text100)
                Text(update.optString("message").take(5000))
            }
            item.optJSONArray("components")?.objects().orEmpty().take(100).forEach { component ->
                Text(component.optString("name").take(200) + " · " + StatusPresentation.label(component.optString("level")) + " · " + StatusPresentation.uptime(component.opt("uptime")), style = Claude.type.body13)
            }
        }
    }, confirmButton = { ClaudeButton(stringResource(R.string.generic_button_done), dismiss, size = ButtonSize.Small) })
}
