package com.claudex.mobile

import android.webkit.WebView
import android.widget.FrameLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

internal data class PreparedConversationCanvas(val view: WebView, val ready: Boolean, val startedAt: Long)

/** One visual canvas for one page. Controllers still own immutable, separately checked leases. */
internal class ConversationCanvas {
    private var view: WebView? = null
    private var owner: ConversationWebController? = null
    private var bridgeView: WebView? = null
    private var disposed = false
    private var speech: OfflineSpeechAdapter? = null
    private var speechResumed = false
    fun speechForeground(value: Boolean) {
        speechResumed = value
        if (!value) suspendSpeech() else speech?.foreground(true)
    }
    private fun suspendSpeech() {
        speech?.foreground(false)
        // Canonical reading advances on errors: suspend later chunks until the next voice refresh.
        view?.takeIf { it.url == ConversationBridgePolicy.ENTRY }?.evaluateJavascript("window.__claudexOfflineSpeechEvent?.({type:\"cancelled\"});", null)
    }
    fun mount(container: FrameLayout, next: ConversationWebController, promotePending: Boolean) {
        check(!disposed)
        if (owner === next) return
        val old = owner
        val prepared = if (promotePending && old?.canRetainCanvas == true)
            view?.takeIf { it.url == ConversationBridgePolicy.ENTRY }?.let { PreparedConversationCanvas(it, old.documentReady, old.documentStartedAt) }
        else null
        suspendSpeech()
        old?.dispose(preserveCanvas = true)
        if (prepared == null) {
            speech?.dispose(); speech = null
            view?.let { removeBridge(it); container.removeView(it); it.stopLoading(); it.destroy() }
            view = null
        }
        owner = next
        val current = next.createView(prepared) { candidate ->
            if (bridgeView !== candidate) {
                WebViewCompat.addWebMessageListener(candidate, "claudexConversation", setOf(ConversationBridgePolicy.ORIGIN)) { sender, message, origin, mainFrame, _ ->
                    // The active immutable controller performs the unchanged authorization checks.
                    owner?.receiveFrame(sender, message.data, origin.toString(), mainFrame)
                }
                bridgeView = candidate
                speech = OfflineSpeechAdapter(candidate.context, candidate) { owner?.authorizesSpeech(candidate) == true }.also { it.install() }
            }
        }
        view = current
        speech?.beginOwner()
        speech?.foreground(speechResumed)
        if (BuildConfig.DEMO_MODE) android.util.Log.i("ClaudexCanvas", "mount view=${System.identityHashCode(current)} retained=${prepared != null}")
        if (current.parent == null) container.addView(current)
    }
    private fun removeBridge(candidate: WebView) {
        if (bridgeView === candidate && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(candidate, "claudexConversation"); bridgeView = null
        }
    }
    fun dispose() {
        if (disposed) return
        disposed = true
        if (BuildConfig.DEMO_MODE) android.util.Log.i("ClaudexCanvas", "dispose view=${view?.let(System::identityHashCode)}")
        suspendSpeech(); speech?.dispose(); speech = null
        owner?.dispose(preserveCanvas = true); owner = null
        view?.let { it.evaluateJavascript("window.ClaudexConversation?.dispose();", null); removeBridge(it); it.stopLoading(); it.destroy() }
        view = null
    }
}
