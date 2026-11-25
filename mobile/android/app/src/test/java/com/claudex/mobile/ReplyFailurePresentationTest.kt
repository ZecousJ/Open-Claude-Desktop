package com.claudex.mobile

import com.claudex.core.*
import org.junit.Assert.*
import org.junit.Test

class ReplyFailurePresentationTest {
    @Test fun offlineReplyShowsOnlyWhileTheTurnIsStillRunning() {
        val running = Conversation("c", "Chat", providerId = "p", model = "m", turns = listOf(Turn("t", "Ask", status = TurnStatus.IN_PROGRESS)))
        val idle = running.copy(turns = listOf(Turn("t", "Ask")))
        assertEquals(R.string.long_task_offline, LongTaskStatus.message(running, Connection.Offline))
        assertEquals(R.string.long_task_reconnecting, LongTaskStatus.message(running, Connection.Reconnecting(1)))
        assertEquals(R.string.long_task_reconnecting, LongTaskStatus.message(running, Connection.Connecting))
        assertEquals(R.string.long_task_send_later, LongTaskStatus.message(idle, Connection.Offline, queued = true))
        assertNull(LongTaskStatus.message(running, Connection.Connected))
        assertNull(LongTaskStatus.message(running, Connection.Error("session")))
        assertNull(LongTaskStatus.message(idle, Connection.Offline))
        assertNull(LongTaskStatus.message(idle, Connection.Connected, queued = true))
    }

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
