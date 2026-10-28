package com.claudex.mobile

import com.claudex.core.Conversation
import com.claudex.core.Mode
import org.junit.Assert.*
import org.junit.Test

class CoworkPresentationTest {
    @Test fun coworkExcludesChatAndCodeAndOrdersNewestFirst() {
        fun c(id: String, mode: Mode, updated: Long) = Conversation(id, id, mode, "synthetic", "synthetic", updatedAt = updated)
        val all = listOf(c("chat", Mode.CHAT, 99), c("old", Mode.COWORK, 1), c("code", Mode.CODE, 98), c("new", Mode.COWORK, 2))
        assertEquals(listOf("new", "old"), CoworkPresentation.tasks(all).map { it.id })
        val archived = Conversation("archived", "archived", Mode.COWORK, "synthetic", "synthetic", archived = true, updatedAt = 3)
        assertEquals(listOf("new", "old"), CoworkPresentation.tasks(all + archived).map { it.id })
    }
    @Test fun onlyHtmlAndSvgUseStaticPreview() {
        assertTrue(CoworkPresentation.staticPreview("index.HTML", "application/octet-stream", ""))
        assertTrue(CoworkPresentation.staticPreview("drawing", "image/svg+xml", ""))
        assertTrue(CoworkPresentation.staticPreview("page", "text/plain", "html"))
        assertFalse(CoworkPresentation.staticPreview("program.js", "application/javascript", "javascript"))
        assertFalse(CoworkPresentation.staticPreview("note.md", "text/markdown", "markdown"))
    }
}
