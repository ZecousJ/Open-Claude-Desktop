package com.claudex.mobile

import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.claudex.core.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * A generated file's preview, after the official document preview sheet. Failures read as the
 * official `document_preview_*` lines; nothing else is offered (no share or open-with).
 */
@Composable fun GeneratedFileScreen(vm: AppViewModel, nav: NavHostController, conversationId: String, fileId: String) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val descriptor = remember(snapshot, conversationId, fileId) { vm.findGeneratedFile(conversationId, fileId) }
    var local by remember { mutableStateOf<File?>(null) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val safeName = GeneratedFilePolicy.exportName(descriptor?.name ?: "download")
    val mime = fileMime(descriptor)
    val saved = stringResource(R.string.download_saved_to_downloads)
    LaunchedEffect(descriptor) {
        local?.delete(); local = null; failed = false
        val source = descriptor ?: return@LaunchedEffect
        var temporary: File? = null
        loading = true
        try {
            val downloaded = vm.api.withCurrentSession {
            val bytes = vm.repository.readGeneratedFile(source)
            val directory = context.cacheDir.resolve("generated").apply { mkdirs() }
            val destination = File.createTempFile("snapshot-", ".cache", directory)
            temporary = destination
            withContext(Dispatchers.IO) { destination.writeBytes(bytes) }
            destination
            }
            local = downloaded; temporary = null
        } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { failed = true }
        finally { temporary?.delete(); loading = false }
    }
    DisposableEffect(Unit) { onDispose { local?.delete() } }
    LaunchedEffect(toast) { if (toast != null) { kotlinx.coroutines.delay(2500); toast = null } }
    // Before Android 10 there is no Downloads collection to write to without a permission: the system picker.
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mime)) { uri ->
        val file = local
        if (uri != null && file != null) vm.work {
            withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri, "wt")?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error(UserText.get(R.string.claudex_msg_save_failed)) }
            toast = saved
        }
    }
    val download: () -> Unit = {
        val file = local
        if (file != null) {
            if (android.os.Build.VERSION.SDK_INT >= 29) vm.work {
                withContext(Dispatchers.IO) { saveToDownloads(context, file, safeName, mime) }
                toast = saved
            } else export.launch(safeName)
        }
    }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ClaudeSheetHeader(descriptor?.name ?: safeName, onClose = { nav.popBackStack() })
            Box(Modifier.weight(1f).fillMaxWidth().padding(top = 12.dp).clipToBounds(), contentAlignment = Alignment.Center) {
                when {
                    descriptor == null -> PreviewLine(R.string.document_preview_not_found)
                    loading -> ClaudeSpinner()
                    failed -> PreviewLine(R.string.document_preview_load_failed)
                    else -> local?.let { file -> NativeGeneratedPreview(file, descriptor, mime, vm, nav, conversationId) }
                }
            }
            if (descriptor != null) ClaudeButton(stringResource(R.string.document_preview_bottom_sheet_download_button), download,
                Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 12.dp),
                size = ButtonSize.Large, enabled = local != null, fillWidth = true)
        }
        toast?.let { PillToast(it, Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp)) { toast = null } }
    }
}

/** One of the official `document_preview_*` lines, centred in the preview area. */
@Composable internal fun PreviewLine(text: Int) {
    Text(stringResource(text), Modifier.padding(horizontal = 24.dp), style = Claude.type.body15, color = Claude.colors.text300, textAlign = TextAlign.Center)
}

/** Writes [file] into the shared Downloads collection (Android 10+), as the official download does. */
internal fun saveToDownloads(context: android.content.Context, file: File, name: String, mime: String) {
    val values = android.content.ContentValues().apply {
        put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime)
        put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val resolver = context.contentResolver
    val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error(UserText.get(R.string.download_refused_storage_unavailable))
    try {
        resolver.openOutputStream(uri, "w")?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error(UserText.get(R.string.download_refused_storage_unavailable))
        values.clear(); values.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
    } catch (failure: Exception) { resolver.delete(uri, null, null); throw failure }
}

/** Pinch and double-tap zoom for the image preview. */
@Composable internal fun ZoomableImage(bitmap: Bitmap, description: String) {
    var scale by remember(bitmap) { mutableFloatStateOf(1f) }
    var offset by remember(bitmap) { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    var size by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
    fun clamp(o: androidx.compose.ui.geometry.Offset, s: Float): androidx.compose.ui.geometry.Offset {
        val maxX = size.width * (s - 1) / 2; val maxY = size.height * (s - 1) / 2
        return androidx.compose.ui.geometry.Offset(o.x.coerceIn(-maxX, maxX), o.y.coerceIn(-maxY, maxY))
    }
    Image(bitmap.asImageBitmap(), description, Modifier.fillMaxSize()
        .onSizeChanged { size = it }
        .pointerInput(bitmap) { detectTapGestures(onDoubleTap = { tap ->
            if (scale > 1f) { scale = 1f; offset = androidx.compose.ui.geometry.Offset.Zero }
            else { val s = 2.5f; scale = s; offset = clamp((androidx.compose.ui.geometry.Offset(size.width / 2f, size.height / 2f) - tap) * (s - 1), s) }
        }) }
        .pointerInput(bitmap) { detectTransformGestures { _, pan, zoom, _ ->
            val s = (scale * zoom).coerceIn(1f, 5f); scale = s; offset = if (s == 1f) androidx.compose.ui.geometry.Offset.Zero else clamp(offset + pan, s)
        } }
        .graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
        contentScale = ContentScale.Fit)
}

internal fun fileMime(file: GeneratedFile?): String {
    val known = when (file?.name?.substringAfterLast('.')?.lowercase()) {
        "pdf" -> "application/pdf"; "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "webp" -> "image/webp"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        "html", "htm" -> "text/html"; "svg" -> "image/svg+xml"; "js" -> "application/javascript"
        "md", "txt", "csv", "json", "kt", "swift", "py", "ts" -> "text/plain"
        else -> null
    }
    return known ?: file?.mime?.takeIf { it.matches(Regex("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")) } ?: "application/octet-stream"
}

@Composable private fun NativeGeneratedPreview(file: File, descriptor: GeneratedFile, mime: String, vm: AppViewModel, nav: NavHostController, conversationId: String) {
    var source by remember(file) { mutableStateOf(false) }
    var pages by remember(file) { mutableIntStateOf(0) }
    var bitmap by remember(file) { mutableStateOf<Bitmap?>(null) }
    var text by remember(file) { mutableStateOf<String?>(null) }
    var unavailable by remember(file) { mutableStateOf(false) }
    var pdfPages by remember(file) { mutableStateOf<List<Bitmap>>(emptyList()) }
    LaunchedEffect(file) {
        try {
            withContext(Dispatchers.IO) {
                when {
                    mime == "application/pdf" -> ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { handle -> PdfRenderer(handle).use { pdf ->
                        pages = pdf.pageCount; require(pages > 0)
                        pdfPages = (0 until minOf(pages, 50)).map { index -> pdf.openPage(index).use { p ->
                            val scale = minOf(2f, 1200f / p.width, 1800f / p.height)
                            val image = Bitmap.createBitmap((p.width * scale).toInt().coerceAtLeast(1), (p.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                            image.eraseColor(android.graphics.Color.WHITE); p.render(image, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); image
                        } }
                    } }
                    mime in listOf("image/png", "image/jpeg", "image/webp") -> bitmap = decodePreviewBitmap(file.readBytes())
                    CoworkPresentation.staticPreview(descriptor.name, mime, descriptor.language) || !descriptor.blob || mime.startsWith("text/") || mime in listOf("application/json", "application/javascript", "image/svg+xml") -> text = file.inputStream().use { String(it.take(128 * 1024), Charsets.UTF_8) } + if (file.length() > 128 * 1024) "\n\n[" + UserText.get(R.string.collapsed_tool_file_diff_truncated) + "]" else ""
                    else -> unavailable = true
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { unavailable = true }
    }
    bitmap?.let { ZoomableImage(it, descriptor.name) }
    if (pdfPages.isNotEmpty()) {
        val list = androidx.compose.foundation.lazy.rememberLazyListState()
        Box(Modifier.fillMaxSize()) {
            androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxSize(), list, contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(pdfPages.size) { i -> Image(pdfPages[i].asImageBitmap(), null, Modifier.fillMaxWidth(), contentScale = ContentScale.FillWidth) }
            }
            // The page pill takes the official image gallery's page indicator look.
            if (pages > 1) Text(stringResource(R.string.pdf_page_n_of_total, list.firstVisibleItemIndex + 1, pages),
                Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp).clip(CircleShape).background(Claude.colors.bg000.copy(alpha = .8f)).padding(horizontal = 8.dp, vertical = 2.dp),
                style = Claude.type.body13, color = Claude.colors.text100)
        }
    }
    text?.let { content ->
        val snapshot by vm.snapshot.collectAsStateWithLifecycle()
        val owner = snapshot.conversations.find { it.id == conversationId }
        val visual = CoworkPresentation.staticPreview(descriptor.name, mime, descriptor.language)
        Column(Modifier.fillMaxSize().padding(horizontal = 24.dp)) {
            // The same Preview / Code chips as the artifact page (Material's text buttons are not Claude controls).
            if (visual) Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ClaudeChip(stringResource(R.string.artifact_view_mode_preview), { source = false }, selected = !source, leadingIcon = AppGlyphs.eye, compact = true)
                ClaudeChip(stringResource(R.string.artifact_view_mode_code), { source = true }, selected = source, leadingIcon = AppGlyphs.code, compact = true)
            }
            if (visual && !source && file.length() <= 128 * 1024) SandboxedArtifact(content)
            else if (owner != null) SharedConversationView(vm, nav, owner, Modifier.fillMaxWidth().weight(1f), ConversationDocument(source = descriptor, content = content, language = if (descriptor.name.endsWith(".md", true)) "markdown" else descriptor.language.ifBlank { "text" }))
            else PreviewLine(R.string.document_preview_not_found)
        }
    }
    if (unavailable) PreviewLine(R.string.document_preview_bottom_sheet_unavailable)
}

private fun java.io.InputStream.take(limit: Int): ByteArray { val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192); while (out.size() < limit) { val count = read(buffer, 0, minOf(buffer.size, limit - out.size())); if (count < 0) break; out.write(buffer, 0, count) }; return out.toByteArray() }
