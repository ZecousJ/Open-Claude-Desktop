package com.claudex.mobile

import org.json.JSONObject

/** A scheduled task whose run just finished, as the desktop notice describes it. */
internal data class ScheduleNotice(val completed: Boolean, val body: String, val conversationId: String, val taskId: String)

/**
 * The desktop rule (`routineCompletionNotices`): a run that leaves "starting" or "running"
 * for completed, failed or interrupted. The task can turn the notice off, and a run with no
 * conversation is not announced.
 */
internal object ScheduleNotices {
    private val finished = setOf("completed", "failed", "interrupted")

    fun completions(previous: List<JSONObject>, next: List<JSONObject>): List<ScheduleNotice> = next.mapNotNull { task ->
        val before = previous.find { it.optString("id") == task.optString("id") } ?: return@mapNotNull null
        val status = task.optString("lastRunStatus")
        val beforeStatus = before.optString("lastRunStatus")
        if (status !in finished || beforeStatus.isEmpty() || beforeStatus in finished) return@mapNotNull null
        if (task.has("lastRunNotify") && !task.optBoolean("lastRunNotify", true)) return@mapNotNull null
        val delivery = task.optJSONObject("notifyOnCompletion")
        if (delivery != null && delivery.has("push") && !delivery.optBoolean("push", true)) return@mapNotNull null
        val conversation = task.optString("conversationId")
        if (conversation.isEmpty()) return@mapNotNull null
        val summary = task.optString("lastRunSummary").trim()
        val name = task.optString("name").trim().take(80)
        ScheduleNotice(status == "completed", summary.ifBlank { name }, conversation, task.optString("id"))
    }
}
