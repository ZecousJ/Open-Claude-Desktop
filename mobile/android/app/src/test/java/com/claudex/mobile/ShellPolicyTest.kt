package com.claudex.mobile

import com.claudex.core.Conversation
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals

class ShellPolicyTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private fun at(y: Int, m: Int, d: Int) = LocalDateTime.of(y, m, d, 12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()

    @Test fun recencyBucketsFollowTheOfficialRules() {
        val now = at(2026, 10, 12)
        assertEquals(RecencyBucket.TODAY, RecencyBucket.of(at(2026, 10, 12), now, zone))
        assertEquals(RecencyBucket.TODAY, RecencyBucket.of(at(2026, 10, 13), now, zone))
        assertEquals(RecencyBucket.YESTERDAY, RecencyBucket.of(at(2026, 10, 11), now, zone))
        assertEquals(RecencyBucket.THIS_WEEK, RecencyBucket.of(at(2026, 10, 6), now, zone))
        assertEquals(RecencyBucket.LAST_WEEK, RecencyBucket.of(at(2026, 9, 29), now, zone))
        assertEquals(RecencyBucket.LAST_MONTH, RecencyBucket.of(at(2026, 9, 28), now, zone))
        assertEquals(RecencyBucket.THIS_YEAR, RecencyBucket.of(at(2026, 8, 1), now, zone))
        assertEquals(RecencyBucket.OLDER, RecencyBucket.of(at(2025, 12, 31), now, zone))
        // 14+ days ago but still this month
        assertEquals(RecencyBucket.THIS_MONTH, RecencyBucket.of(at(2026, 10, 1), at(2026, 10, 20), zone))
    }

    @Test fun groupsKeepDisplayOrderAndDropEmptyBuckets() {
        val now = at(2026, 10, 12)
        val groups = RecencyBucket.group(listOf(at(2025, 1, 1), at(2026, 10, 12), at(2026, 10, 11)), now, zone) { it }
        assertEquals(listOf(RecencyBucket.TODAY, RecencyBucket.YESTERDAY, RecencyBucket.OLDER), groups.map { it.first })
    }

    @Test fun drawerSectionsSplitPinnedAndFoldRecentsAfterFive() {
        val chats = (1..8).map { Conversation("c$it", "t$it", providerId = "p", model = "m", updatedAt = it.toLong(), pinned = it == 3, archived = it == 8) }
        val sections = SidebarPolicy.sections(chats)
        assertEquals(listOf("c3"), sections.pinned.map { it.id })
        assertEquals(listOf("c7", "c6", "c5", "c4", "c2", "c1"), sections.recents.map { it.id })
        assertEquals(true, SidebarPolicy.collapsible(sections.recents))
        assertEquals(5, SidebarPolicy.visibleRecents(sections.recents, expanded = false).size)
        assertEquals(6, SidebarPolicy.visibleRecents(sections.recents, expanded = true).size)
    }
}
