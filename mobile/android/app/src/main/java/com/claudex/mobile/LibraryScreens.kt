@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.ui.res.stringResource

import androidx.compose.ui.draw.clipToBounds

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import com.claudex.core.Artifact
import com.claudex.core.ArtifactComment
import com.claudex.core.ArtifactProjectFile
import com.claudex.core.ArtifactVersions
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream

/**
 * The artifact viewer sheet: close and the
 * artifact's name, a Preview (eye) / Code toggle, the options menu: Copy, Copy to project, Print, Publish, Save as
 * <type>, Share as <type>, the version footer when the file was written more
 * than once, and the official comment mode. Pinning and duplicating stay on the gallery's long-press menu; failures read
 * as the official `artifact_*` lines.
 */
@Composable fun ArtifactScreen(vm: AppViewModel, nav: NavHostController, id: String, conversationId: String? = null) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val latest = if (conversationId == null) snapshot.artifacts.find { it.id == id }
        else snapshot.conversations.find { it.id == conversationId }?.let { ConversationBridgePolicy.fenceArtifact(it, id) } ?: snapshot.artifacts.find { it.id == id && it.originConversationId == conversationId }
    val owner = latest?.originConversationId?.let { origin -> snapshot.conversations.find { it.id == origin } }
    // Versions: one per write of the file on the chat's current branch (as the web's switcher); the last is the latest.
    val versions = remember(owner?.turns, latest?.generatedFile?.path) { ArtifactVersions.of(owner?.turns.orEmpty(), latest?.generatedFile?.path.orEmpty()) }
    var picked by rememberSaveable(id) { mutableStateOf<Int?>(null) }
    val versioned = latest != null && latest.generatedFile?.blob != true && versions.size > 1
    val index = if (versioned) (picked ?: versions.lastIndex).coerceIn(0, versions.lastIndex) else 0
    val artifact = if (latest != null && versioned && index != versions.lastIndex) versions[index].let { v ->
        latest.copy(content = v.content.orEmpty(), language = v.language.ifBlank { latest.language }, generatedFile = v) } else latest
    val repo = vm.repository as? RemoteRepository
    var menu by remember { mutableStateOf(false) }; var publish by remember { mutableStateOf(false) }; var hostedUrl by remember { mutableStateOf<String?>(null) }
    var source by rememberSaveable { mutableStateOf(false) }; var toast by remember { mutableStateOf<String?>(null) }
    var commenting by rememberSaveable(id) { mutableStateOf(false) }; var selection by remember { mutableStateOf<String?>(null) }; var commentText by rememberSaveable { mutableStateOf("") }
    val clipboard = LocalClipboardManager.current; val context = LocalContext.current; val c = Claude.colors
    val copiedText = stringResource(R.string.generic_copied_toast); val exportFailed = stringResource(R.string.artifact_export_failed); val printFailed = stringResource(R.string.artifact_print_failed)
    val copiedToProject = stringResource(R.string.artifact_copy_to_project_success); val copyToProjectFailed = stringResource(R.string.artifact_copy_to_project_failed)
    val commentSent = stringResource(R.string.artifact_comment_sent_title)
    val printView = remember { arrayOfNulls<WebView>(1) }
    DisposableEffect(Unit) { onDispose { printView[0]?.destroy(); printView[0] = null } }
    LaunchedEffect(toast) { if (toast != null) { kotlinx.coroutines.delay(2500); toast = null } }
    val kind = artifact?.let { ArtifactFile.of(it) }
    val projectId = owner?.projectId
    val projectFile = artifact?.let { ArtifactProjectFile.name(it.name, it.generatedFile?.name, it.language, it.generatedFile?.blob == true) }
    val canComment = repo != null && owner != null && artifact != null && artifact.generatedFile?.blob != true
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(kind?.mime ?: "application/octet-stream")) { uri ->
        if (uri != null && artifact != null) vm.work {
            try { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(artifact.content.toByteArray()) } ?: error("export") }; toast = context.getString(R.string.download_saved_to_downloads) }
            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled } catch (_: Exception) { toast = exportFailed }
        }
    }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ClaudeSheetHeader(artifact?.name?.ifBlank { null } ?: stringResource(R.string.artifact_default_title), onClose = { nav.popBackStack() }, trailing = {
                if (artifact != null && kind != null) Box {
                    ClaudeIconButton(AppGlyphs.dotsVertical, stringResource(R.string.generic_button_more_options), { menu = true })
                    ClaudeDropdownMenu(menu, { menu = false }) {
                        ClaudeMenuItem(stringResource(R.string.artifact_sheet_menu_copy), { menu = false; clipboard.setText(AnnotatedString(artifact.content)); toast = copiedText }, AppGlyphs.copy)
                        // Copy to project: the shown version, as a text file, in the project of this artifact's chat.
                        if (repo != null && projectId != null && projectFile != null) ClaudeMenuItem(stringResource(R.string.artifact_sheet_menu_copy_to_project), { menu = false
                            vm.work {
                                try {
                                    val data = repo.uploadReference(projectFile, "text/plain", artifact.content.toByteArray())
                                    repo.rpc("addProjectKnowledgeFiles", projectId, org.json.JSONArray(listOf(org.json.JSONObject().put("name", projectFile).put("data", data))))
                                    toast = copiedToProject
                                } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled } catch (_: Exception) { toast = copyToProjectFailed }
                            } }, AppGlyphs.projects)
                        ClaudeMenuItem(stringResource(R.string.artifact_sheet_menu_print), { menu = false
                            try { printView[0]?.destroy(); printView[0] = ArtifactFile.print(context, artifact, kind) { toast = printFailed } } catch (_: Exception) { toast = printFailed } }, AppGlyphs.printer)
                        ClaudeMenuItem(stringResource(R.string.artifact_sheet_menu_publish), { menu = false; publish = true }, AppGlyphs.share, enabled = !BuildConfig.DEMO_MODE)
                        ClaudeMenuItem(stringResource(R.string.artifact_sheet_menu_save_as, kind.label), { menu = false; export.launch(kind.fileName(artifact.name)) }, AppGlyphs.download)
                        ClaudeMenuItem(stringResource(R.string.artifact_sheet_menu_share_as, kind.label), { menu = false
                            vm.work {
                                try {
                                    val uri = withContext(Dispatchers.IO) {
                                        val folder = java.io.File(context.cacheDir, "share").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
                                        val file = java.io.File(folder, com.claudex.core.GeneratedFilePolicy.exportName(kind.fileName(artifact.name))).apply { writeText(artifact.content) }
                                        androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.composer", file)
                                    }
                                    context.startActivity(android.content.Intent.createChooser(android.content.Intent(android.content.Intent.ACTION_SEND).setType(kind.mime)
                                        .putExtra(android.content.Intent.EXTRA_STREAM, uri).putExtra(android.content.Intent.EXTRA_SUBJECT, artifact.name)
                                        .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION), null))
                                } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled } catch (_: Exception) { toast = exportFailed }
                            } }, AppGlyphs.upload)
                    }
                }
            })
            if (artifact == null) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.artifact_load_error), Modifier.padding(horizontal = 24.dp), style = Claude.type.body15, color = c.text300, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            } else {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ClaudeChip(stringResource(R.string.artifact_view_mode_preview), { source = false; commenting = false }, selected = !source && !commenting, leadingIcon = AppGlyphs.eye, compact = true)
                    ClaudeChip(stringResource(R.string.artifact_view_mode_code), { source = true; commenting = false }, selected = source && !commenting, leadingIcon = AppGlyphs.code, compact = true)
                    Spacer(Modifier.weight(1f))
                    // Comment / Done commenting (ccr_artifact_viewer_comments_*): select text, then Comment.
                    if (canComment) ClaudeChip(stringResource(if (commenting) R.string.ccr_artifact_viewer_comments_exit else R.string.ccr_artifact_viewer_comments_enter),
                        { commenting = !commenting }, selected = commenting, leadingIcon = AppGlyphs.chatAdd, compact = true)
                }
                Box(Modifier.weight(1f).fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = if (versioned) 0.dp else 16.dp).clip(Claude.shapes.r12).background(c.bg000)
                    .border(1.dp, c.border300, Claude.shapes.r12)) {
                    if (commenting) CommentableArtifactText(artifact.content, { selected -> commentText = ""; selection = selected }, Modifier.fillMaxSize())
                    else if (!source && artifact.language in listOf("html", "svg")) SandboxedArtifact(artifact.content) else {
                        val shared = owner ?: com.claudex.core.Conversation("artifact:${artifact.id}", artifact.name, providerId = "", model = "")
                        SharedConversationView(vm, nav, shared, Modifier.fillMaxSize(), ConversationDocument(artifact = artifact, content = artifact.content, language = if (source && artifact.language in setOf("markdown", "md")) "text" else artifact.language.ifBlank { "text" }))
                    }
                }
                // Version footer: "Version %1$s of %2$s", Previous / Next (arrow icons), padding
                // h16 v4.
                if (versioned) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.artifact_sheet_footer_count, index + 1, versions.size), Modifier.weight(1f), style = Claude.type.body13, color = c.text300)
                    ClaudeIconButton(AppGlyphs.arrowLeft, stringResource(R.string.artifact_sheet_footer_previous), { picked = index - 1 }, enabled = index > 0, tint = c.text100)
                    Spacer(Modifier.width(4.dp))
                    ClaudeIconButton(AppGlyphs.arrowRight, stringResource(R.string.artifact_sheet_footer_next), { picked = index + 1 }, enabled = index < versions.lastIndex, tint = c.text100)
                }
            }
        }
        toast?.let { PillToast(it, Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp)) { toast = null } }
    }
    selection?.let { quoted -> TextInputDialog(stringResource(R.string.claudex_artifact_comment_title), commentText, { commentText = it }, stringResource(R.string.claudex_artifact_comment_send),
        { val chat = owner; val shown = artifact
            if (chat != null && shown != null) {
                vm.sendArtifactComment(chat.id, ArtifactComment.prompt(shown.name, commentText, quoted, shown.generatedFile?.path, shown.generatedFile?.digest, shown.content)) { selection = null; commentText = ""; toast = commentSent }
            } }, { selection = null },
        description = quoted.lines().joinToString("\n") { "> $it" }.take(400), placeholder = stringResource(R.string.claudex_artifact_comment_hint), singleLine = false, minLines = 3, busy = vm.busy.collectAsStateWithLifecycle().value, enabled = commentText.isNotBlank()) }
    if (publish && artifact != null) ClaudeDialog(stringResource(R.string.artifact_share_sheet_title), stringResource(R.string.claudex_artifact_publish_body), stringResource(R.string.artifact_sheet_menu_publish),
        { publish = false; vm.work { val repo = vm.repository as RemoteRepository; val status = repo.rpc("sharingStatus") as? org.json.JSONObject; require(status?.optBoolean("artifacts") == true) { UserText.get(R.string.claudex_msg_sharing_off) }
            val share = repo.rpc("publishArtifact", org.json.JSONObject().put("identity", artifact.identity).put("title", artifact.name).put("language", artifact.language).put("content", artifact.content)) as org.json.JSONObject; hostedUrl = share.getString("url") } }, { publish = false })
    hostedUrl?.let { url -> ClaudeDialog(stringResource(R.string.claudex_artifact_published), url, stringResource(R.string.generic_copy), { clipboard.setText(AnnotatedString(url)); hostedUrl = null; toast = copiedText }, { hostedUrl = null }) }
}

/** What an artifact saves, prints and is called as: "Save as HTML" and the file's type, extension and print page. */
internal class ArtifactFile(val label: String, val extension: String, val mime: String, private val html: Boolean) {
    fun fileName(name: String): String = name.trim().ifBlank { "artifact" }.let { if (it.endsWith(".$extension", true)) it else "$it.$extension" }
    companion object {
        fun of(artifact: Artifact): ArtifactFile = when (artifact.language.lowercase()) {
            "html" -> ArtifactFile("HTML", "html", "text/html", true)
            "svg" -> ArtifactFile("SVG", "svg", "image/svg+xml", true)
            "markdown", "md" -> ArtifactFile("Markdown", "md", "text/markdown", false)
            "" -> ArtifactFile("Text", "txt", "text/plain", false)
            else -> ArtifactFile(artifact.language.replaceFirstChar { it.uppercase() }, artifact.language.lowercase().take(8), "text/plain", false)
        }
        private fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        /** Prints through the system print dialog with a script-free, network-free WebView (the preview's sandbox). */
        @Suppress("SetJavaScriptEnabled")
        fun print(context: android.content.Context, artifact: Artifact, kind: ArtifactFile, failed: () -> Unit): WebView {
            val view = WebView(context)
            view.settings.apply { javaScriptEnabled = false; allowFileAccess = false; allowContentAccess = false; blockNetworkLoads = true; domStorageEnabled = false }
            view.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                override fun onPageFinished(view: WebView, url: String?) {
                    val manager = context.getSystemService(android.content.Context.PRINT_SERVICE) as? android.print.PrintManager
                    if (manager == null) failed() else manager.print(artifact.name.ifBlank { "artifact" }, view.createPrintDocumentAdapter(artifact.name.ifBlank { "artifact" }), null)
                }
            }
            val page = if (kind.html) "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">${artifact.content}"
                else "<pre style=\"white-space:pre-wrap;font-family:monospace;font-size:12px\">${escape(artifact.content)}</pre>"
            view.loadDataWithBaseURL(null, page, "text/html", "UTF-8", null)
            return view
        }
    }
}
@Suppress("SetJavaScriptEnabled")
@Composable fun SandboxedArtifact(content: String) {
    AndroidView(factory = { context -> WebView(context).apply {
        settings.javaScriptEnabled = false; settings.allowFileAccess = false; settings.allowContentAccess = false; settings.domStorageEnabled = false; settings.databaseEnabled = false; settings.blockNetworkLoads = true; settings.setSupportMultipleWindows(false)
        webViewClient = object: WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse = WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }
    } }, update = { view -> view.loadDataWithBaseURL(null, "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'\">$content", "text/html", "UTF-8", null) }, onRelease = { it.stopLoading(); it.destroy() }, modifier = Modifier.fillMaxSize())
}
/** An attachment's preview: the official document preview sheet, as for generated files (GeneratedFileScreen.kt). */
@Composable fun AttachmentScreen(vm: AppViewModel, nav: NavHostController, id: String) {
    val attachment = vm.findAttachment(id); val file = vm.localFile(id)
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }; var text by remember { mutableStateOf<String?>(null) }
    var pdfPages by remember { mutableStateOf<List<Bitmap>>(emptyList()) }; var unavailable by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }
    val saved = stringResource(R.string.download_saved_to_downloads)
    LaunchedEffect(id) {
        try {
            withContext(Dispatchers.IO) {
                if (file == null || attachment == null) return@withContext
                when {
                    attachment.mime == "application/pdf" || attachment.name.endsWith(".pdf", true) -> ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor -> PdfRenderer(descriptor).use { renderer ->
                        pdfPages = (0 until minOf(renderer.pageCount, 50)).map { index -> renderer.openPage(index).use { documentPage -> val scale = minOf(2f, 1200f / documentPage.width, 1800f / documentPage.height); val image = Bitmap.createBitmap((documentPage.width * scale).toInt().coerceAtLeast(1), (documentPage.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888); image.eraseColor(android.graphics.Color.WHITE); documentPage.render(image, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); image } }
                    } }
                    attachment.mime.startsWith("image/") || attachment.name.substringAfterLast('.').lowercase() in listOf("png", "jpg", "jpeg", "webp", "gif", "bmp") -> { val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeFile(file.absolutePath, options); var sample = 1; while (options.outWidth / sample > 1600 || options.outHeight / sample > 1600) sample *= 2; bitmap = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample }) ?: error("undecodable") }
                    attachment.mime.startsWith("text/") || attachment.name.substringAfterLast('.').lowercase() in listOf("md", "json", "csv", "txt", "kt", "swift", "js", "ts") -> { text = file.inputStream().use { String(readBounded(it, 128 * 1024)) } }
                    else -> unavailable = true
                }
            }
        } catch (_: Exception) { unavailable = true }
    }
    LaunchedEffect(toast) { if (toast != null) { kotlinx.coroutines.delay(2500); toast = null } }
    val context = LocalContext.current
    val mime = attachment?.mime ?: "application/octet-stream"
    val name = attachment?.name ?: "attachment"
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mime)) { uri -> if (uri != null && file != null) vm.work { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } } ?: error(UserText.get(R.string.claudex_msg_save_failed)) }; toast = saved } }
    val download: () -> Unit = { if (file != null) { if (android.os.Build.VERSION.SDK_INT >= 29) vm.work { withContext(Dispatchers.IO) { saveToDownloads(context, file, name, mime) }; toast = saved } else export.launch(name) } }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ClaudeSheetHeader(name, onClose = { nav.popBackStack() })
            Box(Modifier.weight(1f).fillMaxWidth().padding(top = 12.dp).clipToBounds(), contentAlignment = Alignment.Center) {
                when {
                    file == null || attachment == null -> PreviewLine(R.string.document_preview_not_found)
                    bitmap != null -> ZoomableImage(bitmap!!, name)
                    pdfPages.isNotEmpty() -> androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(pdfPages.size) { i -> Image(pdfPages[i].asImageBitmap(), null, Modifier.fillMaxWidth(), contentScale = ContentScale.FillWidth) }
                    }
                    text != null -> SelectionContainer { Text(text!!, Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp), fontFamily = FontFamily.Monospace, style = Claude.type.body13, color = Claude.colors.text100) }
                    unavailable -> PreviewLine(R.string.document_preview_bottom_sheet_unavailable)
                    else -> ClaudeSpinner()
                }
            }
            if (file != null) ClaudeButton(stringResource(R.string.document_preview_bottom_sheet_download_button), download,
                Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 12.dp), size = ButtonSize.Large, fillWidth = true)
        }
        toast?.let { PillToast(it, Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp)) { toast = null } }
    }
}

private fun readBounded(input: java.io.InputStream, limit: Int): ByteArray { val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192); while (output.size() < limit) { val count = input.read(buffer, 0, minOf(buffer.size, limit - output.size())); if (count < 0) break; output.write(buffer, 0, count) }; return output.toByteArray() }
