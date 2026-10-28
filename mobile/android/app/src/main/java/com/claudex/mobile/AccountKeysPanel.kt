package com.claudex.mobile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import java.util.UUID

private class KeyClipboard(context: Context) {
    private val clipboard = context.applicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private val handler = Handler(Looper.getMainLooper())
    private val owner = UUID.randomUUID().toString()
    private val clear = Runnable { clearIfOwned() }
    fun copy(value: String) {
        val clip = ClipData.newPlainText("API key", value)
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true); putString("claudex.key.clip.owner", owner) }
        clipboard.setPrimaryClip(clip)
        handler.removeCallbacks(clear); handler.postDelayed(clear, 120_000)
    }
    fun clearIfOwned() {
        if (clipboard.primaryClipDescription?.extras?.getString("claudex.key.clip.owner") != owner) return
        if (android.os.Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
    }
}

@Composable internal fun AccountKeysPanel(vm: AppViewModel, groups: JSONObject?, rates: Map<Long, Double>) {
    val generation by vm.api.sessionChanges.collectAsStateWithLifecycle()
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    key(generation, signedIn) { AccountKeysForGeneration(vm, groups, rates, generation) }
}

@Composable private fun AccountKeysForGeneration(vm: AppViewModel, groups: JSONObject?, rates: Map<Long, Double>, generation: Long) {
    val service = remember(vm.api) { AccountKeyService(vm.api) }
    val work = rememberPanelWork()
    var keys by remember { mutableStateOf<List<AccountKey>?>(null) }
    var reveal by remember { mutableStateOf<Long?>(null) }
    var create by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var groupId by remember { mutableStateOf<Long?>(null) }
    var deleting by remember { mutableStateOf<AccountKey?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val clipboard = remember(context) { KeyClipboard(context) }
    val lifecycle = LocalLifecycleOwner.current
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    val allowed = !BuildConfig.DEMO_MODE && signedIn && generation == vm.api.sessionGeneration
    fun clearSensitive() { keys = null; reveal = null; deleting = null; create = false; name = ""; feedback = null }
    fun gesture(block: () -> Unit) {
        try { service.requireCurrent(generation); if (!allowed || !vm.signedIn.value) { clearSensitive(); return }; block(); if (generation != vm.api.sessionGeneration) { clearSensitive(); clipboard.clearIfOwned() } }
        catch (_: Exception) { clearSensitive(); feedback = UserText.get(R.string.claudex_key_account_changed) }
    }
    DisposableEffect(lifecycle, generation) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) clearSensitive() }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer); clearSensitive(); clipboard.clearIfOwned() }
    }
    fun read() { if (allowed) work.run(alert = false) {
        try {
            val rows = vm.api.withCurrentSession { service.list(generation) }
            service.requireCurrent(generation)
            if (lifecycle.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) keys = rows
        } catch (e: CancellationException) { throw e } catch (_: Exception) { clearSensitive(); error(UserText.get(R.string.generic_error_something_went_wrong_try_again)) }
    } }
    val choices = groups?.optJSONArray("groups")?.objects().orEmpty().filter { AccountKeyContract.id(it.opt("id")) != null }.take(200)
    val c = Claude.colors
    SettingsSectionHeader(stringResource(R.string.claudex_keys_title))
    SettingsGroup {
        SettingsRow(stringResource(if (keys == null) R.string.claudex_keys_show else R.string.claudex_keys_refresh), { reveal = null; read() }, AppGlyphs.key,
            subtitle = stringResource(R.string.claudex_keys_caption), enabled = allowed && !work.busy, subtitleMaxLines = 2)
        SettingsRow(stringResource(R.string.claudex_keys_create), { name = ""; groupId = choices.find { it.optBoolean("primary") }?.optLong("id") ?: choices.firstOrNull()?.optLong("id"); create = true },
            AppGlyphs.add, enabled = allowed && !work.busy && choices.isNotEmpty())
        keys.orEmpty().forEach { item ->
            var menu by remember { mutableStateOf(false) }
            Box {
                SettingsRow(item.name, { menu = true }, null,
                    subtitle = (if (reveal == item.id && allowed) item.secretForGesture() else item.masked) + "\n" + item.groupName.ifBlank { "—" } + " · " + AccountKeyContract.status(item.status) +
                        " · " + ApiGroupPresentation.rateText(rates[item.groupId]) + "\n" + stringResource(R.string.claudex_keys_created, item.createdAt?.let(NativeDetailPolicy::localTime) ?: "—") +
                        " · " + stringResource(R.string.claudex_keys_last_used, item.lastUsedAt?.let(NativeDetailPolicy::localTime) ?: "—"),
                    subtitleMaxLines = 4, enabled = allowed && !work.busy)
                ClaudeDropdownMenu(menu, { menu = false }) {
                    ClaudeMenuItem(stringResource(if (reveal == item.id) R.string.claudex_keys_hide else R.string.claudex_keys_reveal), { menu = false; gesture { reveal = if (reveal == item.id) null else item.id } }, if (reveal == item.id) AppGlyphs.eyeSlash else AppGlyphs.eye)
                    ClaudeMenuItem(stringResource(R.string.generic_copy), { menu = false; gesture { clipboard.copy(item.secretForGesture()); feedback = context.getString(R.string.claudex_keys_copied) } }, AppGlyphs.copy)
                    ClaudeMenuItem(stringResource(R.string.chat_menu_delete), { menu = false; reveal = null; deleting = item }, AppGlyphs.trash, destructive = true)
                }
            }
        }
    }
    if (!allowed) SettingsFootnote(stringResource(R.string.claudex_demo_unavailable))
    else if (keys?.isEmpty() == true) SettingsFootnote(stringResource(R.string.claudex_keys_none))
    feedback?.let { SettingsFootnote(it) }
    work.failure?.let { SettingsFootnote(it) }
    if (create) ClaudeAlertDialog(onDismissRequest = { if (!work.busy) create = false }, title = { Text(stringResource(R.string.claudex_keys_create)) }, text = {
        Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FieldLabel(stringResource(R.string.generic_name_label))
            SettingsTextField(name, { name = it.take(100) })
            AccountKeyContract.nameProblem(name)?.takeIf { name.isNotBlank() }?.let { Text(it, style = Claude.type.body13, color = c.dangerText) }
            choices.forEach { group ->
                val chosen = groupId == group.optLong("id")
                SheetActionRow(group.optString("name") + " · " + ApiGroupPresentation.rateText(rates[group.optLong("id")]), { groupId = group.optLong("id") }, enabled = !work.busy,
                    trailing = if (chosen) ({ Icon(AppGlyphs.check, null, Modifier.size(20.dp), tint = c.link) }) else null)
            }
        }
    }, dismissButton = { ClaudeButton(stringResource(R.string.generic_button_cancel), { create = false }, variant = ButtonVariant.Secondary, size = ButtonSize.Small, enabled = !work.busy) },
        confirmButton = { ClaudeButton(stringResource(R.string.claudex_keys_create), { work.run {
        try {
            val made = vm.api.withCurrentSession { service.create(name, groupId ?: error("group"), generation) }
            service.requireCurrent(generation)
            if (lifecycle.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) { keys = (listOf(made) + keys.orEmpty()).distinctBy { it.id }; feedback = context.getString(R.string.claudex_keys_created_toast) }
            create = false; name = ""; reveal = null
        } catch (e: CancellationException) { throw e } catch (_: Exception) { create = false; error(context.getString(R.string.claudex_keys_create_uncertain)) }
    } }, size = ButtonSize.Small, enabled = allowed && !work.busy && AccountKeyContract.nameProblem(name) == null && groupId != null, loading = work.busy) })
    deleting?.let { item -> ClaudeDialog(stringResource(R.string.claudex_keys_delete_title, item.name), stringResource(R.string.claudex_keys_delete_body), stringResource(R.string.chat_menu_delete), { work.run {
        try {
            vm.api.withCurrentSession { service.delete(item.id, generation) }
            service.requireCurrent(generation)
            keys = keys?.filterNot { it.id == item.id }; deleting = null; reveal = null; feedback = context.getString(R.string.claudex_keys_deleted_toast)
        } catch (e: CancellationException) { throw e } catch (_: Exception) { deleting = null; error(context.getString(R.string.claudex_keys_delete_uncertain)) }
    } }, { deleting = null }, destructive = true, busy = work.busy) }
    PanelFailureDialog(work)
}

/** Image-generation model (Claudex): one picker row; switching asks first. */
@Composable internal fun ImageModelSelector(vm: AppViewModel, groups: JSONObject?, changed: (JSONObject) -> Unit) {
    val generation by vm.api.sessionChanges.collectAsStateWithLifecycle()
    key(generation) {
        val work = rememberPanelWork()
        var picker by remember { mutableStateOf(false) }
        var pending by remember { mutableStateOf<JSONObject?>(null) }
        val choices = ImageModelPolicy.choices(groups)
        val selected = groups?.optJSONObject("images")?.optString("selected")
        val current = choices.find { it.optString("id") == selected }
        SettingsSectionHeader(stringResource(R.string.claudex_image_model_title))
        SettingsGroup {
            SettingsRow(stringResource(R.string.claudex_image_model_title), { picker = true }, AppGlyphs.image,
                subtitle = current?.let { it.optString("name").ifBlank { it.optString("id") } } ?: stringResource(R.string.claudex_image_model_none),
                enabled = !BuildConfig.DEMO_MODE && !work.busy && choices.isNotEmpty())
        }
        SettingsFootnote(stringResource(R.string.claudex_image_model_caption))
        if (picker) OfficialPickerDialog(stringResource(R.string.claudex_image_model_title), choices.map { PickerOption(it.optString("id"), it.optString("name").ifBlank { it.optString("id") }) }, selected,
            onSelect = { value -> picker = false; choices.find { it.optString("id") == value }?.takeIf { value != selected }?.let { pending = it } }, onDismiss = { picker = false })
        pending?.let { model -> ClaudeDialog(stringResource(R.string.claudex_image_model_switch_title), model.optString("name").ifBlank { model.optString("id") }, stringResource(R.string.claudex_api_switch_confirm), { work.run {
            val remote = vm.repository as? RemoteRepository ?: error("demo")
            val api = ManagementApi(remote)
            val result = vm.api.withCurrentSession {
                check(generation == vm.api.sessionGeneration) { "account changed" }
                ImageModelPolicy.requireOffered(api.apiGroups(), model.getString("id"))
                api.setImageModel(model.getString("id"))
            }
            check(generation == vm.api.sessionGeneration) { "account changed" }
            changed(result); pending = null
        } }, { pending = null }, busy = work.busy) }
        PanelFailureDialog(work)
    }
}
