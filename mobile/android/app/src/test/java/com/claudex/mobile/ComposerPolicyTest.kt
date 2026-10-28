package com.claudex.mobile

import com.claudex.core.Mode
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ComposerPolicyTest {
    @Test fun actionFollowsTheOfficialSendStopNoneRule() {
        assertEquals(ComposerAction.None, ComposerPolicy.action(busy = false, generating = false, hasDraft = false))
        assertEquals(ComposerAction.Send, ComposerPolicy.action(busy = false, generating = false, hasDraft = true))
        assertEquals(ComposerAction.Stop, ComposerPolicy.action(busy = false, generating = true, hasDraft = false))
        // Typing while Claudex replies queues the message: Send, not Stop.
        assertEquals(ComposerAction.Send, ComposerPolicy.action(busy = false, generating = true, hasDraft = true))
        // Uploading: Send with the spinner (a tap stops waiting).
        assertEquals(ComposerAction.Send, ComposerPolicy.action(busy = true, generating = false, hasDraft = false))
    }

    @Test fun placeholders() {
        assertEquals(ComposerPolicy.Hint(R.string.chat_input_hint), ComposerPolicy.hint(false, Mode.CHAT, null, false))
        assertEquals(ComposerPolicy.Hint(R.string.chat_input_hint_in_project, "论文"), ComposerPolicy.hint(false, Mode.CHAT, "论文", false))
        assertEquals(ComposerPolicy.Hint(R.string.chat_input_hint_reply), ComposerPolicy.hint(true, Mode.CHAT, null, false))
        assertEquals(ComposerPolicy.Hint(R.string.chat_input_hint_reply_in_project, "论文"), ComposerPolicy.hint(true, Mode.CHAT, "论文", false))
        assertEquals(ComposerPolicy.Hint(R.string.type_or_hold_to_talk), ComposerPolicy.hint(false, Mode.CHAT, "论文", true))
        assertEquals(ComposerPolicy.Hint(R.string.reply_or_hold_to_talk), ComposerPolicy.hint(true, Mode.CHAT, null, true))
        assertEquals(ComposerPolicy.Hint(R.string.ccr_input_placeholder_chat_style_new_session), ComposerPolicy.hint(false, Mode.CODE, null, true))
        assertEquals(ComposerPolicy.Hint(R.string.agent_chat_input_placeholder_v2), ComposerPolicy.hint(false, Mode.COWORK, null, true))
        // "Sending…" wins over every other placeholder while a message is on its way.
        assertEquals(ComposerPolicy.Hint(R.string.chat_input_hint_sending), ComposerPolicy.hint(true, Mode.CODE, "论文", true, sending = true))
    }

    @Test fun modelPillWidth() {
        assertEquals(220f, ComposerPolicy.pillMaxWidth(360, 1f))
        assertEquals(220f, ComposerPolicy.pillMaxWidth(300, 1f))
        assertEquals(264f, ComposerPolicy.pillMaxWidth(800, 1.2f))
        assertEquals(272f, ComposerPolicy.pillMaxWidth(400, 2f))
    }

    @Test fun extensionBadge() {
        assertEquals("PDF", ComposerPolicy.extension("报告.pdf"))
        assertEquals("XLSX", ComposerPolicy.extension("a.b.xlsx"))
        assertNull(ComposerPolicy.extension("README"))
        assertNull(ComposerPolicy.extension("archive.verylong"))
    }

    @Test fun dictationJoinsTextNaturally() {
        assertEquals("你好", DictationPolicy.append("", " 你好 "))
        assertEquals("你好世界", DictationPolicy.append("你好", "世界"))
        assertEquals("hello world", DictationPolicy.append("hello", "world"))
        assertEquals("hello\nworld", DictationPolicy.append("hello\n", "world"))
        assertEquals("draft", DictationPolicy.append("draft", "  "))
    }

    @Test fun dictationLevelsAndErrors() {
        assertEquals(0f, DictationPolicy.level(-10f))
        assertEquals(1f, DictationPolicy.level(20f))
        assertTrue(DictationPolicy.level(4f) in 0.4f..0.6f)
        assertEquals(R.string.stt_error_network, DictationPolicy.error(android.speech.SpeechRecognizer.ERROR_NETWORK, false))
        assertEquals(R.string.stt_error_microphone, DictationPolicy.error(android.speech.SpeechRecognizer.ERROR_AUDIO, false))
        assertEquals(R.string.stt_error_transcription_empty, DictationPolicy.error(android.speech.SpeechRecognizer.ERROR_NO_MATCH, false))
        assertNull(DictationPolicy.error(android.speech.SpeechRecognizer.ERROR_NO_MATCH, true))
        assertEquals(R.string.audio_permission_required, DictationPolicy.error(android.speech.SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS, false))
    }

    @Test fun usageBannerOnlyNearTheLimit() {
        fun plan(vararg rows: Pair<Int, Long?>) = JSONObject().put("windows", org.json.JSONArray(rows.mapIndexed { i, (p, r) ->
            JSONObject().put("label", "w$i").put("percent", p).apply { if (r != null) put("resetsAt", r) } }))
        assertNull(UsageBannerPolicy.banner(null))
        assertNull(UsageBannerPolicy.banner(plan(40 to null, 79 to null)))
        assertEquals(UsageBanner(false, 85, 1000L), UsageBannerPolicy.banner(plan(40 to null, 85 to 1000L)))
        assertEquals(UsageBanner(true, 100, null), UsageBannerPolicy.banner(plan(100 to null, 90 to 5L)))
    }
}
