package com.claudex.mobile

import android.webkit.WebView
import android.widget.FrameLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

internal const val TRANSCRIPT_MEDIA_WATCH = """
(function(){ if (window.__claudexMediaWatch) return; window.__claudexMediaWatch = true;
 function post(kind) {
  if (window.claudexMedia && window.claudexMedia.postMessage) window.claudexMedia.postMessage(kind);
  else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.claudexMedia) window.webkit.messageHandlers.claudexMedia.postMessage(kind);
 }
 document.addEventListener('play', function(event) {
  var node = event.target; if (!node || (node.tagName !== 'AUDIO' && node.tagName !== 'VIDEO')) return;
  post('play');
 }, true);
 document.addEventListener('pause', function() {
  var nodes = document.querySelectorAll('audio,video');
  for (var i = 0; i < nodes.length; i++) if (!nodes[i].paused && !nodes[i].ended) return;
  if (window.speechSynthesis && window.speechSynthesis.speaking) return;
  post('idle');
 }, true);
 var synth = window.speechSynthesis;
 if (synth && !synth.__claudexWrapped) {
  synth.__claudexWrapped = true;
  var speak = synth.speak.bind(synth);
  synth.speak = function(utterance) {
   post('speech');
   if (utterance && utterance.addEventListener) {
    utterance.addEventListener('end', function(){ post('idle'); });
    utterance.addEventListener('error', function(){ post('idle'); });
   }
   return speak(utterance);
  };
  var cancel = synth.cancel.bind(synth);
  synth.cancel = function() { post('idle'); return cancel(); };
 }
})();
"""

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
    private var background: Int? = null
    fun mount(container: FrameLayout, next: ConversationWebController, promotePending: Boolean, pageColor: Int) {
        check(!disposed)
        if (background != pageColor) {
            background = pageColor
            container.setBackgroundColor(pageColor)
            view?.setBackgroundColor(pageColor)
        }
        if (owner === next) return
        val old = owner
        val prepared = if (promotePending && old?.canRetainCanvas == true)
            view?.takeIf { it.url == ConversationBridgePolicy.ENTRY }?.let { PreparedConversationCanvas(it, old.documentReady, old.documentStartedAt) }
        else null
        suspendSpeech()
        old?.dispose()
        if (prepared == null) {
            speech?.dispose(); speech = null
            view?.let { removeBridge(it); container.removeView(it); it.stopLoading(); it.destroy() }
            view = null
        }
        owner = next
        val current = next.createView(prepared, pageColor) { candidate ->
            if (bridgeView !== candidate) {
                WebViewCompat.addWebMessageListener(candidate, "claudexConversation", setOf(ConversationBridgePolicy.ORIGIN)) { sender, message, origin, mainFrame, _ ->
                    // The active immutable controller performs the unchanged authorization checks.
                    owner?.receiveFrame(sender, message.data, origin.toString(), mainFrame)
                }
                WebViewCompat.addWebMessageListener(candidate, "claudexMedia", setOf(ConversationBridgePolicy.ORIGIN)) { sender, message, origin, mainFrame, _ ->
                    owner?.receiveTranscriptMedia(sender, message.data, origin.toString(), mainFrame)
                }
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    WebViewCompat.addDocumentStartJavaScript(candidate, TRANSCRIPT_MEDIA_WATCH, setOf(ConversationBridgePolicy.ORIGIN))
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
            WebViewCompat.removeWebMessageListener(candidate, "claudexConversation")
            WebViewCompat.removeWebMessageListener(candidate, "claudexMedia")
            bridgeView = null
        }
    }
    fun dispose() {
        if (disposed) return
        disposed = true
        if (BuildConfig.DEMO_MODE) android.util.Log.i("ClaudexCanvas", "dispose view=${view?.let(System::identityHashCode)}")
        suspendSpeech(); speech?.dispose(); speech = null
        owner?.dispose(); owner = null
        view?.let { it.evaluateJavascript("window.ClaudexConversation?.dispose();", null); removeBridge(it); it.stopLoading(); it.destroy() }
        view = null
    }
}
