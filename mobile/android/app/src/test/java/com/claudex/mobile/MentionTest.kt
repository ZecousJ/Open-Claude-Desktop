package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MentionTest {
    @Test fun querySitsAfterAnAtAndAChosenPathReplacesIt() {
        assertNull(mentionAt("hello", 5))
        assertEquals("src", mentionAt("see @src", 8)?.query)
        assertNull(mentionAt("see @src", 3))
        assertEquals("", mentionAt("@", 1)?.query)
        val inserted = insertMention("see @src", MentionMatch(4, "src"), 8, "src/App.kt")
        assertEquals("see @src/App.kt ", inserted.first)
        assertEquals(16, inserted.second)
        assertEquals("@\"my file\"", mentionToken("my file"))
        val files = mentionFiles(JSONArray().put(JSONObject().put("path", "src/App.kt").put("kind", "file")).put(JSONObject().put("kind", "folder")))
        assertEquals(listOf("src/App.kt"), files.map { it.path })
        assertFalse(files.single().folder)
    }
}
