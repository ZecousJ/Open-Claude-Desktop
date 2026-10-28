package com.claudex.mobile

import com.claudex.core.Conversation
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import org.json.JSONObject

internal object SidebarPolicy {
    fun accountName(profile: JSONObject?, fallback: String): String =
        profile?.optString("username")?.trim()?.takeIf { it.isNotEmpty() }
            ?: profile?.optString("email")?.takeIf { it.isNotBlank() } ?: fallback

    /** Recents shows this many rows before "Show all %d". */
    const val RECENTS_COLLAPSED = 5

    data class Sections(val pinned: List<Conversation>, val recents: List<Conversation>)

    /** Drawer groups: Pinned (all, never collapsed) then Recents, newest first; archived chats stay out. */
    fun sections(conversations: List<Conversation>): Sections {
        val live = conversations.filter { !it.archived }.sortedByDescending { it.updatedAt }
        return Sections(live.filter { it.pinned }, live.filter { !it.pinned })
    }

    fun visibleRecents(recents: List<Conversation>, expanded: Boolean): List<Conversation> =
        if (expanded || recents.size <= RECENTS_COLLAPSED) recents else recents.take(RECENTS_COLLAPSED)

    /** True when the group needs the Show all / Show less control. */
    fun collapsible(recents: List<Conversation>) = recents.size > RECENTS_COLLAPSED
}

/** Recency buckets of the official chat list. Order = display order. */
enum class RecencyBucket(val label: Int) {
    TODAY(R.string.recency_today), YESTERDAY(R.string.recency_yesterday), THIS_WEEK(R.string.recency_this_week),
    LAST_WEEK(R.string.recency_last_week), THIS_MONTH(R.string.recency_this_month), LAST_MONTH(R.string.recency_last_month),
    THIS_YEAR(R.string.recency_this_year), OLDER(R.string.recency_older);

    companion object {
        fun of(time: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): RecencyBucket {
            val day = Instant.ofEpochMilli(time).atZone(zone).toLocalDate()
            val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
            val between = ChronoUnit.DAYS.between(day, today)
            if (between <= 0) return TODAY
            if (between == 1L) return YESTERDAY
            if (between < 7) return THIS_WEEK
            if (between < 14) return LAST_WEEK
            if (day.year == today.year && day.month == today.month) return THIS_MONTH
            val lastMonth: LocalDate = today.minusMonths(1)
            if (day.year == lastMonth.year && day.month == lastMonth.month) return LAST_MONTH
            return if (day.year == today.year) THIS_YEAR else OLDER
        }

        /** Groups items into buckets in display order, dropping empty ones. */
        fun <T> group(items: List<T>, now: Long, zone: ZoneId = ZoneId.systemDefault(), time: (T) -> Long): List<Pair<RecencyBucket, List<T>>> {
            val byBucket = items.groupBy { of(time(it), now, zone) }
            return entries.mapNotNull { bucket -> byBucket[bucket]?.takeIf { it.isNotEmpty() }?.let { bucket to it } }
        }
    }
}
