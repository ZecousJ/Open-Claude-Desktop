package com.claudex.mobile

import com.claudex.core.Snapshot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** Settings-only wire snapshots must invalidate state without relying on unrelated changes. */
@OptIn(ExperimentalCoroutinesApi::class)
class SnapshotSettingsTest {
    @After fun clearCodec() { WireCodec.clear() }

    private fun wire(instructions: Any? = null): JSONObject {
        val settings = JSONObject()
        if (instructions != null) settings.put("instructions", instructions)
        val conversation = JSONObject().put("id", "same-conversation").put("title", "Same conversation")
            .put("createdAt", 1).put("updatedAt", 1).put("turns", JSONArray())
        return JSONObject().put("settings", settings).put("conversations", JSONArray().put(conversation))
    }

    @Test fun instructionsOnlySnapshotEmitsAndResetClearsWithoutCodecOrdering() = runTest {
        val initial = WireCodec.snapshot(wire("A"), null)
        val updated = WireCodec.snapshot(wire("B"), null)
        assertEquals("Only instructions differ", initial.copy(instructions = "B"), updated)
        val state = MutableStateFlow(initial)
        val observed = mutableListOf<String>()
        val observer = launch { state.collect { observed += it.instructions } }
        runCurrent()
        state.value = updated
        runCurrent()
        state.value = WireCodec.snapshot(wire("B"), null)
        runCurrent()
        assertEquals("Equal settings snapshots remain deduplicated", listOf("A", "B"), observed)
        // Reset before clearing the legacy codec cache, matching the observed session race.
        assertEquals("B", WireCodec.rawSettings?.optString("instructions"))
        state.value = Snapshot()
        runCurrent()
        assertEquals(listOf("A", "B", ""), observed)
        observer.cancel()
    }

    @Test fun absentNullAndExplicitEmptyInstructionsDecodeAsEmpty() {
        for (value in listOf(null, JSONObject.NULL, "")) {
            assertEquals("", WireCodec.snapshot(wire(value), null).instructions)
        }
    }

    @Test fun instructionsAreImmutableAndSurviveUnrelatedSnapshotCopies() {
        assertEquals("null", WireCodec.snapshot(wire("null"), null).instructions)
        val accountA = WireCodec.snapshot(wire("Account A instructions"), null)
        val accountB = WireCodec.snapshot(wire("Account B instructions"), null)
        WireCodec.clear()
        assertEquals("Account A instructions", accountA.instructions)
        assertEquals("Account B instructions", accountB.instructions)
        assertEquals(accountA.instructions, accountA.copy(replyFeedback = mapOf("fixture" to "up")).instructions)
        assertEquals("", Snapshot().instructions)
    }
}
