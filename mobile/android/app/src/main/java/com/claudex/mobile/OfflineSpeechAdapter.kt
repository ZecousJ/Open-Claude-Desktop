package com.claudex.mobile

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.webkit.WebView
import android.widget.Toast
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/** No RPC/file/account access. Only the already-authorized local conversation frame can speak. */
internal class OfflineSpeechAdapter(private val context: Context, private val view: WebView, private val authorized: () -> Boolean) {
    private val handler = Handler(Looper.getMainLooper())
    private var script: ScriptHandler? = null
    private var engine: TextToSpeech? = null
    private var initialized = false
    private var initializationStarted = false
    private var disposed = false
    private var foreground = true
    private var active: String? = null
    private var voices = emptyList<Voice>()
    private var lastId = 0L
    private var playbackGeneration = 0L
    fun beginOwner() { playbackGeneration++ }
    private val watchdog = object : Runnable {
        override fun run() {
            if (active == null) return
            if (!allowed()) stop() else handler.postDelayed(this, 250)
        }
    }
    private val deadline = Runnable { active?.let { complete(it, "error", "synthesis-failed"); engine?.stop() } }
    private fun allowed() = !disposed && foreground && authorized() && view.url == ConversationBridgePolicy.ENTRY
    fun install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        WebViewCompat.addWebMessageListener(view, "claudexOfflineSpeech", setOf(ConversationBridgePolicy.ORIGIN)) { sender, message, origin, mainFrame, _ ->
            if (sender !== view || !ConversationBridgePolicy.acceptsFrame(origin.toString(), mainFrame, sender.url) || !allowed()) return@addWebMessageListener
            val data = message.data ?: return@addWebMessageListener
            if (data.length > 8000) return@addWebMessageListener
            runCatching { receive(JSONObject(data)) }
        }
        script = WebViewCompat.addDocumentStartJavaScript(view, context.assets.open("offline-speech.js").bufferedReader().use { it.readText() }, setOf(ConversationBridgePolicy.ORIGIN))
    }
    private fun receive(message: JSONObject) {
        if (BuildConfig.DEMO_MODE) android.util.Log.i("ClaudexSpeech", "receive=${message.optString("type")} view=${System.identityHashCode(view)}")
        if (message.opt("version") != 1) return
        if (message.optString("type") != "voices" && message.optLong("context", -1) != playbackGeneration) return
        when (message.optString("type")) {
            "voices" -> initialize()
            "cancel" -> stop(notify = false)
            "speak" -> {
                val id = message.optString("id"); val text = message.optString("text"); val rate = message.optDouble("rate", Double.NaN)
                if (!OfflineSpeechPolicy.valid(id, text, rate)) { emit("error", id, "invalid-argument"); return }
                val sequence = id.removePrefix("speech-").toLongOrNull() ?: return
                if (sequence <= lastId) return
                lastId = sequence
                if (active != null) { emit("error", id, "synthesis-failed"); return }
                val lang = message.optString("lang"); val requested = message.optString("voice")
                if (lang.length > 64 || requested.length > 256) { emit("error", id, "invalid-argument"); return }
                val voiceId = OfflineSpeechPolicy.choose(descriptors(), requested, lang)
                val voice = engine?.voices.orEmpty().firstOrNull { it.name == voiceId && !it.isNetworkConnectionRequired && "notInstalled" !in it.features.orEmpty() }
                val tts = engine
                if (!initialized || tts == null || voice == null) {
                    emit("error", id, "voice-unavailable")
                    Toast.makeText(context, context.getString(R.string.speech_error_no_offline_language), Toast.LENGTH_SHORT).show(); return
                }
                // No setLanguage/default fallback: it can silently select a network voice.
                if (tts.setVoice(voice) != TextToSpeech.SUCCESS || tts.setSpeechRate(rate.toFloat()) != TextToSpeech.SUCCESS) { emit("error", id, "voice-unavailable"); return }
                active = id
                handler.post(watchdog); handler.postDelayed(deadline, 120_000)
                if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) complete(id, "error", "synthesis-failed")
            }
        }
    }
    private fun descriptors() = voices.map { OfflineSpeechVoice(it.name, it.locale.toLanguageTag(), it.isNetworkConnectionRequired, "notInstalled" !in it.features.orEmpty()) }
    private fun initialize() {
        if (script == null || disposed) return
        if (initializationStarted) { publishVoices(); return }
        initializationStarted = true
        engine = TextToSpeech(context.applicationContext) { status -> handler.post {
            if (disposed) { engine?.shutdown(); engine = null; return@post }
            initialized = status == TextToSpeech.SUCCESS
            if (initialized) {
                val available = engine?.voices.orEmpty().toList()
                val ids = OfflineSpeechPolicy.voices(available.map { OfflineSpeechVoice(it.name, it.locale.toLanguageTag(), it.isNetworkConnectionRequired, "notInstalled" !in it.features.orEmpty()) }).map { it.id }.toSet()
                voices = available.filter { it.name in ids }
                engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) { handler.post { if (utteranceId == active && allowed()) emit("start", utteranceId) } }
                    override fun onDone(utteranceId: String?) { handler.post { complete(utteranceId, "end") } }
                    @Deprecated("Android callback") override fun onError(utteranceId: String?) { handler.post { complete(utteranceId, "error", "synthesis-failed") } }
                    override fun onError(utteranceId: String?, errorCode: Int) { handler.post { complete(utteranceId, "error", "synthesis-failed") } }
                })
            }
            publishVoices()
        } }
    }
    private fun publishVoices() {
        val values = JSONArray()
        for (voice in voices) values.put(JSONObject().put("voiceURI", voice.name).put("name", voice.name).put("lang", voice.locale.toLanguageTag()).put("localService", true).put("default", false))
        send(JSONObject().put("type", "voices").put("voices", values))
    }
    private fun emit(type: String, id: String? = null, error: String? = null) {
        val event = JSONObject().put("type", type)
        if (id != null) event.put("id", id)
        if (error != null) event.put("error", error)
        send(event)
    }
    private fun send(event: JSONObject) {
        event.put("context", playbackGeneration)
        if (BuildConfig.DEMO_MODE) android.util.Log.i("ClaudexSpeech", "event=${event.optString("type")} error=${event.optString("error")} allowed=${allowed()} view=${System.identityHashCode(view)}")
        if (allowed()) view.evaluateJavascript("window.__claudexOfflineSpeechEvent?.(JSON.parse(${JSONObject.quote(event.toString())}));", null)
    }
    private fun complete(id: String?, type: String, error: String? = null) {
        if (id == null || id != active) return
        active = null; handler.removeCallbacks(watchdog); handler.removeCallbacks(deadline); emit(type, id, error)
    }
    fun stop(notify: Boolean = true) { active = null; handler.removeCallbacks(watchdog); handler.removeCallbacks(deadline); engine?.stop(); if (notify) emit("cancelled") }
    fun foreground(value: Boolean) { if (!value) stop(); foreground = value; if (value) initialize() }
    fun dispose() {
        if (disposed) return
        stop(); disposed = true; handler.removeCallbacksAndMessages(null); engine?.shutdown(); engine = null; voices = emptyList()
        script?.remove(); script = null
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.removeWebMessageListener(view, "claudexOfflineSpeech")
    }
}
