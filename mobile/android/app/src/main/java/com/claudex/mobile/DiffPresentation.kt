package com.claudex.mobile

/** Presentation only: reads unified diff without modifying or executing its contents. */
internal data class DiffLine(val text: String, val before: Int?, val after: Int?, val kind: Char)
internal fun presentDiff(diff: String): List<DiffLine> {
    val hunk = Regex("^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@.*")
    var before = 0; var after = 0; var inHunk = false
    return diff.lines().map { line ->
        val match = hunk.matchEntire(line)
        when {
            match != null -> { val old = match.groupValues[1].toIntOrNull(); val new = match.groupValues[2].toIntOrNull(); inHunk = old != null && new != null; before = old ?: 0; after = new ?: 0; DiffLine(line, null, null, '@') }
            line.startsWith("diff --git") -> { inHunk = false; DiffLine(line, null, null, '@') }
            !inHunk || line.startsWith("\\ No newline") -> DiffLine(line, null, null, '@')
            line.startsWith('+') -> DiffLine(line, null, after++, '+')
            line.startsWith('-') -> DiffLine(line, before++, null, '-')
            line.startsWith(' ') -> DiffLine(line, before++, after++, ' ')
            else -> DiffLine(line, null, null, '@')
        }
    }
}
