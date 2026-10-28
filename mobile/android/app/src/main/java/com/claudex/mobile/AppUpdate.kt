package com.claudex.mobile

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import java.io.File
import java.security.MessageDigest

/** An update step that failed for a reason the dialog names. */
class UpdateFailure(val reason: Int): Exception()

/** The Android release the service offers (GET /api/v1/claudex/apps → android). */
data class AppRelease(val version: String, val url: String, val sha256: String, val notes: String)

/** Pure rules of the in-app update: which release to offer and what it may be downloaded from. */
object AppUpdatePolicy {
    private val versionPattern = Regex("""\d{1,4}(\.\d{1,4}){0,3}""")
    private val sha256Pattern = Regex("[0-9a-f]{64}")

    /** Numeric version order ("0.10.0" > "0.9.3"); anything unparseable is never newer. */
    fun newer(candidate: String, current: String): Boolean {
        if (!versionPattern.matches(candidate)) return false
        val a = candidate.split('.').map { it.toInt() }
        val b = current.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }; val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /**
     * The release from the apps answer, or null: it must name a version, a 64-hex SHA-256, and an https APK on
     * this app's own service host (a release never points the app at another server).
     */
    fun release(apps: JSONObject, origin: String): AppRelease? {
        val android = (apps.optJSONObject("data") ?: apps).optJSONObject("android") ?: return null
        val version = android.optString("version")
        val url = android.optString("url")
        val sha = android.optString("sha256").lowercase()
        if (!versionPattern.matches(version) || !sha256Pattern.matches(sha)) return null
        val host = runCatching { java.net.URI(origin).host }.getOrNull() ?: return null
        val target = runCatching { java.net.URI(url) }.getOrNull() ?: return null
        if (target.scheme != "https" || target.host != host || target.userInfo != null || target.path?.endsWith(".apk") != true) return null
        return AppRelease(version, url, sha, android.optString("notes").trim().take(4000))
    }
}

/**
 * In-app update: checks the service for a newer APK, downloads it into the app's cache with progress, checks its
 * SHA-256, that it is this app signed with this app's key and that it is the version offered, then hands it to the
 * system installer (the person confirms; Android never lets a sideloaded app update itself silently). The first
 * time, Android asks to allow Claudex to install apps; the install continues when the person comes back.
 */
class AppUpdater(private val context: Context, private val api: NativeApi) {
    /** The release waiting for the person's answer (shown as the update dialog). */
    val offer = MutableStateFlow<AppRelease?>(null)
    /** Download progress 0..1 while downloading, null otherwise. */
    val progress = MutableStateFlow<Float?>(null)
    /** "Up to date" or "couldn't check" after a check the person asked for (a snackbar), as a string resource. */
    val message = MutableStateFlow<Int?>(null)
    /** Why the last download or install failed, shown in the dialog itself (a string resource, read in the UI's language). */
    val failure = MutableStateFlow<Int?>(null)
    private var dismissed: String? = null
    private var waitingForPermission: File? = null

    suspend fun check(asked: Boolean = false) {
        if (BuildConfig.DEMO_MODE) return
        val release = try {
            AppUpdatePolicy.release(api.request("/api/v1/claudex/apps", method = "GET"), api.origin)
        } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) {
            if (asked) message.value = R.string.claudex_update_check_failed
            return
        }
        if (release != null && AppUpdatePolicy.newer(release.version, BuildConfig.VERSION_NAME) && (asked || release.version != dismissed)) {
            offer.value = release
        } else if (asked) message.value = R.string.claudex_update_latest
    }

    fun later() { dismissed = offer.value?.version; offer.value = null; failure.value = null }

    suspend fun update(release: AppRelease) {
        if (progress.value != null) return
        failure.value = null
        progress.value = 0f
        try {
            val file = download(release)
            offer.value = null
            install(file)
        } catch (cancelled: CancellationException) { throw cancelled } catch (error: Exception) {
            failure.value = (error as? UpdateFailure)?.reason ?: R.string.claudex_update_failed
        } finally { progress.value = null }
    }

    /** Back from the "install unknown apps" setting: continue the install it was asked for. */
    fun resume() {
        val file = waitingForPermission ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) return
        waitingForPermission = null
        if (file.exists()) install(file)
    }

    private suspend fun download(release: AppRelease): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val part = File(dir, "Claudex-${release.version}.apk.part")
        val client: OkHttpClient = api.client.newBuilder().readTimeout(60, java.util.concurrent.TimeUnit.SECONDS).build()
        client.newCall(Request.Builder().url(release.url).header("User-Agent", "Claudex-Android/${BuildConfig.VERSION_NAME}").build()).execute().use { response ->
            check(response.isSuccessful) { "update failed" }
            val body = response.body ?: error("update failed")
            val total = body.contentLength().takeIf { it > 0 }
            check(total == null || total <= 300L * 1024 * 1024) { "update failed" }
            val digest = MessageDigest.getInstance("SHA-256")
            var read = 0L
            body.byteStream().use { input -> part.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer); if (count < 0) break
                    output.write(buffer, 0, count); digest.update(buffer, 0, count); read += count
                    check(read <= 300L * 1024 * 1024) { "update failed" }
                    if (total != null) progress.value = (read.toFloat() / total).coerceIn(0f, 1f)
                }
            } }
            val sha = digest.digest().joinToString("") { "%02x".format(it) }
            if (sha != release.sha256) { part.delete(); throw UpdateFailure(R.string.claudex_update_corrupt) }
        }
        val apk = File(dir, "Claudex-${release.version}.apk")
        check(part.renameTo(apk)) { "update failed" }
        checkPackage(apk, release)
        apk
    }

    /** The file must be this app, this release, signed with the key the installed app is signed with. */
    private fun checkPackage(apk: File, release: AppRelease) {
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(apk.path, flags)
        val installed = pm.getPackageInfo(context.packageName, flags)
        val ok = archive != null && archive.packageName == context.packageName && archive.versionName == release.version &&
            signers(archive).isNotEmpty() && signers(archive) == signers(installed)
        if (!ok) { apk.delete(); throw UpdateFailure(R.string.claudex_update_corrupt) }
    }

    private fun signers(info: PackageInfo): Set<String> {
        val certificates = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo?.apkContentsSigners?.toList().orEmpty()
            else @Suppress("DEPRECATION") info.signatures?.toList().orEmpty()
        return certificates.map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { b -> "%02x".format(b) } }.toSet()
    }

    private fun install(apk: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            waitingForPermission = apk
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.composer", apk)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

internal val LocalAppUpdater = androidx.compose.runtime.staticCompositionLocalOf<AppUpdater?> { null }

/** The update prompt: the version, its notes, Update and Later; while downloading, the progress in its place. */
@androidx.compose.runtime.Composable internal fun AppUpdateDialog(updater: AppUpdater) {
    val release by updater.offer.collectAsStateWithLifecycle()
    val progress by updater.progress.collectAsStateWithLifecycle()
    val failure by updater.failure.collectAsStateWithLifecycle()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val shown = release ?: return
    ClaudeAlertDialog(
        onDismissRequest = { if (progress == null) updater.later() },
        title = { androidx.compose.material3.Text(androidx.compose.ui.res.stringResource(R.string.claudex_update_title, shown.version)) },
        text = {
            androidx.compose.foundation.layout.Column(verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp)) {
                androidx.compose.material3.Text(shown.notes.ifBlank { androidx.compose.ui.res.stringResource(R.string.claudex_update_body) },
                    modifier = androidx.compose.ui.Modifier.heightIn(max = 280.dp).verticalScroll(androidx.compose.foundation.rememberScrollState()),
                    style = Claude.type.body15, color = Claude.colors.text300)
                failure?.let { reason -> androidx.compose.material3.Text(androidx.compose.ui.res.stringResource(reason), style = Claude.type.body13, color = Claude.colors.dangerText) }
                progress?.let { value ->
                    androidx.compose.material3.LinearProgressIndicator(progress = { value }, modifier = androidx.compose.ui.Modifier.fillMaxWidth(),
                        color = Claude.colors.text100, trackColor = Claude.colors.bg300)
                    androidx.compose.material3.Text(androidx.compose.ui.res.stringResource(R.string.claudex_update_downloading, (value * 100).toInt()),
                        style = Claude.type.body13, color = Claude.colors.text500)
                }
            }
        },
        confirmButton = {
            androidx.compose.material3.TextButton({ scope.launch { updater.update(shown) } }, enabled = progress == null) {
                androidx.compose.material3.Text(androidx.compose.ui.res.stringResource(R.string.claudex_update_now))
            }
        },
        dismissButton = if (progress == null) ({
            androidx.compose.material3.TextButton({ updater.later() }) { androidx.compose.material3.Text(androidx.compose.ui.res.stringResource(R.string.claudex_update_later)) }
        }) else null,
    )
}
