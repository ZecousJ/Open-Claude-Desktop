package com.claudex.mobile

import org.junit.Assert.*
import org.junit.Test

class DiffPresentationTest {
    @Test fun preservesLineNumbersAndCountsAcrossHunks() {
        val rows = presentDiff("--- a/a.kt\n+++ b/a.kt\n@@ -10,2 +10,3 @@\n keep\n-old\n+new\n+extra\n@@ -25 +26 @@\n-last\n+last2")
        assertEquals(3, rows.count { it.kind == '+' })
        assertEquals(2, rows.count { it.kind == '-' })
        assertEquals(10, rows[3].before); assertEquals(10, rows[3].after)
        assertEquals(11, rows[4].before); assertNull(rows[4].after)
        assertNull(rows[5].before); assertEquals(11, rows[5].after)
        assertEquals(12, rows[6].after); assertEquals(26, rows.last().after)
    }
    @Test fun fileHeadersAndMissingNewlineAreNotChanges() {
        val rows = presentDiff("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file")
        assertEquals(1, rows.count { it.kind == '+' }); assertEquals(1, rows.count { it.kind == '-' })
        assertNull(rows.last().after)
    }
    @Test fun emptyOrNonUnifiedContentIsVisibleWithoutInventedCounts() {
        assertEquals("raw backend content", presentDiff("raw backend content").single().text)
        assertTrue(presentDiff("").all { it.before == null && it.after == null })
        assertTrue(presentDiff("+not a unified diff").all { it.kind == '@' })
    }
    @Test fun malformedLargeLineNumbersRemainReadable() {
        val rows = presentDiff("@@ -999999999999999999999999 +1 @@\n+content")
        assertEquals(2, rows.size); assertTrue(rows.all { it.before == null && it.after == null })
        assertEquals("+content", rows.last().text)
    }
    @Test fun addedFileCanStartAtZeroOldLines() {
        val rows = presentDiff("@@ -0,0 +1,2 @@\n+one\n+two")
        assertEquals(listOf(1, 2), rows.drop(1).map { it.after })
        assertTrue(rows.all { it.before == null })
    }
}
