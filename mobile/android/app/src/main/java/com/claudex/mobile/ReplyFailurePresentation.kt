package com.claudex.mobile

import androidx.annotation.StringRes
import com.claudex.core.*
import org.json.JSONObject

internal data class ReplyFailureNotice(val turnId: String, @StringRes val message: Int, val retryable: Boolean, val continuable: Boolean)
internal object ReplyFailurePresentation {
    /** The line shown above the composer: the official capacity / limit / session wording, never the raw error. */
    @StringRes fun reason(error: String?): Int {
        val text = error.orEmpty().lowercase(java.util.Locale.ROOT)
        return when {
            Regex("\\b(502|503|504|529)\\b|upstream|temporarily unavailable|overloaded|bad gateway").containsMatchIn(text) -> R.string.error_overloaded
            Regex("\\b429\\b|rate.?limit|too many requests").containsMatchIn(text) -> R.string.error_rate_limit_per_model
            Regex("timed? ?out|timeout|etimedout|deadline").containsMatchIn(text) -> R.string.claudex_msg_timeout
            Regex("econn|enotfound|network|fetch failed|socket|offline|unreachable").containsMatchIn(text) -> R.string.claudex_msg_no_connection
            Regex("\\b(401|403)\\b|unauthori[sz]ed|forbidden|invalid api key|sign in").containsMatchIn(text) -> R.string.error_account_session_invalid
            else -> R.string.chat_response_incomplete
        }
    }
    fun notice(conversation: Conversation?, busy: Boolean): ReplyFailureNotice? {
        val c = conversation ?: return null
        val latest = c.turns.lastOrNull() ?: return null
        if (latest.status != TurnStatus.FAILED || runCatching { JSONObject(latest.rawJson ?: "{}").optString("stopReason") == "length" }.getOrDefault(false)) return null
        val idle = !busy && !c.slim && c.turns.none { it.status == TurnStatus.IN_PROGRESS }
        return ReplyFailureNotice(latest.id, reason(latest.error), idle && c.mode == Mode.CHAT && !latest.compaction, idle && !latest.compaction)
    }
}
