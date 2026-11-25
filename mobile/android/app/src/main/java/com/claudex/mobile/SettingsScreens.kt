@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
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
import androidx.compose.material3.TextButton
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
 * Settings root (settings.md §3): identity card, then the official groups and row component —
 * 1 Profile, Billing, Usage, API; 2 Capabilities, Connectors (knowledge bases); 3 Color mode;
 * 4 Notifications, Service status, Sharing; 5 Log out. The ⓘ menu holds the version (tap copies it).
 */
@Composable fun SettingsScreen(vm: AppViewModel, nav: NavHostController) {
    val theme by vm.theme.collectAsStateWithLifecycle()
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val bases by vm.knowledgeBases.collectAsStateWithLifecycle()
    val billing = rememberBillingInfo(vm)
    var colorMode by remember { mutableStateOf(false) }
    var fontStyleOpen by remember { mutableStateOf(false) }
    var logout by remember { mutableStateOf(false) }
    var loggingOut by remember { mutableStateOf(false) }
    var learnMore by remember { mutableStateOf(false) }
    val updateScope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val canHaptic = remember(context) { context.getSystemService(android.os.Vibrator::class.java)?.hasVibrator() == true }
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    var permissionResume by remember { mutableIntStateOf(0) }
    DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) permissionResume += 1
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val permissionsEnabled = remember(permissionResume) {
        fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        val location = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)
        val calendar = granted(Manifest.permission.READ_CALENDAR) || granted(Manifest.permission.WRITE_CALENDAR)
        (if (location) 1 else 0) + (if (calendar) 1 else 0)
    }
    val tick = featureTick(vm)
    var memoryPrefs by remember { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(tick, permissionResume) {
        val api = (vm.repository as? RemoteRepository)?.let(::ManagementApi) ?: return@LaunchedEffect
        memoryPrefs = try { api.memoryStatus()?.optJSONObject("prefs") } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { memoryPrefs }
    }
    val capabilitiesEnabled = (if (memoryPrefs?.optBoolean("searchChats") == true) 1 else 0) +
        (if (memoryPrefs?.optBoolean("generate") == true) 1 else 0) +
        (if (vm.aiArtifacts()) 1 else 0) + (if (vm.inlineVisualizations()) 1 else 0)
    LaunchedEffect(Unit) { vm.loadKnowledgeBases() }
    val versionText = stringResource(R.string.version_info_prefix, "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
    OfficialPage(stringResource(R.string.title_settings), onBack = { nav.popBackStack() }, actions = {
        Box {
            ClaudeIconButton(Anthropicons.infoCircle, stringResource(R.string.learn_more_menu_icon_content_description), { learnMore = true }, tint = Claude.colors.text300)
            ClaudeDropdownMenu(learnMore, { learnMore = false }) {
                Text(versionText, Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(Claude.shapes.menuItem)
                    .padding(12.dp), style = Claude.type.body13, color = Claude.colors.text500, textAlign = TextAlign.End)
                ClaudeMenuItem(stringResource(R.string.generic_copy_content_description), {
                    clipboard.setText(AnnotatedString(versionText)); learnMore = false
                }, Anthropicons.copy)
                LocalAppUpdater.current?.let { updater ->
                    ClaudeMenuItem(stringResource(R.string.claudex_update_check), {
                        learnMore = false; updateScope.launch { updater.check(asked = true) }
                    }, Anthropicons.download)
                }
            }
        }
    }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            IdentityCard(vm, snapshot.accountName, billing?.optString("plan")?.takeIf { it.isNotBlank() && it != "null" })
            Spacer(Modifier.height(12.dp))
            SettingsGroup {
                SettingsRow(stringResource(R.string.title_profile), { nav.navigate("settings/profile") }, Anthropicons.userCircle)
                SettingsRow(stringResource(R.string.title_billing), { nav.navigate("settings/billing") }, Anthropicons.dollarSign)
                SettingsRow(stringResource(R.string.usage_title), { nav.navigate("usage") }, Anthropicons.chartLine)
                SettingsRow(stringResource(R.string.claudex_api_title), { nav.navigate("api-groups") }, Anthropicons.key)
            }
            GroupGap()
            SettingsGroup {
                SettingsRow(stringResource(R.string.capabilities_setting_title), { nav.navigate("memory") }, Anthropicons.filter,
                    subtitle = capabilitiesEnabled.takeIf { it > 0 }?.let { pluralStringResource(R.plurals.capabilities_enabled_count, it, it) })
                SettingsRow(stringResource(R.string.connectors_setting_title), { nav.navigate("settings/connectors") }, Anthropicons.connector,
                    subtitle = bases.count { it.available }.takeIf { it > 0 }?.let { pluralStringResource(R.plurals.connectors_connected_count, it, it) })
                SettingsRow(stringResource(R.string.permissions_setting_title), { nav.navigate("settings/permissions") }, Anthropicons.toggles,
                    subtitle = permissionsEnabled.takeIf { it > 0 }?.let { pluralStringResource(R.plurals.permissions_enabled_count, it, it) })
                SettingsRow(stringResource(R.string.accessibility_setting_title), { nav.navigate("settings/accessibility") }, Anthropicons.accessibility)
            }
            GroupGap()
            SettingsGroup {
                SettingsRow(stringResource(R.string.color_mode_setting_title), { colorMode = true }, Anthropicons.moon, subtitle = colorModeLabel(theme))
                SettingsRow(stringResource(R.string.font_style_setting_title), { fontStyleOpen = true }, Anthropicons.textAa,
                    subtitle = stringResource(if (vm.fontStyle == "system") R.string.font_style_system else R.string.font_style_default))
            }
            GroupGap()
            SettingsGroup {
                if (canHaptic) SettingsSwitchRow(stringResource(R.string.haptic_feedback_title), vm.hapticFeedback, vm::updateHapticFeedback, Anthropicons.haptics)
                SettingsRow(stringResource(R.string.notifications_section_title), { nav.navigate("settings/notifications") }, Anthropicons.notification)
                SettingsRow(stringResource(R.string.claudex_status_title), { nav.navigate("status") }, Anthropicons.activity)
                SettingsRow(stringResource(R.string.privacy_title), { nav.navigate("settings/privacy") }, Anthropicons.lockShield)
                SettingsRow(stringResource(R.string.sharing_settings_title), { nav.navigate("settings/sharing") }, Anthropicons.share)
            }
            GroupGap()
            SettingsGroup {
                if (BuildConfig.DEMO_MODE && BuildConfig.DEBUG) SettingsRow(stringResource(R.string.claudex_demo_fail_next), vm::demoFailNext, Anthropicons.experiment)
                if (signedIn && !BuildConfig.DEMO_MODE) SettingsRow(stringResource(R.string.title_logout), { logout = true }, Anthropicons.logout, titleColor = Claude.colors.dangerText)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    if (colorMode) OfficialPickerDialog(stringResource(R.string.color_mode_setting_title), listOf(
        PickerOption("system", stringResource(R.string.color_mode_setting_system), Anthropicons.mobilePhone),
        PickerOption("light", stringResource(R.string.color_mode_setting_light), Anthropicons.sun),
        PickerOption("dark", stringResource(R.string.color_mode_setting_dark), Anthropicons.moon)), theme,
        onSelect = { vm.setTheme(it); colorMode = false }, onDismiss = { colorMode = false })
    if (fontStyleOpen) OfficialPickerDialog(stringResource(R.string.font_style_setting_title), listOf(
        PickerOption("default", stringResource(R.string.font_style_default), Anthropicons.textAa),
        PickerOption("system", stringResource(R.string.font_style_system), Anthropicons.mobilePhone)), vm.fontStyle,
        onSelect = { vm.updateFontStyle(it); fontStyleOpen = false }, onDismiss = { fontStyleOpen = false })
    if (logout) ClaudeDialog(stringResource(R.string.title_logout), stringResource(R.string.body_logout), stringResource(R.string.button_logout), {
        loggingOut = true
        vm.logout { loggingOut = false; logout = false; nav.navigate("login") { popUpTo(nav.graph.id) { inclusive = true } } }
    }, { logout = false }, destructive = true, busy = loggingOut)
    LaunchedEffect(loggingOut) { if (loggingOut) { kotlinx.coroutines.delay(15_000); if (loggingOut) { loggingOut = false; vm.error.value = context.getString(R.string.generic_error_something_went_wrong_try_again) } } }
}

@Composable private fun colorModeLabel(theme: String) = stringResource(when (theme) { "light" -> R.string.color_mode_setting_light; "dark" -> R.string.color_mode_setting_dark; else -> R.string.color_mode_setting_system })

/** Identity card (`ubk.e` → `wnp.a`): bg-000, 12 dp corners, hairline; name 15/550, the account line 13/400; the plan as a pill badge. */
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
 * Profile (settings.md §4): "What personal preferences should Claude consider in responses?", its description,
 * the preferences field and Save Preferences. Name fields and Delete Account are left out (the service has no
 * call for them).
 */
@Composable fun ProfileScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val saved = snapshot.instructions
    val displaySaved = WireCodec.rawSettings?.optString("name").orEmpty()
    val fullSaved = snapshot.accountName
    val photo = WireCodec.rawSettings?.optString("avatarPhoto")?.takeIf(ProfilePhotoPolicy::accepts)
    var text by rememberSaveable(saved) { mutableStateOf(saved) }
    var displayName by rememberSaveable(displaySaved) { mutableStateOf(displaySaved) }
    var fullName by rememberSaveable(fullSaved) { mutableStateOf(fullSaved) }
    var savingAccount by remember { mutableStateOf(false) }
    var savingPhoto by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf(false) }
    var deleteStep by remember { mutableIntStateOf(0) }
    var deleting by remember { mutableStateOf(false) }
    var deleteBlocked by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var cameraFile by remember { mutableStateOf<Uri?>(null) }
    fun use(uri: Uri?) {
        if (uri == null || savingPhoto) return
        savingPhoto = true
        scope.launch {
            val url = withContext(Dispatchers.IO) {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes() }?.let(ProfilePhotoPolicy::encode)
            }
            if (url == null) { vm.error.value = context.getString(R.string.profile_photo_error_invalid_image); savingPhoto = false }
            else vm.saveProfilePhoto(url) { savingPhoto = false }
        }
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { savedPhoto -> use(cameraFile?.takeIf { savedPhoto }) }
    val library = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { use(it) }
    val hasCamera = remember(context) { context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
    val c = Claude.colors
    OfficialPage(stringResource(R.string.title_profile), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(24.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                val bitmap = remember(photo) {
                    photo?.substringAfter(',')?.let { payload ->
                        runCatching { Base64.decode(payload, Base64.DEFAULT) }.getOrNull()?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }
                    }
                }
                if (bitmap != null) Image(bitmap, stringResource(R.string.profile_photo_avatar_content_description), Modifier.size(72.dp).clip(CircleShape))
                else Box(Modifier.size(72.dp).clip(CircleShape).background(c.bg300), contentAlignment = Alignment.Center) {
                    Icon(Anthropicons.user, stringResource(R.string.profile_photo_avatar_content_description), tint = c.text500)
                }
                ClaudeButton(stringResource(R.string.profile_photo_edit_button), { sheet = true }, variant = ButtonVariant.Secondary, enabled = !savingPhoto)
            }
            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.profile_full_name), style = Claude.type.body17, color = c.text100)
            SettingsTextField(fullName, { fullName = it.take(100) }, Modifier.padding(top = 4.dp), enabled = !savingAccount)
            Spacer(Modifier.height(16.dp))
            Text(stringResource(R.string.profile_display_name), style = Claude.type.body17, color = c.text100)
            SettingsTextField(displayName, { displayName = it.take(100) }, Modifier.padding(top = 4.dp), enabled = !savingAccount)
            Spacer(Modifier.height(16.dp))
            ClaudeButton(stringResource(R.string.profile_update_button), {
                savingAccount = true
                vm.saveAccountProfile(displayName, fullName) { saved ->
                    savingAccount = false
                    if (saved) vm.error.value = context.getString(R.string.profile_snackbar_account_info_updated)
                }
            }, size = ButtonSize.Large, fillWidth = true, enabled = !savingAccount && (displayName.trim() != displaySaved.trim() || fullName.trim() != fullSaved.trim()))
            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.profile_conversation_preferences), style = Claude.type.body17, color = c.text100)
            Spacer(Modifier.height(2.dp))
            Text(stringResource(R.string.profile_conversation_preferences_description), style = Claude.type.body15, color = c.text500)
            Spacer(Modifier.height(4.dp))
            SettingsTextField(text, { text = it.take(20_000) }, Modifier.padding(top = 4.dp), placeholder = stringResource(R.string.profile_conversation_preferences_hint), singleLine = false, minLines = 4, maxLines = 6)
            Spacer(Modifier.height(16.dp))
            ClaudeButton(stringResource(R.string.profile_save_preferences_button), { vm.saveInstructions(text.trim()) }, size = ButtonSize.Large, fillWidth = true, enabled = text.trim() != saved.trim())
            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.profile_account_actions), style = Claude.type.body17, color = c.text100)
            Spacer(Modifier.height(8.dp))
            SettingsGroup {
                SettingsRow(stringResource(R.string.profile_delete_account), { if (!deleting) deleteStep = 1 }, Anthropicons.trash, titleColor = c.danger100, enabled = !deleting && !BuildConfig.DEMO_MODE)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    if (sheet) ClaudeModalBottomSheet({ sheet = false }) {
        ClaudeSheetHeader(stringResource(R.string.profile_photo_sheet_title))
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            SettingsGroup {
                SettingsRow(stringResource(R.string.profile_photo_take_photo), {
                    sheet = false
                    runCatching {
                        val folder = File(context.cacheDir, "camera").apply { mkdirs() }
                        val stamp = java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.ROOT).format(java.util.Date())
                        val uri = FileProvider.getUriForFile(context, "${context.packageName}.composer", File(folder, "IMG_$stamp.jpg"))
                        cameraFile = uri
                        camera.launch(uri)
                    }.onFailure { vm.error.value = it.message }
                }, Anthropicons.camera, enabled = hasCamera && !savingPhoto)
                SettingsRow(stringResource(R.string.profile_photo_view_library), {
                    sheet = false
                    library.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }, Anthropicons.image, enabled = !savingPhoto)
                if (photo != null) SettingsRow(stringResource(R.string.profile_photo_remove), { sheet = false; removing = true }, Anthropicons.trash)
            }
        }
    }
    if (removing) ClaudeDialog(stringResource(R.string.profile_photo_remove_dialog_title), stringResource(R.string.profile_photo_remove_dialog_body), stringResource(R.string.profile_photo_remove_dialog_confirm), {
        removing = false
        savingPhoto = true
        vm.saveProfilePhoto(null) { savingPhoto = false }
    }, { removing = false }, destructive = true)
    if (deleteStep == 1) ClaudeDialog(stringResource(R.string.delete_account_dialog_title), stringResource(R.string.delete_account_dialog_understand_text), stringResource(R.string.delete_account_dialog_understand_button), { deleteStep = 2 }, { deleteStep = 0 })
    if (deleteStep == 2) ClaudeDialog(stringResource(R.string.delete_account_dialog_confirm_text), null, stringResource(R.string.delete_account_dialog_confirm_button), {
        deleting = true
        vm.deleteAccount { outcome ->
            deleting = false
            deleteStep = 0
            if (outcome == "deleted") nav.navigate("login") { popUpTo(nav.graph.id) { inclusive = true } }
            else if (outcome == "unavailable") deleteBlocked = true
        }
    }, { if (!deleting) deleteStep = 0 }, destructive = true, busy = deleting)
    if (deleteBlocked) ClaudeDialog(stringResource(R.string.delete_account_dialog_title), stringResource(R.string.delete_account_dialog_cannot_delete), stringResource(R.string.generic_button_done), { deleteBlocked = false }, { deleteBlocked = false })
}

/** Billing (`tww`, §5.1) for the Claudex balance: plan card (plan or pay-as-you-go, expiry, balance), transactions, and where to top up. */
@Composable fun BillingScreen(vm: AppViewModel, nav: NavHostController) {
    val loaded = rememberBillingInfo(vm)
    var refreshed by remember { mutableStateOf<JSONObject?>(null) }
    val billing = refreshed ?: loaded
    var spend by remember { mutableStateOf<BillingPolicy.Spend?>(null) }
    var editing by remember { mutableStateOf(false) }
    var amountText by remember { mutableStateOf("") }
    var savingLimit by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    var redeeming by remember { mutableStateOf(false) }
    var redeemNote by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var checkout by remember { mutableStateOf<BillingPolicy.Checkout?>(null) }
    var funding by remember { mutableStateOf(false) }
    var fundAmount by remember { mutableStateOf("") }
    var fundMethod by remember { mutableStateOf<String?>(null) }
    var paying by remember { mutableStateOf(false) }
    var payNote by remember { mutableStateOf<String?>(null) }
    var qrCode by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    LaunchedEffect(Unit) { spend = vm.readSpendLimit(); checkout = vm.loadCheckout() }
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
                SettingsValueRow(stringResource(R.string.usage_credits_current_balance), balance?.let(::usd) ?: stringResource(R.string.usage_amount_unknown), Anthropicons.dollarSign)
                if (checkout?.balance == true) SettingsRow(stringResource(R.string.billing_add_funds), { funding = true }, Anthropicons.dollarSign)
                spend?.let { current ->
                    val line = if (current.limitUsd == null) stringResource(R.string.spend_limit_line_none, BillingPolicy.money(current.usedUsd))
                        else stringResource(R.string.spend_limit_line_capped, BillingPolicy.money(current.usedUsd), BillingPolicy.money(current.limitUsd, whole = true))
                    SettingsRow(stringResource(R.string.spend_limit_title), {
                        amountText = current.limitUsd?.let { BillingPolicy.money(it, whole = true).removePrefix("$") } ?: "2000"
                        editing = true
                    }, subtitle = line)
                }
                SettingsRow(stringResource(R.string.usage_credit_bundles_view_all), { nav.navigate("usage/transactions") }, Anthropicons.history)
            }
            if (billing?.optBoolean("redeem", true) != false && !BuildConfig.DEMO_MODE) {
                GroupGap()
                SettingsSectionHeader(stringResource(R.string.billing_redeem_title))
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ClaudeTextField(code, { code = it }, placeholder = stringResource(R.string.billing_redeem_placeholder), enabled = !redeeming,
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(autoCorrectEnabled = false))
                    ClaudeButton(stringResource(R.string.billing_redeem_button), {
                        if (!redeeming) {
                            redeeming = true
                            redeemNote = null
                            scope.launch {
                                try {
                                    redeemNote = redeemResult(context, vm.redeemCode(code)) to false
                                    code = ""
                                    refreshed = runCatching { (vm.repository as? RemoteRepository)?.rpc("billingInfo") as? JSONObject }.getOrNull()
                                } catch (cancelled: CancellationException) { throw cancelled }
                                catch (error: com.claudex.core.ApiException) { redeemNote = redeemFailure(context, error.code) to true }
                                catch (_: Exception) { redeemNote = context.getString(R.string.billing_redeem_failed) to true }
                                finally { redeeming = false }
                            }
                        }
                    }, enabled = code.isNotBlank() && !redeeming, loading = redeeming, fillWidth = true)
                    redeemNote?.let { (text, failed) -> Text(text, style = Claude.type.body15, color = if (failed) c.danger100 else c.text500) }
                }
            }
            if (checkout?.balance != true) SettingsFootnote(stringResource(R.string.claudex_billing_no_purchases))
            Spacer(Modifier.height(24.dp))
        }
    }
    val offer = checkout?.takeIf { it.balance && funding }
    if (offer != null) {
        val chosen = offer.methods.firstOrNull { it.id == fundMethod } ?: offer.methods.first()
        val amount = BillingPolicy.parseAmount(fundAmount)
        val problem = BillingPolicy.amountProblem(amount, chosen, offer.min, offer.max)
        val bound = if (problem == "low") maxOf(chosen.min, offer.min) else listOf(chosen.max, offer.max).filter { it > 0 }.minOrNull()
        ClaudeModalBottomSheet(onDismissRequest = { if (!paying) funding = false }) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.billing_add_funds), style = Claude.type.body17Strong, color = c.text100)
                ClaudeTextField(fundAmount, { fundAmount = it }, placeholder = stringResource(R.string.spend_limit_amount), enabled = !paying,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal))
                offer.methods.forEach { method ->
                    SettingsRow(payMethodName(method.id), { fundMethod = method.id }, titleColor = if (method.id == chosen.id) c.text100 else c.text500)
                }
                Text(when (problem) {
                    "low" -> stringResource(R.string.billing_amount_low, BillingPolicy.money(bound ?: 0.0, whole = true))
                    "high" -> stringResource(R.string.billing_amount_high, BillingPolicy.money(bound ?: 0.0, whole = true))
                    "empty" -> stringResource(R.string.billing_amount_empty)
                    else -> ""
                }, style = Claude.type.body13, color = if (problem == null) c.text500 else c.danger100)
                payNote?.let { Text(payFailure(it), style = Claude.type.body15, color = c.danger100) }
                qrCode?.let { Text(it, style = Claude.type.body15, color = c.text100) }
                ClaudeButton(stringResource(R.string.billing_pay), {
                    val next = amount ?: return@ClaudeButton
                    paying = true
                    payNote = null
                    scope.launch {
                        val result = vm.startTopUp(chosen.id, next)
                        paying = false
                        when (result) {
                            is BillingPolicy.TopUp.Browser -> {
                                funding = false
                                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(result.url))) }
                                vm.error.value = context.getString(R.string.billing_pay_waiting)
                                val status = vm.followPayment(result.orderId)
                                if (status == "COMPLETED") { refreshed = runCatching { (vm.repository as? RemoteRepository)?.rpc("billingInfo") as? JSONObject }.getOrNull(); vm.error.value = context.getString(R.string.billing_pay_completed) }
                            }
                            is BillingPolicy.TopUp.Qr -> qrCode = result.code
                            is BillingPolicy.TopUp.Failed -> payNote = result.reason
                        }
                    }
                }, enabled = problem == null && !paying, loading = paying, fillWidth = true)
            }
        }
    }
    if (editing) {
        val amount = BillingPolicy.parseAmount(amountText)
        val help = when {
            amountText.isBlank() -> stringResource(R.string.spend_limit_enter)
            amount == null -> stringResource(R.string.spend_limit_enter_example)
            amount == 0.0 -> stringResource(R.string.spend_limit_zero)
            else -> stringResource(R.string.spend_limit_immediate)
        }
        ClaudeModalBottomSheet(onDismissRequest = { if (!savingLimit) editing = false }) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.spend_limit_set_title), style = Claude.type.body17Strong, color = c.text100)
                Text(stringResource(R.string.spend_limit_set_body), style = Claude.type.body15, color = c.text500)
                ClaudeTextField(amountText, { amountText = it }, placeholder = stringResource(R.string.spend_limit_amount), enabled = !savingLimit,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal))
                Text(help, style = Claude.type.body13, color = if (amount == null || amount == 0.0) c.danger100 else c.text500)
                ClaudeButton(stringResource(R.string.spend_limit_unlimited), {
                    savingLimit = true
                    scope.launch {
                        try { spend = vm.saveSpendLimit(null); editing = false }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { vm.error.value = context.getString(R.string.spend_limit_save_error) }
                        finally { savingLimit = false }
                    }
                }, enabled = !savingLimit, fillWidth = true, variant = ButtonVariant.Secondary)
                ClaudeButton(stringResource(R.string.spend_limit_save), {
                    val next = amount ?: return@ClaudeButton
                    savingLimit = true
                    scope.launch {
                        try { spend = vm.saveSpendLimit(next); editing = false }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { vm.error.value = context.getString(R.string.spend_limit_save_error) }
                        finally { savingLimit = false }
                    }
                }, enabled = amount != null && !savingLimit, loading = savingLimit, fillWidth = true)
            }
        }
    }
}

private fun redeemResult(context: android.content.Context, redeemed: BillingPolicy.Redeemed): String = when (redeemed.type) {
    "balance" -> context.getString(R.string.billing_redeem_balance, BillingPolicy.money(redeemed.value))
    "subscription" -> if (redeemed.days > 0) context.getString(R.string.billing_redeem_plan, redeemed.plan.ifBlank { context.getString(R.string.claudex_billing_pay_as_you_go) }, redeemed.days)
        else context.getString(R.string.billing_redeem_plan_open, redeemed.plan.ifBlank { context.getString(R.string.claudex_billing_pay_as_you_go) })
    "concurrency" -> context.getString(R.string.billing_redeem_concurrency, redeemed.value.toInt())
    else -> context.getString(R.string.billing_redeem_done)
}

@Composable private fun payMethodName(id: String): String = stringResource(when (id) {
    "alipay" -> R.string.billing_method_alipay
    "wxpay" -> R.string.billing_method_wxpay
    "stripe" -> R.string.billing_method_stripe
    "airwallex" -> R.string.billing_method_airwallex
    else -> R.string.billing_pay
})

@Composable private fun payFailure(reason: String): String = stringResource(when (reason) {
    "wechat" -> R.string.billing_pay_wechat
    "desktop" -> R.string.billing_pay_desktop
    "insecure" -> R.string.billing_pay_insecure
    else -> R.string.billing_pay_unknown
})

private fun redeemFailure(context: android.content.Context, code: String): String = when (BillingPolicy.redeemProblem(code)) {
    "missing" -> context.getString(R.string.billing_redeem_missing)
    "used" -> context.getString(R.string.billing_redeem_used)
    "expired" -> context.getString(R.string.billing_redeem_expired)
    "locked" -> context.getString(R.string.billing_redeem_locked)
    "limited" -> context.getString(R.string.billing_redeem_limited)
    else -> context.getString(R.string.billing_redeem_failed)
}

/**
 * Usage (`a2v`, §3.9): "Plan usage" meters with "N% used" and the reset time; "Credits" with the current balance
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
                        if (windows.isEmpty()) OfficialEmptyState(Anthropicons.chartLine, stringResource(R.string.usage_no_data_available), Modifier.padding(vertical = 24.dp))
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
                            SettingsGroup { SettingsRow(stringResource(R.string.usage_learn_more), { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }, Anthropicons.arrowOutSquare) }
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

/** Transactions (`qfx`): the service's orders, newest first, "+$amount" for balance top-ups; read only. */
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
                    vm.repository !is RemoteRepository -> OfficialEmptyState(Anthropicons.history, stringResource(R.string.usage_transactions_empty), Modifier.padding(top = 48.dp))
                    loading -> LoadingState()
                    failed -> OfficialErrorState(stringResource(R.string.usage_transactions_load_error), ::load, Modifier.padding(top = 48.dp))
                    else -> OfficialEmptyState(Anthropicons.history, stringResource(R.string.usage_transactions_empty), Modifier.padding(top = 48.dp))
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
                        Column(horizontalAlignment = Alignment.End) {
                            Text(stringResource(R.string.usage_credit_bundle_amount_added, if (amount.isFinite()) String.format(Locale.ROOT, "%.2f %s", amount, order.optString("currency")).trim() else "—"),
                                style = Claude.type.body15Strong, color = c.text100)
                            if (order.optString("status").equals("PENDING", true)) TextButton({
                                scope.launch {
                                    if (vm.cancelPayment(order.optLong("id"))) { items = emptyList(); page = 0; pages = 1; load() }
                                }
                            }) { Text(stringResource(R.string.billing_order_cancel), color = c.danger100) }
                        }
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
 * Notifications (`qww`, §5.6). Replies can notify when one finishes in the background.
 * A tool approval can be allowed once or declined from its notification. A scheduled task notifies when this app next hears that its run finished or failed. Code session updates stay off.
 */
@Composable fun NotificationSettingsScreen(vm: AppViewModel, nav: NavHostController) {
    val replies by vm.replyNotifications.collectAsStateWithLifecycle()
    val ask = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { }
    OfficialPage(stringResource(R.string.notifications_section_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            SettingsGroup {
                SettingsSwitchRow(stringResource(R.string.chat_completion_notification_settings_title), replies, { value ->
                    vm.setReplyNotifications(value)
                    if (value && android.os.Build.VERSION.SDK_INT >= 33) ask.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                }, Anthropicons.chats, helper = stringResource(R.string.chat_completion_notification_settings_description))
                val snapshot by vm.snapshot.collectAsStateWithLifecycle()
                val schedules = remember(snapshot) { vm.notifySchedules() }
                var savingSchedules by remember { mutableStateOf(false) }
                SettingsSwitchRow(stringResource(R.string.scheduled_tasks_notification_title), schedules, { value ->
                    savingSchedules = true
                    vm.setNotifySchedules(value) { savingSchedules = false }
                    if (value && android.os.Build.VERSION.SDK_INT >= 33) ask.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                }, Anthropicons.clock, helper = stringResource(R.string.scheduled_tasks_notification_description), enabled = !savingSchedules)
            }
        }
    }
}

/**
 * Privacy: where this service keeps chats, then the account switch for error reports and reply feedback.
 * The switch stays off until the account turns it on, and the choice is saved with the rest of the account settings.
 */
@Composable fun PrivacySettingsScreen(vm: AppViewModel, nav: NavHostController) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    var saving by remember { mutableStateOf(false) }
    var exporting by remember { mutableStateOf(false) }
    val accepted = remember(snapshot) { vm.helpImproveClaudex() }
    val context = LocalContext.current
    OfficialPage(stringResource(R.string.privacy_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Column(Modifier.padding(horizontal = 24.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.privacy_data_privacy_section_title), style = Claude.type.body17Strong, color = Claude.colors.text100)
                Text(stringResource(R.string.claudex_privacy_p1), style = Claude.type.body17Long, color = Claude.colors.text100)
                Text(stringResource(R.string.claudex_privacy_p2), style = Claude.type.body17Long, color = Claude.colors.text100)
            }
            Spacer(Modifier.height(8.dp))
            SettingsGroup {
                SettingsSwitchRow(stringResource(R.string.claudex_help_improve_title), accepted, { value ->
                    if (!saving) {
                        saving = true
                        vm.setHelpImproveClaudex(value) { saving = false }
                    }
                }, Anthropicons.feedback, helper = stringResource(R.string.claudex_help_improve_description), enabled = signedIn && !saving)
                SettingsRow(stringResource(R.string.claudex_export_data), {
                    if (!exporting) {
                        exporting = true
                        vm.exportData { file ->
                            exporting = false
                            if (file != null) {
                                val uri = FileProvider.getUriForFile(context, "${context.packageName}.composer", file)
                                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("application/zip").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null))
                            }
                        }
                    }
                }, Anthropicons.download, enabled = signedIn && !exporting && !BuildConfig.DEMO_MODE)
            }
        }
    }
}

/** Sharing: shares from other apps can open a new chat, and the account's hosted links can be revoked. */
@Composable fun SharingScreen(vm: AppViewModel, nav: NavHostController) {
    OfficialPage(stringResource(R.string.sharing_settings_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            SettingsSectionHeader(stringResource(R.string.share_from_other_apps))
            SettingsGroup {
                SettingsSwitchRow(stringResource(R.string.share_always_new_chat), vm.shareDefaultsToNewChat, vm::updateShareDefaultsToNewChat, Anthropicons.share)
            }
            GroupGap()
            SettingsGroup { SettingsRow(stringResource(R.string.shared_links), { nav.navigate("settings/shared-links") }, Anthropicons.linkSimple) }
        }
    }
}

/** Shared links (`fuw`, §5.10): the account's hosted shares (`hostedShares`); tap = Copy link, Unshare asks first (`revokeShare`). */
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
                Box(Modifier.size(48.dp).clip(CircleShape).background(c.bg300), contentAlignment = Alignment.Center) { Icon(Anthropicons.linkSimple, null, Modifier.size(20.dp), tint = c.text500) }
                Spacer(Modifier.height(16.dp))
                Text(stringResource(R.string.shared_links_null_state_description), style = Claude.type.body17, color = c.text500, textAlign = TextAlign.Center)
            }
            else -> LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(vertical = 12.dp)) {
                items(list, key = { it.optString("id") }) { share ->
                    var menu by remember { mutableStateOf(false) }
                    Box {
                        OfficialListRow(share.optString("title").ifBlank { stringResource(R.string.generic_untitled) }, { menu = true },
                            subtitle = stringResource(R.string.shared_links_time_ago, relativeTime(share.optLong("createdAt"), capitalise = false)), startPadding = 12.dp,
                            leading = { Icon(if (share.optString("kind") == "artifact") Anthropicons.artifacts else Anthropicons.chat, null, Modifier.size(20.dp), tint = c.text500) },
                            enabled = share.optString("status") != "disabled")
                        ClaudeDropdownMenu(menu, { menu = false }) {
                            val url = share.optString("inviteUrl").takeIf { share.optString("access") == "invited" && it.isNotBlank() } ?: share.optString("url")
                            if (url.startsWith("http")) ClaudeMenuItem(stringResource(R.string.claudex_copy_link), { clipboard.setText(AnnotatedString(url)); menu = false }, Anthropicons.link)
                            ClaudeMenuItem(stringResource(R.string.shared_links_unshare_button), { menu = false; unsharing = share }, Anthropicons.x, destructive = true)
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

/**
 * Connectors (`yex`, §5.4) for the service's knowledge bases: one row per base with its description; a base the
 * service cannot reach right now is shown disabled with "Unavailable". They are turned on per chat in the + menu.
 */
@Composable fun ConnectorsScreen(vm: AppViewModel, nav: NavHostController) {
    val bases by vm.knowledgeBases.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.loadKnowledgeBases() }
    OfficialPage(stringResource(R.string.connectors_setting_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            if (bases.isEmpty()) OfficialEmptyState(Anthropicons.connector, stringResource(R.string.claudex_knowledge_empty), Modifier.padding(top = 48.dp))
            else {
                SettingsSectionHeader(stringResource(R.string.claudex_knowledge_bases))
                SettingsGroup {
                    bases.forEach { base ->
                        SettingsRow(base.name, {}, Anthropicons.knowledge, subtitle = if (base.available) base.description.ifBlank { null } else stringResource(R.string.claudex_knowledge_unavailable),
                            enabled = base.available, subtitleMaxLines = 3)
                    }
                }
                SettingsFootnote(stringResource(R.string.claudex_knowledge_footnote))
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** Location and calendar permission, using the system dialog. A refusal is not treated as access. */
@Composable fun PermissionsScreen(nav: NavHostController) {
    val context = LocalContext.current
    val activity = context as? Activity
    fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    fun locationGranted() = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)
    fun calendarGranted() = granted(Manifest.permission.READ_CALENDAR)
    var locationOn by remember { mutableStateOf(locationGranted()) }
    var calendarOn by remember { mutableStateOf(calendarGranted()) }
    var locationBlocked by remember { mutableStateOf(false) }
    var calendarBlocked by remember { mutableStateOf(false) }
    val locationRequest = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        locationOn = locationGranted()
        locationBlocked = !locationOn && activity?.let { ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.ACCESS_FINE_LOCATION) } != true
    }
    val calendarRequest = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        calendarOn = calendarGranted()
        calendarBlocked = !calendarOn && activity?.let { ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.READ_CALENDAR) } != true
    }
    fun settings() {
        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
    }
    OfficialPage(stringResource(R.string.permissions_setting_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            SettingsGroup {
                SettingsRow(stringResource(R.string.permission_location_title), {
                    if (locationOn) return@SettingsRow
                    if (locationBlocked) settings() else locationRequest.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                }, Anthropicons.location, subtitle = stringResource(if (locationBlocked && !locationOn) R.string.permission_location_system_disabled else R.string.permission_location_description), subtitleMaxLines = 4)
                SettingsRow(stringResource(R.string.permission_calendar_title), {
                    if (calendarOn) return@SettingsRow
                    if (calendarBlocked) settings() else calendarRequest.launch(arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR))
                }, Anthropicons.calendar, subtitle = stringResource(if (calendarBlocked && !calendarOn) R.string.permission_calendar_system_disabled else R.string.permission_calendar_description), subtitleMaxLines = 4)
            }
        }
    }
}

/** Accessibility keeps one switch: popup messages close themselves, or stay until dismissed. */
@Composable fun AccessibilityScreen(vm: AppViewModel, nav: NavHostController) {
    OfficialPage(stringResource(R.string.accessibility_setting_title), onBack = { nav.popBackStack() }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(12.dp))
            SettingsGroup {
                SettingsSwitchRow(stringResource(R.string.popup_auto_dismiss_title), vm.popupAutoDismiss, vm::updatePopupAutoDismiss,
                    helper = stringResource(R.string.popup_auto_dismiss_description))
            }
        }
    }
}
