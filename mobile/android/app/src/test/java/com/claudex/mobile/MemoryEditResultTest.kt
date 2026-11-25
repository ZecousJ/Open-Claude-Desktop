package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryEditResultTest {
    private fun doc(vararg edits: String) = JSONObject().put("content", "").put("revision", 0).put("edits", JSONArray(edits.map { JSONObject().put("id", it).put("text", it) }))

    @Test fun theServicesOutcomeIsReadWithTheStatementsThatWent() {
        val result = MemoryEditResult.from(doc("a").put("outcome", JSONObject().put("kind", "added_removed").put("removed", JSONArray(listOf("Likes tea")))), asked = true)
        assertEquals("added_removed", result.outcome.kind)
        assertEquals(listOf("Likes tea"), result.outcome.removed)
        assertNotNull(result.document)
        // The outcome is not part of the memory the screen keeps.
        assertFalse(result.document!!.has("outcome"))
    }

    @Test fun aScopeLeftWithoutMemoryHasNoDocument() {
        val result = MemoryEditResult.from(doc().put("outcome", JSONObject().put("kind", "removed").put("removed", JSONArray(listOf("x")))), asked = false)
        assertNull(result.document)
        assertEquals("removed", result.outcome.kind)
    }

    @Test fun aRefusalChangesNothingAndSaysSo() {
        assertTrue(MemoryEditOutcome("rejected").refused)
        assertTrue(MemoryEditOutcome("too_long").refused)
        assertFalse(MemoryEditOutcome("added").refused)
        assertFalse(MemoryEditOutcome("noop").refused)
    }

    @Test fun aServiceFromBeforeTheOutcomeIsWordedByWhatWasAsked() {
        assertEquals("added", MemoryEditResult.from(doc("a"), asked = true).outcome.kind)
        assertEquals("removed", MemoryEditResult.from(doc("a"), asked = false).outcome.kind)
    }
}
