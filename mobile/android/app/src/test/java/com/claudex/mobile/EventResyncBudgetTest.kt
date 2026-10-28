package com.claudex.mobile

import com.claudex.core.EventCursor
import kotlin.test.*

class EventResyncBudgetTest {
    @Test fun repeatedSnapshotFailuresStopAfterThreeReads() {
        val budget = EventResyncBudget()
        repeat(3) { assertTrue(budget.canRead()); budget.failed() }
        repeat(20) { assertFalse(budget.canRead()) }
        budget.succeeded()
        assertTrue(budget.canRead())
    }
    @Test fun acceptedGapDoesNotRequestTheSameMissingReplayAgain() {
        val cursor = EventCursor()
        cursor.reset(10)
        assertEquals(EventCursor.Decision.RESYNC, cursor.receive(15))
        // Match web: advance the received cursor, deliver the event and request a snapshot.
        cursor.reset(15)
        assertEquals(EventCursor.Decision.DUPLICATE, cursor.receive(15))
        assertEquals(EventCursor.Decision.APPLY, cursor.receive(16))
        assertEquals(16L, cursor.lastSequence)
    }
    @Test fun snapshotWatermarkSkipsCoveredReplayWithoutMovingCursorBackwards() {
        assertEquals(25L, SnapshotEventSequence.covered(15, SnapshotEventSequence.parse("25")))
        assertEquals(25L, SnapshotEventSequence.covered(25, 15))
        assertEquals(15L, SnapshotEventSequence.covered(15, null))
        listOf("-1", "9007199254740992", "1.5", "invalid").forEach { assertNull(SnapshotEventSequence.parse(it)) }
    }
}
