package com.claudex.mobile

import com.claudex.core.*
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class SearchLibraryPolicyTest {
    @Test fun namesPathsAndContentAreSearchable() {
        val file = GeneratedFile("file", "pelican.html", "ready", content = "synthetic page", path = "output/pelican.html")
        val c = Conversation("c", "unrelated", providerId = "synthetic", model = "synthetic", turns = listOf(Turn("t", "draw", items = listOf(Item("i", "agentMessage", "reply", generatedFiles = listOf(file))))))
        assertTrue(SearchLibraryPolicy.matches(c, "PELICAN"))
        assertTrue(SearchLibraryPolicy.matches(c, "synthetic page"))
        assertFalse(SearchLibraryPolicy.matches(c, "absent"))
    }
    @Test fun smallFilesRetainTheirActualSize() {
        assertEquals("0 B", SearchLibraryPolicy.sizeLabel(0))
        assertEquals("17 B", SearchLibraryPolicy.sizeLabel(17))
        assertEquals("1.0 KB", SearchLibraryPolicy.sizeLabel(1024))
    }
    @Test fun codeFencesAreNotInventedLibraryFiles() {
        val raw = JSONObject().put("conversations", org.json.JSONArray().put(JSONObject().put("id", "c").put("title", "test").put("mode", "chat").put("providerId", "synthetic").put("model", "synthetic").put("turns", org.json.JSONArray().put(JSONObject().put("id", "t").put("prompt", "test").put("status", "completed").put("items", org.json.JSONArray().put(JSONObject().put("id", "i").put("type", "agentMessage").put("text", "```html\n<p>only a code example</p>\n```")))))))
        assertTrue(WireCodec.snapshot(raw, null).artifacts.isEmpty())
    }
}
