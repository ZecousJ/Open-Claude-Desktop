package com.claudex.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONTokener
import java.io.ByteArrayInputStream

/** The menu id the official app gives its selection "Comment" item. */
private const val COMMENT_ITEM = 12598855

/**
 * Comment mode's text: the artifact's text on a plain page, where a selection offers "Comment" beside the system's
 * items. The page is the
 * text escaped inside a `<pre>`, so scripts in an artifact never run here; JavaScript is on only for the app's own
 * read of the selection.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable fun CommentableArtifactText(content: String, onComment: (String) -> Unit, modifier: Modifier = Modifier) {
    val text = Claude.colors.text100; val background = Claude.colors.bg000
    val page = remember(content, text, background) { commentPage(content, text, background) }
    AndroidView(factory = { context -> CommentWebView(context).apply {
        settings.javaScriptEnabled = true; settings.allowFileAccess = false; settings.allowContentAccess = false; settings.domStorageEnabled = false
        settings.databaseEnabled = false; settings.blockNetworkLoads = true; settings.setSupportMultipleWindows(false)
        setBackgroundColor(background.toArgb())
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse = WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }
    } }, update = { view -> view.onComment = onComment; if (view.tag != page) { view.tag = page; view.loadDataWithBaseURL(null, page, "text/html", "UTF-8", null) } },
        onRelease = { it.stopLoading(); it.destroy() }, modifier = modifier)
}

private fun commentPage(content: String, text: Color, background: Color): String {
    fun css(color: Color) = "#%06x".format(color.toArgb() and 0xFFFFFF)
    val escaped = content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">" +
        "<body style=\"margin:0;padding:12px;background:${css(background)};color:${css(text)}\"><pre style=\"margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.5 monospace;-webkit-user-select:text;user-select:text\">$escaped</pre>"
}

/** A WebView whose text-selection menu also offers Comment; the chosen text goes to [onComment]. */
internal class CommentWebView(context: Context) : WebView(context) {
    var onComment: (String) -> Unit = {}

    override fun startActionMode(callback: ActionMode.Callback?): ActionMode? = super.startActionMode(callback?.let(::Commenting))
    override fun startActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? = super.startActionMode(callback?.let(::Commenting), type)

    private inner class Commenting(private val inner: ActionMode.Callback) : ActionMode.Callback2() {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            val created = inner.onCreateActionMode(mode, menu)
            if (created) menu.add(0, COMMENT_ITEM, 0, R.string.ccr_artifact_viewer_selection_comment).setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
            return created
        }
        override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = inner.onPrepareActionMode(mode, menu)
        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            if (item.itemId != COMMENT_ITEM) return inner.onActionItemClicked(mode, item)
            // Read the selection first; finishing the mode clears it.
            evaluateJavascript("window.getSelection().toString()") { raw ->
                val selected = (runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String).orEmpty().trim()
                if (selected.isNotEmpty()) onComment(selected.take(MAX_SELECTION))
            }
            mode.finish()
            return true
        }
        override fun onDestroyActionMode(mode: ActionMode) = inner.onDestroyActionMode(mode)
        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
            if (inner is ActionMode.Callback2) inner.onGetContentRect(mode, view, outRect) else super.onGetContentRect(mode, view, outRect)
        }
    }
    companion object { const val MAX_SELECTION = 2_000 }
}
