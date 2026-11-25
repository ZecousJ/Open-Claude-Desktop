package com.claudex.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScheduleNoticesTest {
    @Test fun aRunThatFinishesIsAnnouncedOnce() {
        val before = JSONObject().put("id", "task").put("lastRunStatus", "running").put("conversationId", "chat").put("name", "Morning")
        val done = JSONObject(before.toString()).put("lastRunStatus", "completed").put("lastRunSummary", "Done")
        val notices = ScheduleNotices.completions(listOf(before), listOf(done))
        assertEquals(1, notices.size)
        assertTrue(notices[0].completed)
        assertEquals("Done", notices[0].body)
        assertEquals("chat", notices[0].conversationId)
        assertEquals(0, ScheduleNotices.completions(listOf(done), listOf(done)).size)
    }

    @Test fun aTaskCanTurnTheNoticeOff() {
        val before = JSONObject().put("id", "task").put("lastRunStatus", "running").put("conversationId", "chat")
        val done = JSONObject(before.toString()).put("lastRunStatus", "failed").put("lastRunNotify", false)
        assertEquals(0, ScheduleNotices.completions(listOf(before), listOf(done)).size)
        val quiet = JSONObject(before.toString()).put("lastRunStatus", "interrupted").put("notifyOnCompletion", JSONObject().put("push", false))
        assertEquals(0, ScheduleNotices.completions(listOf(before), listOf(quiet)).size)
        val nowhere = JSONObject().put("id", "task").put("lastRunStatus", "running")
        val lost = JSONObject(nowhere.toString()).put("lastRunStatus", "failed")
        assertEquals(0, ScheduleNotices.completions(listOf(nowhere), listOf(lost)).size)
    }
}
