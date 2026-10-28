@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** US dollars as the Billing / Usage pages show them. */
internal fun usd(value: Double): String = String.format(Locale.ROOT, "$%.2f", value)

/** Reads `billingInfo` (plan name, expiry, balance) once for the identity card and Billing. */
@Composable private fun rememberBillingInfo(vm: AppViewModel): JSONObject? {
    var billing by remember { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(Unit) { (vm.repository as? RemoteRepository)?.let { repo -> try { billing = repo.rpc("billingInfo") as? JSONObject } catch (e: CancellationException) { throw e } catch (_: Exception) {} } }
    return billing
}

/**
 * Settings root: identity card, then the official groups and row component —
 * 1 Profile, Billing, Usage, API; 2 Capabilities; 3 Color mode;
 * 4 Notifications, Service status, Sharing; 5 Log out. The ⓘ menu holds the version (tap copies it).
 */
@Composable fun SettingsScreen(vm: AppViewModel, nav: NavHostController) {
    val theme by vm.theme.collectAsStateWithLifecycle()
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val billing = rememberBillingInfo(vm)
    var colorMode by remember { mutableStateOf(false) }
    var logout by remember { mutableStateOf(false) }
    var loggingOut by remember { mutableStateOf(false) }
    var learnMore by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val versionText = stringResource(R.string.version_info_prefix, "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
    OfficialPage(stringResource(R.string.title_settings), onBack = { nav.popBackStack() }, actions = {
        Box {
            ClaudeIconButton(AppGlyphs.infoCircle, stringResource(R.string.learn_more_menu_icon_content_description), { learnMore = true }, tint = Claude.colors.text300)
            ClaudeDropdownMenu(learnMore, { learnMore = false }) {
                Text(versionText, Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(Claude.shapes.menuItem)
                    .padding(12.dp), style = Claude.type.body13, color = Claude.colors.text500, textAlign = TextAlign.End)
                ClaudeMenuItem(stringResource(R.string.generic_copy_content_description), {
                    clipboard.setText(AnnotatedString(versionText)); learnMore = false
                }, AppGlyphs.copy)
                LocalAppUpdater.current?.let { updater ->
                    val updateScope = rememberCoroutineScope()
                    ClaudeMenuItem(stringResource(R.string.claudex_update_check), {
                        learnMore = false; updateScope.launch { updater.check(asked = true) }
                    }, AppGlyphs.download)
                }
            }
        }
    }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            IdentityCard(vm, snapshot.accountName, billing?.optString("plan")?.takeIf { it.isNotBlank() && it != "null" })
            Spacer(Modifier.height(12.dp))
            SettingsGroup {
                SettingsRow(stringResource(R.string.title_profile), { nav.navigate("settings/profile") }, AppGlyphs.userCircle)
                SettingsRow(stringResource(R.string.title_billing), { nav.navigate("settings/billing") }, AppGlyphs.dollarSign)
                SettingsRow(stringResource(R.string.usage_title), { nav.navigate("usage") }, AppGlyphs.chartLine)
                SettingsRow(stringResource(R.string.claudex_api_title), { nav.navigate("api-groups") }, AppGlyphs.codeBlock)
            }
            GroupGap()
            SettingsGroup {
                SettingsRow(stringResource(R.string.capabilities_setting_title), { nav.navigate("memory") }, AppGlyphs.filter)
            }
            GroupGap()
            SettingsGroup {
                SettingsRow(stringResource(R.string.color_mode_setting_title), { colorMode = true }, AppGlyphs.moon, subtitle = colorModeLabel(theme))
            }
            GroupGap()
            SettingsGroup {
                SettingsRow(stringResource(R.string.notifications_section_title), { nav.navigate("settings/notifications") }, AppGlyphs.notification)
                SettingsRow(stringResource(R.string.claudex_status_title), { nav.navigate("status") }, AppGlyphs.activity)
                SettingsRow(stringResource(R.string.sharing_settings_title), { nav.navigate("settings/sharing") }, AppGlyphs.share)
            }
            GroupGap()
            SettingsGroup {
                if (BuildConfig.DEMO_MODE && BuildConfig.DEBUG) SettingsRow(stringResource(R.string.claudex_demo_fail_next), vm::demoFailNext, AppGlyphs.experiment)
                if (signedIn && !BuildConfig.DEMO_MODE) SettingsRow(stringResource(R.string.title_logout), { logout = true }, AppGlyphs.logout, titleColor = Claude.colors.dangerText)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    if (colorMode) OfficialPickerDialog(stringResource(R.string.color_mode_setting_title), listOf(
        PickerOption("system", stringResource(R.string.color_mode_setting_system), AppGlyphs.mobilePhone),
        PickerOption("light", stringResource(R.string.color_mode_setting_light), AppGlyphs.sun),
        PickerOption("dark", stringResource(R.string.color_mode_setting_dark), AppGlyphs.moon)), theme,
        onSelect = { vm.setTheme(it); colorMode = false }, onDismiss = { colorMode = false })
    if (logout) ClaudeDialog(stringResource(R.string.title_logout), stringResource(R.string.body_logout), stringResource(R.string.button_logout), {
        loggingOut = true
        vm.logout { loggingOut = false; logout = false; nav.navigate("login") { popUpTo(nav.graph.id) { inclusive = true } } }
    }, { logout = false }, destructive = true, busy = loggingOut)
    LaunchedEffect(loggingOut) { if (loggingOut) { kotlinx.coroutines.delay(15_000); if (loggingOut) { loggingOut = false; vm.error.value = context.getString(R.string.generic_error_something_went_wrong_try_again) } } }
}

@Composable private fun colorModeLabel(theme: String) = stringResource(when (theme) { "light" -> R.string.color_mode_setting_light; "dark" -> R.string.color_mode_setting_dark; else -> R.string.color_mode_setting_system })

/** Identity card: bg-000, 12 dp corners, hairline; name 15/550, the account line 13/400; the plan as a pill badge. */
@Composable private fun IdentityCard(vm: AppViewModel, accountName: String, plan: String?) {
    val c = Claude.colors
    val label = if (BuildConfig.DEMO_MODE) "name@example.com" else vm.api.session?.accountLabel.orEmpty()
    val name = if (BuildConfig.DEMO_MODE) stringResource(R.string.claudex_demo_account) else accountName.ifBlank { label }
    Surface(Modifier.fillMaxWidth().padding(horizontal = 12.dp), shape = Claude.shapes.r12, color = c.bg000, border = BorderStroke(1.dp, c.border300)) {
        Row(Modifier.padding(start = 12.dp, top = 16.dp, end = 16.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            ClaudeAvatar(name, AvatarSize.Large)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(name.ifBlank { stringResource(R.string.user_avatar_default_content_description) }, style = Claude.type.body15Strong, color = c.text100, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (label.isNotBlank() && label != name) { Spacer(Modifier.height(4.dp)); Text(label, style = Claude.type.body13, color = c.text500, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            plan?.let {
                Spacer(Modifier.width(8.dp))
                Text(it, Modifier.clip(CircleShape).background(c.text100).padding(horizontal = 8.dp, vertical = 6.5.dp), style = Claude.type.body11Strong.copy(fontSize = 10.sp),
                    color = c.bg100, maxLines = 1)
            }
        }
    }
}

/**
 * Profile: "What personal preferences should Claude consider in responses?", its description,
 * the preferences field and Save Preferences. Name fields and Delete Account are left out (the service has no
 * call for them).
 */
@Composable fun ProfileScreen(vm: AppViewModel, nav: NavHostController) {
    val saved by vm.instructions.collectAsStateWithLifecycle()
    var text by rememberSaveable(saved) { mutableStateOf(saved) }
    val c = Claude.colors
    OfficialPage(stringResource(R.string.title_profile), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.profile_conversation_preferences), style = Claude.type.body17, color = c.text100)
            Spacer(Modifier.height(2.dp))
            Text(stringResource(R.string.profile_conversation_preferences_description), style = Claude.type.body15, color = c.text500)
            Spacer(Modifier.height(4.dp))
            SettingsTextField(text, { text = it.take(20_000) }, Modifier.padding(top = 4.dp), placeholder = stringResource(R.string.profile_conversation_preferences_hint), singleLine = false, minLines = 4, maxLines = 6)
            Spacer(Modifier.height(16.dp))
            ClaudeButton(stringResource(R.string.profile_save_preferences_button), { vm.saveInstructions(text.trim()) }, size = ButtonSize.Large, fillWidth = true, enabled = text.trim() != saved.trim())
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** Billing for the Claudex balance: plan card (plan or pay-as-you-go, expiry, balance), transactions, and where to top up. */
@Composable fun BillingScreen(vm: AppViewModel, nav: NavHostController) {
    val billing = rememberBillingInfo(vm)
    val c = Claude.colors
    OfficialPage(stringResource(R.string.title_billing), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            Surface(Modifier.fillMaxWidth().padding(horizontal = 12.dp), shape = Claude.shapes.r12, color = c.bg000, border = BorderStroke(1.dp, c.border300)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(stringResource(R.string.billing_account_plan), style = Claude.type.body13, color = c.text500)
                    val plan = billing?.optString("plan")?.takeIf { it.isNotBlank() && it != "null" }
                    Text(plan ?: stringResource(if (billing == null && !BuildConfig.DEMO_MODE) R.string.usage_meter_row_loading else R.string.claudex_billing_pay_as_you_go), style = Claude.type.body17Strong, color = c.text100)
                    val expires = billing?.optLong("planExpiresAt") ?: 0L
                    if (plan != null && expires > 0) Text(stringResource(R.string.claudex_billing_plan_expires, DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(expires))), style = Claude.type.body15, color = c.text500)
                }
            }
            GroupGap()
            SettingsGroup {
                val balance = NativeDetailPolicy.balance(billing, null)
                SettingsValueRow(stringResource(R.string.usage_credits_current_balance), balance?.let(::usd) ?: stringResource(R.string.usage_amount_unknown), AppGlyphs.dollarSign)
                SettingsRow(stringResource(R.string.usage_credit_bundles_view_all), { nav.navigate("usage/transactions") }, AppGlyphs.history)
            }
            SettingsFootnote(stringResource(R.string.claudex_billing_no_purchases))
            Spacer(Modifier.height(24.dp))
        }
    }
}

/**
 * Usage: "Plan usage" meters with "N% used" and the reset time; "Credits" with the current balance
 * and "View all transactions"; "Learn more about usage limits" when the service names a page. Pull to refresh.
 */
@Composable fun UsageScreen(vm: AppViewModel, nav: NavHostController) {
    var plan by remember { mutableStateOf<JSONObject?>(null) }
    var billing by remember { mutableStateOf<JSONObject?>(null) }
    var failed by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    suspend fun read(fresh: Boolean) {
        val repo = vm.repository as? RemoteRepository ?: run { loading = false; return }
        try { plan = repo.rpc("planUsage", fresh) as? JSONObject; billing = repo.rpc("billingInfo") as? JSONObject; failed = false }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { if (plan == null) failed = true else vm.error.value = context.getString(R.string.usage_refresh_error) }
        finally { loading = false }
    }
    LaunchedEffect(Unit) { read(true) }
    val c = Claude.colors
    OfficialPage(stringResource(R.string.usage_title), onBack = { nav.popBackStack() }) {
        PullToRefreshBox(refreshing, onRefresh = { scope.launch { refreshing = true; read(true); refreshing = false } }, Modifier.weight(1f).fillMaxWidth()) {
            val windows = UsageWindowPresentation.visible(plan)
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Spacer(Modifier.height(12.dp))
                when {
                    loading -> LoadingState()
                    failed -> OfficialErrorState(stringResource(R.string.usage_load_error), { loading = true; scope.launch { read(true) } }, Modifier.padding(top = 48.dp))
                    else -> {
                        SettingsSectionHeader(stringResource(R.string.usage_plan_usage_header))
                        if (windows.isEmpty()) OfficialEmptyState(AppGlyphs.chartLine, stringResource(R.string.usage_no_data_available), Modifier.padding(vertical = 24.dp))
                        else SettingsGroup { windows.forEach { window -> UsageMeterRow(window.optString("label"), (window.optDouble("percent") / 100.0).toFloat(), usageCaption(window)) } }
                        GroupGap()
                        SettingsSectionHeader(stringResource(R.string.usage_credits_header))
                        SettingsGroup {
                            val balance = NativeDetailPolicy.balance(billing, plan)
                            SettingsValueRow(stringResource(R.string.usage_credits_current_balance), balance?.let(::usd) ?: stringResource(R.string.usage_amount_unknown))
                            SettingsRow(stringResource(R.string.usage_credit_bundles_view_all), { nav.navigate("usage/transactions") })
                        }
                        plan?.optString("learnMoreUrl")?.takeIf { it.startsWith("https://") }?.let { url ->
                            GroupGap()
                            SettingsGroup { SettingsRow(stringResource(R.string.usage_learn_more), { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }, AppGlyphs.arrowOutSquare) }
                        }
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

/** "32% used · Resets in 3 hr 20 min" (`usage_*`). */
@Composable private fun usageCaption(window: JSONObject): String {
    val percent = window.optDouble("percent").takeIf { it.isFinite() }?.toInt()?.coerceIn(0, 100) ?: 0
    val used = stringResource(R.string.usage_percent_used, percent)
    val resetsAt = window.optLong("resetsAt").takeIf { !window.isNull("resetsAt") && it > 0 }
    val reset = when {
        resetsAt == null -> if (!window.optBoolean("active", true)) stringResource(R.string.usage_starts_when_message_sent) else null
        else -> {
            val minutes = ((resetsAt - System.currentTimeMillis()) / 60_000).coerceAtLeast(0)
            when {
                minutes < 60 -> stringResource(R.string.usage_resets_in_minutes, minutes.toInt().coerceAtLeast(1))
                minutes < 24 * 60 -> stringResource(R.string.usage_resets_in_hours_minutes, (minutes / 60).toInt(), (minutes % 60).toInt())
                else -> stringResource(R.string.usage_resets_at, DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(resetsAt)))
            }
        }
    }
    return listOfNotNull(used, reset).joinToString(" · ")
}

/** Transactions: the service's orders, newest first, "+$amount" for balance top-ups; read only. */
@Composable fun TransactionsScreen(vm: AppViewModel, nav: NavHostController) {
    var items by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var page by remember { mutableIntStateOf(0) }
    var pages by remember { mutableIntStateOf(1) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun load() {
        val repo = vm.repository as? RemoteRepository ?: return
        if (loading) return
        loading = true
        scope.launch {
            try { val data = repo.rpc("billingOrders", page + 1) as JSONObject; items = items + data.optJSONArray("items")?.objects().orEmpty(); page += 1; pages = data.optInt("pages", 1); failed = false }
            catch (e: CancellationException) { throw e } catch (_: Exception) { failed = true } finally { loading = false }
        }
    }
    LaunchedEffect(Unit) { load() }
    val c = Claude.colors
    OfficialPage(stringResource(R.string.usage_transactions_title), onBack = { nav.popBackStack() }) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(vertical = 12.dp)) {
            if (items.isEmpty()) item {
                when {
                    vm.repository !is RemoteRepository -> OfficialEmptyState(AppGlyphs.history, stringResource(R.string.usage_transactions_empty), Modifier.padding(top = 48.dp))
                    loading -> LoadingState()
                    failed -> OfficialErrorState(stringResource(R.string.usage_transactions_load_error), ::load, Modifier.padding(top = 48.dp))
                    else -> OfficialEmptyState(AppGlyphs.history, stringResource(R.string.usage_transactions_empty), Modifier.padding(top = 48.dp))
                }
            }
            items(items, key = { "order:" + it.optLong("id") }) { order ->
                val created = order.optLong("createdAt")
                val date = if (created > 0) DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(created)) else null
                val title = if (order.optString("kind") == "subscription") stringResource(R.string.claudex_transaction_plan) else
                    date?.let { stringResource(R.string.usage_credit_bundle_purchase_title_dated, it) } ?: stringResource(R.string.usage_credit_bundle_purchase_title)
                val amount = order.optDouble("amount").takeIf { it.isFinite() } ?: order.optDouble("payAmount")
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 2.dp)) {
                    Row(Modifier.fillMaxWidth().clip(Claude.shapes.settingsRow).background(c.bg000).heightIn(min = 56.dp).padding(start = 12.dp, top = 8.dp, end = 16.dp, bottom = 8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(title, style = Claude.type.body17, color = c.text100, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(listOfNotNull(transactionStatus(order.optString("status")), order.optString("method").takeIf { it.isNotBlank() }).joinToString(" · "),
                                style = Claude.type.body15, color = c.text500, maxLines = 1)
                        }
                        Text(stringResource(R.string.usage_credit_bundle_amount_added, if (amount.isFinite()) String.format(Locale.ROOT, "%.2f %s", amount, order.optString("currency")).trim() else "—"),
                            style = Claude.type.body15Strong, color = c.text100)
                    }
                }
            }
            if (items.isNotEmpty() && page < pages) item {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    if (loading) ClaudeSpinner(SpinnerSize.Small) else if (failed) ClaudeButton(stringResource(R.string.chat_list_load_more_retry), ::load, variant = ButtonVariant.Borderless, size = ButtonSize.Small)
                    else ClaudeButton(stringResource(R.string.claudex_load_more), ::load, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
                }
            }
        }
    }
}

@Composable private fun transactionStatus(status: String): String = when (status.uppercase()) {
    "PENDING" -> stringResource(R.string.claudex_order_pending)
    "PAID", "RECHARGING" -> stringResource(R.string.claudex_order_processing)
    "COMPLETED" -> stringResource(R.string.claudex_order_completed)
    "EXPIRED", "CANCELLED" -> stringResource(R.string.claudex_order_cancelled)
    "FAILED" -> stringResource(R.string.claudex_order_failed)
    "REFUNDED" -> stringResource(R.string.claudex_order_refunded)
    else -> status
}

/**
 * Notifications: the official channel rows. Push is not wired in this app, so every switch is shown
 * off and disabled with the reason underneath (no control that pretends).
 */
@Composable fun NotificationSettingsScreen(vm: AppViewModel, nav: NavHostController) {
    OfficialPage(stringResource(R.string.notifications_section_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            SettingsGroup {
                SettingsSwitchRow(stringResource(R.string.chat_completion_notification_settings_title), false, {}, AppGlyphs.chats, helper = stringResource(R.string.chat_completion_notification_settings_description), enabled = false)
                SettingsSwitchRow(stringResource(R.string.scheduled_tasks_notification_title), false, {}, AppGlyphs.clock, helper = stringResource(R.string.scheduled_tasks_notification_description), enabled = false)
                SettingsSwitchRow(stringResource(R.string.code_notification_settings_title), false, {}, AppGlyphs.code, helper = stringResource(R.string.code_notification_settings_description), enabled = false)
            }
            SettingsFootnote(stringResource(R.string.claudex_notifications_unavailable))
        }
    }
}

/** Sharing: one row, Shared links. "Share from other apps" is left out (the app takes no shares). */
@Composable fun SharingScreen(vm: AppViewModel, nav: NavHostController) {
    OfficialPage(stringResource(R.string.sharing_settings_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f)) {
            Spacer(Modifier.height(12.dp))
            SettingsGroup { SettingsRow(stringResource(R.string.shared_links), { nav.navigate("settings/shared-links") }, AppGlyphs.linkSimple) }
        }
    }
}

/** Shared links: the account's hosted shares (`hostedShares`); tap = Copy link, Unshare asks first (`revokeShare`). */
@Composable fun SharedLinksScreen(vm: AppViewModel, nav: NavHostController) {
    var shares by remember { mutableStateOf<List<JSONObject>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var unsharing by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val repo = vm.repository as? RemoteRepository
    fun load() { if (repo == null) { shares = emptyList(); return }; failed = false; scope.launch {
        try { shares = (repo.rpc("hostedShares") as? JSONArray)?.objects().orEmpty().sortedByDescending { it.optLong("createdAt") } }
        catch (e: CancellationException) { throw e } catch (_: Exception) { failed = true }
    } }
    LaunchedEffect(Unit) { load() }
    val c = Claude.colors
    OfficialPage(stringResource(R.string.shared_links_section_title), onBack = { nav.popBackStack() }) {
        val list = shares
        when {
            failed && list == null -> OfficialErrorState(stringResource(R.string.generic_error_something_went_wrong), ::load, Modifier.weight(1f))
            list == null -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { ClaudeSpinner(SpinnerSize.Large) }
            list.isEmpty() -> Column(Modifier.weight(1f).fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Box(Modifier.size(48.dp).clip(CircleShape).background(c.bg300), contentAlignment = Alignment.Center) { Icon(AppGlyphs.linkSimple, null, Modifier.size(20.dp), tint = c.text500) }
                Spacer(Modifier.height(16.dp))
                Text(stringResource(R.string.shared_links_null_state_description), style = Claude.type.body17, color = c.text500, textAlign = TextAlign.Center)
            }
            else -> LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(vertical = 12.dp)) {
                items(list, key = { it.optString("id") }) { share ->
                    var menu by remember { mutableStateOf(false) }
                    Box {
                        OfficialListRow(share.optString("title").ifBlank { stringResource(R.string.generic_untitled) }, { menu = true },
                            subtitle = stringResource(R.string.shared_links_time_ago, relativeTime(share.optLong("createdAt"), capitalise = false)), startPadding = 12.dp,
                            leading = { Icon(if (share.optString("kind") == "artifact") AppGlyphs.artifacts else AppGlyphs.chat, null, Modifier.size(20.dp), tint = c.text500) },
                            enabled = share.optString("status") != "disabled")
                        ClaudeDropdownMenu(menu, { menu = false }) {
                            val url = share.optString("inviteUrl").takeIf { share.optString("access") == "invited" && it.isNotBlank() } ?: share.optString("url")
                            if (url.startsWith("http")) ClaudeMenuItem(stringResource(R.string.claudex_copy_link), { clipboard.setText(AnnotatedString(url)); menu = false }, AppGlyphs.link)
                            ClaudeMenuItem(stringResource(R.string.shared_links_unshare_button), { menu = false; unsharing = share }, AppGlyphs.x, destructive = true)
                        }
                    }
                }
            }
        }
    }
    unsharing?.let { share -> ClaudeDialog(stringResource(R.string.shared_links_unshare_dialog_title), stringResource(R.string.shared_links_unshare_dialog_description, share.optString("title")),
        stringResource(R.string.shared_links_unshare_button), {
            busy = true
            scope.launch {
                try { repo?.rpc("revokeShare", share.optString("id")); shares = shares?.filterNot { it.optString("id") == share.optString("id") } }
                catch (e: CancellationException) { throw e } catch (e: Exception) { vm.error.value = e.message ?: context.getString(R.string.generic_error_something_went_wrong) }
                finally { busy = false; unsharing = null }
            }
        }, { unsharing = null }, destructive = true, busy = busy) }
}

