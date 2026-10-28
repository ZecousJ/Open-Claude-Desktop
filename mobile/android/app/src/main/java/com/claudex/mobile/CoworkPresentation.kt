package com.claudex.mobile

import com.claudex.core.Conversation
import com.claudex.core.Mode

internal object CoworkPresentation {
    fun tasks(conversations: List<Conversation>): List<Conversation> =
        conversations.filter { it.mode == Mode.COWORK && !it.archived }.sortedByDescending { it.updatedAt }

    fun staticPreview(name: String, mime: String, language: String): Boolean =
        mime in setOf("text/html", "image/svg+xml") || language.lowercase() in setOf("html", "svg") ||
            name.endsWith(".html", true) || name.endsWith(".htm", true) || name.endsWith(".svg", true)
}
