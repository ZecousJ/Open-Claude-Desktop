package com.claudex.mobile

import org.junit.Assert.*
import org.junit.Test

class StatusPresentationTest {
    @Test fun verifiedWindowAndPreviousPageNeverSwitchToDayQuery() {
        assertEquals("/api/v1/claudex/status?hours=24&step=10", StatusPresentation.path(null))
        assertEquals("2026-10-02T23:50", StatusPresentation.previous("2026-10-03T00:00"))
        assertTrue(StatusPresentation.path("2026-10-02T23:50").endsWith("end=2026-10-02T23%3A50"))
        assertNull(StatusPresentation.previous("invalid"))
    }
    @Test fun nextPageReturnsToCurrentAndMissingChecksNeverLookHealthy() {
        val now = java.time.Instant.parse("2026-10-04T00:00:00Z").toEpochMilli()
        assertNull(StatusPresentation.next("2026-10-03T08:00", "Asia/Shanghai", now))
        assertEquals("2026-10-02T08:00", StatusPresentation.next("2026-10-01T08:00", "Asia/Shanghai", now))
        val none = UserText.get(R.string.claudex_status_no_data)
        assertEquals(none, StatusPresentation.uptime(null))
        assertEquals(none, StatusPresentation.uptime("100"))
        assertEquals(none, StatusPresentation.uptime(Double.NaN))
        assertTrue(StatusPresentation.uptime(0).startsWith("0"))
        assertEquals(R.string.claudex_status_incident_resolved, StatusPresentation.incidentRes("resolved"))
        assertEquals(R.string.claudex_status_level_outage, StatusPresentation.labelRes("outage"))
    }
    @Test fun windowRangeReadsAsLocalDates() {
        assertEquals("10月2日 19:10 — 10月3日 19:00", StatusPresentation.range("2026-10-02T19:10", "2026-10-03T19:00"))
        assertEquals("a — b", StatusPresentation.range("a", "b"))
    }
}
