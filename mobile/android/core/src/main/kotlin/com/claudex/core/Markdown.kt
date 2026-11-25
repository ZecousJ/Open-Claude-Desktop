package com.claudex.core

import java.net.URI

data class MarkdownBlock(val kind: String, val text: String = "", val level: Int = 0, val label: String = "", val rows: List<List<String>> = emptyList())
data class MarkdownSpan(val text: String, val kind: String = "text", val url: String? = null)

/** Deliberately non-executable Markdown subset; raw HTML remains visible text. */
object Markdown {
    private val heading = Regex("^(#{1,6})\\s+(.+)$")
    private val list = Regex("^(\\s*)([-+*]|\\d+[.)])\\s+(.+)$")
    private val fence = Regex("^\\s{0,3}(`{3,}|~{3,})(.*)$")
    private val delimiter = Regex("^:?-{3,}:?$")
    private val inline = Regex("!\\[([^]\\n]*)]\\(([^\\s)]+)\\)|\\[([^]\\n]+)]\\(([^\\s)]+)\\)|`([^`\\n]+)`|\\*\\*([^*\\n]+)\\*\\*|__([^_\\n]+)__|\\*([^*\\n]+)\\*|_([^_\\n]+)_")
    fun safeUrl(value: String): String? = runCatching {
        require(value.length <= 4096 && value.none { it <= ' ' || it == '\u007f' || it == '\\' })
        val uri = URI(value)
        require(uri.scheme?.lowercase() in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.userInfo == null)
        value
    }.getOrNull()
    fun spans(text: String): List<MarkdownSpan> {
        val result = mutableListOf<MarkdownSpan>(); var offset = 0
        inline.findAll(text).forEach { m ->
            if (m.range.first > offset) result += MarkdownSpan(text.substring(offset, m.range.first))
            val g = m.groupValues
            result += when {
                m.value.startsWith("!") -> MarkdownSpan(g[1].ifBlank { CoreText.of(CoreMessage.IMAGE_ALT) }, "image", safeUrl(g[2]))
                m.value.startsWith("[") -> MarkdownSpan(g[3], "link", safeUrl(g[4]))
                g[5].isNotEmpty() -> MarkdownSpan(g[5], "code")
                g[6].isNotEmpty() || g[7].isNotEmpty() -> MarkdownSpan(g[6].ifEmpty { g[7] }, "bold")
                else -> MarkdownSpan(g[8].ifEmpty { g[9] }, "italic")
            }
            offset = m.range.last + 1
        }
        if (offset < text.length) result += MarkdownSpan(text.substring(offset))
        return result
    }
    private fun cells(line: String) = line.trim().removePrefix("|").removeSuffix("|").split(Regex("(?<!\\\\)\\|")).map { it.trim().replace("\\|", "|") }
    fun blocks(source: String): List<MarkdownBlock> {
        val lines = source.replace("\r\n", "\n").lines(); val result = mutableListOf<MarkdownBlock>(); var i = 0
        fun startsBlock(line: String) = heading.matches(line) || list.matches(line) || fence.matches(line) || line.trimStart().startsWith(">") || line.trim() == "$$"
        while (i < lines.size) {
            val line = lines[i]; val trim = line.trim()
            if (trim.isEmpty()) { i++; continue }
            val f = fence.matchEntire(line)
            if (f != null) {
                val marker = f.groupValues[1]; val language = f.groupValues[2].trim(); val content = mutableListOf<String>(); i++
                while (i < lines.size && !(lines[i].trim().length >= marker.length && lines[i].trim().all { it == marker[0] })) { content += lines[i++ ] }
                if (i < lines.size) i++
                result += MarkdownBlock("code", content.joinToString("\n"), label = language); continue
            }
            if (trim == "$$") {
                val content = mutableListOf<String>(); i++
                while (i < lines.size && lines[i].trim() != "$$") content += lines[i++ ]
                if (i < lines.size) i++
                result += MarkdownBlock("math", content.joinToString("\n")); continue
            }
            val h = heading.matchEntire(line)
            if (h != null) { result += MarkdownBlock("heading", h.groupValues[2], h.groupValues[1].length); i++; continue }
            val l = list.matchEntire(line)
            if (l != null) { result += MarkdownBlock("list", l.groupValues[3], (l.groupValues[1].length / 2).coerceAtMost(6), if (l.groupValues[2].first().isDigit()) l.groupValues[2] else "•"); i++; continue }
            if (trim.startsWith(">")) { result += MarkdownBlock("quote", trim.removePrefix(">").trimStart()); i++; continue }
            if (trim in listOf("---", "***", "___")) { result += MarkdownBlock("rule"); i++; continue }
            if ('|' in line && i + 1 < lines.size && cells(lines[i + 1]).let { it.size == cells(line).size && it.all(delimiter::matches) }) {
                val rows = mutableListOf(cells(line)); i += 2
                while (i < lines.size && lines[i].isNotBlank() && '|' in lines[i]) rows += cells(lines[i++ ])
                result += MarkdownBlock("table", rows = rows); continue
            }
            val paragraph = mutableListOf(line); i++
            while (i < lines.size && lines[i].isNotBlank() && !startsBlock(lines[i]) && !(i + 1 < lines.size && '|' in lines[i] && cells(lines[i + 1]).all(delimiter::matches))) paragraph += lines[i++ ]
            result += MarkdownBlock("paragraph", paragraph.joinToString("\n"))
        }
        return result
    }
}
