package com.claudex.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CoworkMemoryTest {
    @Test fun onlyPlainMarkdownPathsAreKept() {
        assertTrue(CoworkMemory.validKey("MEMORY.md"))
        assertTrue(CoworkMemory.validKey("notes/work.md"))
        assertFalse(CoworkMemory.validKey("../secret.md"))
        assertFalse(CoworkMemory.validKey("notes/*.md"))
        assertFalse(CoworkMemory.validKey("notes.txt"))
        val view = CoworkMemory.parse(JSONObject().put("revision", "2").put("epoch", "1").put("entries", JSONObject().put("MEMORY.md", "index").put("../bad.md", "no")))
        assertEquals(listOf("MEMORY.md"), view.files.map { it.path })
        assertEquals("index", view.files.single().content)
    }
}
