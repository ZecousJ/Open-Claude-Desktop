package com.claudex.mobile

import com.claudex.core.*
import org.junit.Assert.*
import org.junit.Test

class ReplyFailurePresentationTest {
    private fun conversation(turn: Turn, mode: Mode = Mode.CHAT) = Conversation("synthetic", "", mode, "provider", "model", turns = listOf(turn))
    @Test fun errorClassesNeverExposeRawEngineAddressesOrJson() {
        assertEquals(R.string.error_overloaded, ReplyFailurePresentation.reason("503 upstream http://127.0.0.1 synthetic-token"))
        assertEquals(R.string.error_rate_limit_per_model, ReplyFailurePresentation.reason("429"))
        assertEquals(R.string.claudex_msg_timeout, ReplyFailurePresentation.reason("deadline"))
        assertEquals(R.string.chat_response_incomplete, ReplyFailurePresentation.reason("{synthetic private details}"))
    }
    @Test fun sessionAndNetworkErrorsKeepTheirOwnLine() {
        assertEquals(R.string.error_account_session_invalid, ReplyFailurePresentation.reason("401 Unauthorized"))
        assertEquals(R.string.claudex_msg_no_connection, ReplyFailurePresentation.reason("ECONNRESET socket"))
    }
    @Test fun onlyLatestNonLengthFailureHasNoticeAndIdleChatActions() {
        val failed = Turn("turn", "", status = TurnStatus.FAILED, error = "503")
        assertTrue(ReplyFailurePresentation.notice(conversation(failed), false)!!.retryable)
        assertFalse(ReplyFailurePresentation.notice(conversation(failed), true)!!.continuable)
        assertFalse(ReplyFailurePresentation.notice(conversation(failed, Mode.CODE), false)!!.retryable)
        assertNull(ReplyFailurePresentation.notice(conversation(failed.copy(rawJson = """{"stopReason":"length"}""")), false))
        assertNull(ReplyFailurePresentation.notice(conversation(failed.copy(status = TurnStatus.COMPLETED)), false))
    }
    @Test fun compactionCannotBeRetriedAndNewerSuccessfulTurnHidesFailure() {
        val failed = Turn("old", "", status = TurnStatus.FAILED, compaction = true)
        assertFalse(ReplyFailurePresentation.notice(conversation(failed), false)!!.retryable)
        assertNull(ReplyFailurePresentation.notice(conversation(failed).copy(turns = listOf(failed, Turn("new", ""))), false))
    }
}
