package com.claudex.mobile

import com.claudex.core.Conversation
import java.util.Locale

internal object SearchLibraryPolicy {
    fun matches(c: Conversation, query: String): Boolean {
        val q = query.trim()
        if (q.isEmpty()) return true
        return sequenceOf(c.title).plus(c.turns.asSequence().flatMap { turn ->
            sequenceOf(turn.prompt).plus(turn.attachments.asSequence().flatMap { sequenceOf(it.name, it.path) })
                .plus(turn.items.asSequence().flatMap { item ->
                    sequenceOf(item.text).plus(item.changes.asSequence().flatMap { sequenceOf(it.path, it.diff) })
                        .plus(item.generatedFiles.asSequence().flatMap { sequenceOf(it.name, it.path, it.content.orEmpty()) })
                })
        }).any { it.contains(q, ignoreCase = true) }
    }
    fun sizeLabel(bytes: Long): String = when {
        bytes < 1024 -> "${bytes.coerceAtLeast(0)} B"
        bytes < 1024 * 1024 -> String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0)
        else -> String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024.0))
    }
}
