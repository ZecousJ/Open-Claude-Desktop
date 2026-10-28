package com.claudex.mobile

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject

/**
 * GPT IQ check (owner, 2026-10-06; strings-feature-map C26) in the artifact-gallery card style: every hour the
 * service asks a model for an HTML page with an SVG animation of a pelican riding a bicycle; each check is a
 * card with the page (4:3 preview, 12 dp corners, hairline) and when it ran. The reference examples come first,
 * their caption and outline in the verdict's colour (normal = success, degraded = danger).
 */
@Composable fun IqChecks(data: JSONObject) {
    val checks = data.optJSONArray("iq")?.objects().orEmpty().filter { it.optLong("id") > 0 }
    val examples = data.optJSONArray("iq_examples")?.objects().orEmpty().filter { it.optString("html").isNotBlank() }
    if (checks.isEmpty() && examples.isEmpty()) return
    val c = Claude.colors
    GroupGap()
    SettingsSectionHeader(stringResource(R.string.claudex_iq_title))
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (examples.isNotEmpty()) {
            Text(stringResource(R.string.claudex_iq_examples), style = Claude.type.body17Strong, color = c.text100)
            IqGrid(examples.map { val degraded = it.optString("kind") == "degraded"
                IqCardData(it.optString("html"), stringResource(if (degraded) R.string.claudex_iq_degraded else R.string.claudex_iq_normal), if (degraded) c.danger100 else c.success100) })
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(stringResource(R.string.claudex_iq_history), style = Claude.type.body17Strong, color = c.text100)
            Text(stringResource(R.string.claudex_iq_history_caption), style = Claude.type.body15, color = c.text500)
        }
        IqGrid(checks.map { IqCardData(if (it.optString("status") == "ok") it.optString("html") else "", stringResource(R.string.claudex_iq_checked_at, NativeDetailPolicy.localTime(it.optString("started_at")))) })
    }
}

private data class IqCardData(val html: String, val caption: String, val verdict: Color? = null)

@Composable private fun IqGrid(cards: List<IqCardData>) {
    cards.chunked(2).forEach { pair ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            pair.forEach { card -> IqCard(card, Modifier.weight(1f)) }
            if (pair.size == 1) Spacer(Modifier.weight(1f))
        }
    }
}

/** The page is laid out at 800×600, as the prompt asks, and shown whole: scaled to the card, never scrolled. */
@Composable private fun IqCard(card: IqCardData, modifier: Modifier) {
    val html = card.html
    val c = Claude.colors
    val verdict = card.verdict
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        BoxWithConstraints(Modifier.fillMaxWidth().aspectRatio(4f / 3f).clip(Claude.shapes.r12).background(Color.White)
            .border(if (verdict != null) 2.dp else 1.dp, verdict ?: c.borderDefault, Claude.shapes.r12), contentAlignment = Alignment.Center) {
            if (html.isNotBlank()) {
                val scale = maxWidth / 800.dp
                Box(Modifier.fillMaxSize().clipToBounds(), contentAlignment = Alignment.TopStart) {
                    Box(Modifier.wrapContentSize(Alignment.TopStart, unbounded = true).requiredSize(800.dp, 600.dp)
                        .graphicsLayer { scaleX = scale; scaleY = scale; transformOrigin = TransformOrigin(0f, 0f) }) { IqPage(html) }
                }
            } else Text(stringResource(R.string.claudex_iq_no_page), style = Claude.type.body13, color = c.textTertiary)
        }
        if (verdict != null) Text(card.caption, Modifier.fillMaxWidth(), style = Claude.type.body15Strong, color = verdict, textAlign = TextAlign.Center)
        else Text(card.caption, Modifier.padding(horizontal = 2.dp), style = Claude.type.body13, color = c.text500, maxLines = 1)
    }
}

private const val policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:\"><style>html,body{overflow:hidden!important}</style>"

/** The page with its own scripts but nothing from the network: a policy goes in first, network loads are blocked and no link is followed. */
internal fun iqPage(html: String): String {
    val head = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html)
    return if (head != null) html.substring(0, head.range.last + 1) + policy + html.substring(head.range.last + 1) else policy + html
}

@SuppressLint("SetJavaScriptEnabled")
@Composable private fun IqPage(html: String) {
    AndroidView(factory = { context ->
        WebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.javaScriptEnabled = true
            settings.blockNetworkLoads = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.domStorageEnabled = false
            // CSS pixels are dp: the 800×600 page fills the 800×600 dp view.
            settings.loadWithOverviewMode = false
            settings.useWideViewPort = false
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            setBackgroundColor(android.graphics.Color.WHITE)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
            }
            loadDataWithBaseURL(null, iqPage(html), "text/html", "utf-8", null)
            tag = html
        }
    }, update = { view -> if (view.tag != html) { view.tag = html; view.loadDataWithBaseURL(null, iqPage(html), "text/html", "utf-8", null) } },
        onRelease = { it.destroy() }, modifier = Modifier.fillMaxSize())
}
