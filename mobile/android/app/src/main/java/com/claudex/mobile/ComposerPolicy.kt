package com.claudex.mobile

import androidx.annotation.StringRes
import com.claudex.core.Mode
import org.json.JSONObject

/** Trailing action of the composer toolbar. */
internal enum class ComposerAction { Send, Stop, None }

/** Pure composer rules; unit-tested. */
internal object ComposerPolicy {
    /**
     * Send while uploading or sending (the button then shows the upload spinner and a tap stops waiting);
     * Stop while Claudex replies and nothing new is typed; Send whenever there is text or an attachment
     * (also while replying: the message waits); otherwise None (there is no Voice Mode button to show).
     */
    fun action(busy: Boolean, generating: Boolean, hasDraft: Boolean): ComposerAction = when {
        busy -> ComposerAction.Send
        generating && !hasDraft -> ComposerAction.Stop
        hasDraft -> ComposerAction.Send
        else -> ComposerAction.None
    }

    /** Placeholder resource and its argument. */
    data class Hint(@param:StringRes val id: Int, val arg: String? = null)
    fun hint(existing: Boolean, mode: Mode, projectName: String?, holdToTalk: Boolean, sending: Boolean = false): Hint = when {
        sending -> Hint(R.string.chat_input_hint_sending)
        mode == Mode.CODE && !existing -> Hint(R.string.ccr_input_placeholder_chat_style_new_session)
        mode == Mode.COWORK && !existing -> Hint(R.string.agent_chat_input_placeholder_v2)
        holdToTalk -> Hint(if (existing) R.string.reply_or_hold_to_talk else R.string.type_or_hold_to_talk)
        !existing && projectName != null -> Hint(R.string.chat_input_hint_in_project, projectName)
        !existing -> Hint(R.string.chat_input_hint)
        projectName != null -> Hint(R.string.chat_input_hint_reply_in_project, projectName)
        else -> Hint(R.string.chat_input_hint_reply)
    }

    /** Model pill maximum width: min(220 × fontScale(≥1), max(screen − 128, 220)). */
    fun pillMaxWidth(screenWidthDp: Int, fontScale: Float): Float =
        minOf(220f * maxOf(fontScale, 1f), maxOf(screenWidthDp - 128f, 220f))

    /** The extension badge of a file tile: upper case, at most five characters. */
    fun extension(name: String): String? = name.substringAfterLast('.', "").takeIf { it.isNotEmpty() && it.length <= 5 && it.all(Char::isLetterOrDigit) }?.uppercase()

    @StringRes fun effortLabel(value: String): Int? = when (value) {
        "low" -> R.string.claudex_effort_low; "medium" -> R.string.claudex_effort_medium; "high" -> R.string.claudex_effort_high
        "xhigh" -> R.string.claudex_effort_xhigh; "max" -> R.string.claudex_effort_max; else -> null
    }
}

/** The usage card near the composer, fed by the service's plan windows. */
internal data class UsageBanner(val reached: Boolean, val percent: Int, val resetsAt: Long?)

internal object UsageBannerPolicy {
    const val APPROACHING = 80.0
    /** The fullest window at or above [APPROACHING] %, or null when every window has room. */
    fun banner(plan: JSONObject?): UsageBanner? {
        val top = UsageWindowPresentation.visible(plan).maxByOrNull { it.optDouble("percent") } ?: return null
        val percent = top.optDouble("percent")
        if (percent < APPROACHING) return null
        val resets = if (top.isNull("resetsAt")) null else top.optLong("resetsAt").takeIf { it > 0 }
        return UsageBanner(percent >= 100.0, percent.toInt().coerceIn(0, 100), resets)
    }
}
