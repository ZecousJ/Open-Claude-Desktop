package com.claudex.mobile

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Which dictation toolbar the composer shows: none, tap mode or hold-to-talk. */
internal enum class DictationMode { Off, Tap, Hold }

/** Pure rules of the dictation strip; unit-tested. */
internal object DictationPolicy {
    /** One waveform bar per 60 ms of audio level. */
    const val SAMPLE_MILLIS = 60L
    /** Silence or no sample for longer than this draws the bar in the secondary colour. */
    const val SILENT_MILLIS = 750L
    const val MAX_BARS = 160

    /** RMS dB from [RecognitionListener.onRmsChanged] (about −2…10) as a 0…1 level. */
    fun level(rmsDb: Float): Float = ((rmsDb + 2f) / 12f).coerceIn(0f, 1f)

    /** Appends dictated text to the draft: no space between CJK characters, one space otherwise. */
    fun append(draft: String, text: String): String {
        val spoken = text.trim()
        if (spoken.isEmpty()) return draft
        if (draft.isBlank()) return spoken
        val last = draft.last(); val first = spoken.first()
        val joinTight = last.isWhitespace() || cjk(last) || cjk(first)
        return if (joinTight) draft + spoken else "$draft $spoken"
    }
    private fun cjk(c: Char) = Character.UnicodeScript.of(c.code).let {
        it == Character.UnicodeScript.HAN || it == Character.UnicodeScript.HIRAGANA || it == Character.UnicodeScript.KATAKANA || it == Character.UnicodeScript.HANGUL
    } || c in '　'..'〿' || c in '＀'..'￯'

    /** Recogniser errors as the official `stt_error_*` copy; null = nothing worth showing. */
    @StringRes fun error(code: Int, heardSomething: Boolean): Int? = when (code) {
        SpeechRecognizer.ERROR_AUDIO, SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> R.string.stt_error_microphone
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> R.string.stt_error_network
        SpeechRecognizer.ERROR_SERVER, 11 /* ERROR_SERVER_DISCONNECTED */ -> R.string.stt_error_server
        12 /* ERROR_LANGUAGE_NOT_SUPPORTED */, 13 /* ERROR_LANGUAGE_UNAVAILABLE */ -> R.string.stt_error_language_not_found
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> R.string.audio_permission_required
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> if (heardSomething) null else R.string.stt_error_transcription_empty
        else -> if (heardSomething) null else R.string.stt_error_transcription_empty
    }
}

/**
 * In-app dictation on the platform speech recogniser, so the composer can show the official
 * recording strip (waveform, Cancel / Stop dictation / Send dictation, hold-to-talk) instead of the
 * system dialog. Listening restarts after each recognised phrase until the person stops, so a long
 * dictation is not cut at the recogniser's own end-of-speech.
 */
internal class ComposerDictation(private val context: Context, private val scope: CoroutineScope) : RecognitionListener {
    var mode by mutableStateOf(DictationMode.Off); private set
    var transcribing by mutableStateOf(false); private set
    /** Hold mode: the finger is over the cancel target. */
    var holdCancel by mutableStateOf(false)
    /** The latest dictation error, shown above the card until the next dictation or edit. */
    var error by mutableStateOf<Int?>(null)
    /** Waveform: newest bar last; −1 = silence (drawn in the secondary colour). */
    val bars = mutableStateListOf<Float>()

    private var recognizer: SpeechRecognizer? = null
    private var sampler: Job? = null
    private var level = 0f
    private var levelAt = 0L
    private val heard = StringBuilder()
    private var partial = ""
    private var stopping = false
    private var sendAfter = false
    private var deliver: ((String, Boolean) -> Unit)? = null
    private var currentLanguage = ""

    val available: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)
    val active: Boolean get() = mode != DictationMode.Off

    /** Starts listening; [onText] gets the transcript and whether it should be sent right away. */
    fun start(hold: Boolean, language: String, onText: (String, Boolean) -> Unit) {
        if (active) return
        error = null; heard.clear(); partial = ""; stopping = false; sendAfter = false; holdCancel = false
        deliver = onText
        bars.clear(); level = 0f; levelAt = 0L
        val created = runCatching { SpeechRecognizer.createSpeechRecognizer(context) }.getOrNull()
        if (created == null) { error = R.string.claudex_stt_unavailable; return }
        recognizer = created.also { it.setRecognitionListener(this) }
        mode = if (hold) DictationMode.Hold else DictationMode.Tap
        transcribing = false
        currentLanguage = language
        listen(language)
        sampler = scope.launch {
            while (isActive) {
                val now = System.currentTimeMillis()
                bars.add(if (levelAt == 0L || now - levelAt > DictationPolicy.SILENT_MILLIS || level <= 0f) -1f else level)
                while (bars.size > DictationPolicy.MAX_BARS) bars.removeAt(0)
                delay(DictationPolicy.SAMPLE_MILLIS)
            }
        }
    }
    private fun listen(language: String) {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        if (language.isNotBlank()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
        runCatching { recognizer?.startListening(intent) }.onFailure { finish(R.string.stt_error_microphone) }
    }

    /** Stop dictation (tap) or release (hold): the transcript lands in the draft, and is sent when [send]. */
    fun stop(send: Boolean) {
        if (!active || stopping) return
        stopping = true; sendAfter = send; transcribing = true
        runCatching { recognizer?.stopListening() }.onFailure { finish(null) }
    }

    /** Cancel: nothing reaches the draft. */
    fun cancel() {
        if (!active) return
        deliver = null
        runCatching { recognizer?.cancel() }
        finish(null)
    }

    fun dispose() { deliver = null; finish(null) }

    private fun finish(@StringRes failure: Int?) {
        sampler?.cancel(); sampler = null
        runCatching { recognizer?.destroy() }; recognizer = null
        val text = DictationPolicy.append(heard.toString(), partial).trim()
        val callback = deliver; deliver = null
        val send = sendAfter
        mode = DictationMode.Off; transcribing = false; stopping = false; holdCancel = false
        if (failure != null && text.isEmpty()) error = failure
        if (callback != null && text.isNotEmpty()) callback(text, send)
    }

    private fun keep(text: String) { val joined = DictationPolicy.append(heard.toString(), text); heard.setLength(0); heard.append(joined) }
    override fun onResults(results: Bundle?) {
        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
        partial = ""
        if (text.isNotBlank()) keep(text)
        if (stopping || deliver == null) finish(if (heard.isEmpty()) R.string.stt_error_transcription_empty else null)
        else listen(currentLanguage) // keep listening until the person stops
    }
    override fun onPartialResults(partialResults: Bundle?) {
        partial = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
    }
    override fun onError(code: Int) {
        val heardSomething = heard.isNotEmpty() || partial.isNotBlank()
        if (!stopping && deliver != null && (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT)) {
            // A pause while dictating: keep the microphone open, as the official strip does.
            if (partial.isNotBlank()) { keep(partial); partial = "" }
            listen(currentLanguage); return
        }
        finish(DictationPolicy.error(code, heardSomething))
    }
    override fun onRmsChanged(rmsdB: Float) { level = DictationPolicy.level(rmsdB); levelAt = System.currentTimeMillis() }
    override fun onReadyForSpeech(params: Bundle?) {}
    override fun onBeginningOfSpeech() {}
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() {}
    override fun onEvent(eventType: Int, params: Bundle?) {}
}
