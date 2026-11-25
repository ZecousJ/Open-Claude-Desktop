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
    @Test fun binaryRenameAndHeaderOnlyDiffsAreNamed() {
        assertTrue(diffFileFace("diff --git a/a.bin b/a.bin\nBinary files a/a.bin and b/a.bin differ").binary)
        assertTrue(diffFileFace("GIT binary patch").binary)
        val renamed = diffFileFace("diff --git a/old b/new\nrename from \"old name\"\nrename to new")
        assertEquals("old name", renamed.renamedFrom)
        assertTrue(renamed.hidden)
        assertFalse(renamed.binary)
        val edited = diffFileFace("diff --git a/old b/new\nrename from old\n@@ -1 +1 @@\n-a\n+b")
        assertEquals("old", edited.renamedFrom)
        assertFalse(edited.hidden)
        assertTrue(diffFileFace("diff --git a/a b/a\nindex 1..2").hidden)
        assertFalse(diffFileFace("plain text").hidden)
        assertFalse(diffFileFace("plain text").binary)
    }

    @Test fun collapsedContextNamesTheSideAndTheHiddenCount() {
        val both = diffExpand("@@ -10,2 +10,2 @@\n a\n b", 20)
        assertEquals(18, both?.hidden)
        assertEquals(DiffExpandWay.ALL, both?.way)
        val down = diffExpand("@@ -1,2 +1,2 @@\n a\n b", 10)
        assertEquals(8, down?.hidden)
        assertEquals(DiffExpandWay.DOWN, down?.way)
        val up = diffExpand("@@ -8,3 +8,3 @@\n a\n b\n c", 10)
        assertEquals(7, up?.hidden)
        assertEquals(DiffExpandWay.UP, up?.way)
        assertNull(diffExpand("@@ -1,10 +1,10 @@\n a", 10))
        assertNull(diffExpand("@@ -1,3 +0,0 @@", 5))
        assertEquals("src/A.kt", diffNewPath("diff --git a/src/A.kt b/src/A.kt\n+++ b/src/A.kt"))
        assertEquals("old", diffNewPath("diff --git a/old b/old\n--- a/old\n+++ /dev/null"))
    }
    @Test fun scopeTitleUsesTheBaseAndTheCheckedOutBranch() {
        val ends = diffScopeEnds(" main ", " feature ")
        assertEquals("main", ends?.base)
        assertEquals("feature", ends?.head)
        assertNull(diffScopeEnds(" ", "feature"))
        assertEquals(listOf("develop"), diffCompareBranches(listOf(" feature ", "develop", "develop", ""), "feature"))
        val commits = diffCommits(org.json.JSONArray()
            .put(org.json.JSONObject().put("sha", "abc").put("shortSha", "abc").put("subject", " Fix "))
            .put(org.json.JSONObject().put("sha", "def").put("shortSha", "def").put("subject", " ")))
        assertEquals("Fix", commits[0].subject)
        assertNull(commits[1].subject)
        assertNull(diffScopeFacts(org.json.JSONObject().put("base", "main")).first)
    }
    @Test fun addedFileCanStartAtZeroOldLines() {
        val rows = presentDiff("@@ -0,0 +1,2 @@\n+one\n+two")
        assertEquals(listOf(1, 2), rows.drop(1).map { it.after })
        assertTrue(rows.all { it.before == null })
    }
}
