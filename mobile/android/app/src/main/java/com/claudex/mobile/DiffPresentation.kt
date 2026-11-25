package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject

/** Presentation only: reads unified diff without modifying or executing its contents. */
internal data class DiffLine(val text: String, val before: Int?, val after: Int?, val kind: Char)

/** A file whose diff is not a list of text lines: a binary file, a pure rename, or a change with no hunks. */
internal data class DiffFileFace(val binary: Boolean, val hidden: Boolean, val renamedFrom: String?)

internal fun diffFileFace(diff: String): DiffFileFace {
    val lines = diff.lines()
    if (lines.any { it.startsWith("Binary files ") || it == "GIT binary patch" }) return DiffFileFace(binary = true, hidden = true, renamedFrom = null)
    val from = lines.firstOrNull { it.startsWith("rename from ") }?.removePrefix("rename from ")?.let(::gitPath)?.takeIf { it.isNotEmpty() }
    val hunks = lines.any { it.startsWith("@@") }
    val header = lines.any { it.startsWith("diff --git ") }
    return DiffFileFace(binary = false, hidden = header && !hunks, renamedFrom = from)
}

/** Lines of a file that the current hunks do not show, and which side they sit on. */
internal enum class DiffExpandWay { UP, DOWN, ALL }
internal data class DiffExpand(val hidden: Int, val way: DiffExpandWay)

internal fun diffExpand(diff: String, lineCount: Int?): DiffExpand? {
    if (lineCount == null || lineCount <= 0) return null
    val header = Regex("^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,(\\d+))? @@")
    var first = Int.MAX_VALUE
    var last = 0
    var any = false
    for (line in diff.lineSequence()) {
        val match = header.find(line) ?: continue
        val start = match.groupValues[1].toIntOrNull() ?: continue
        val count = match.groupValues[2].toIntOrNull() ?: 1
        any = true
        if (count <= 0) continue
        val end = start + count - 1
        if (start < first) first = start
        if (end > last) last = end
    }
    if (!any || first == Int.MAX_VALUE) return null
    val above = first > 1
    val below = last < lineCount
    val hidden = (if (above) first - 1 else 0) + (if (below) lineCount - last else 0)
    if (hidden <= 0) return null
    val way = when {
        above && below -> DiffExpandWay.ALL
        above -> DiffExpandWay.UP
        else -> DiffExpandWay.DOWN
    }
    return DiffExpand(hidden, way)
}

/** One commit the working tree lists for the scope menu. */
internal data class DiffCommit(val sha: String, val shortSha: String, val subject: String?)

/** The base and branch the scope title compares, when both were returned. */
internal data class DiffScopeEnds(val base: String, val head: String)

internal fun diffScopeEnds(base: String?, branch: String?): DiffScopeEnds? {
    val left = base?.trim().orEmpty()
    val right = branch?.trim().orEmpty()
    if (left.isEmpty() || right.isEmpty()) return null
    return DiffScopeEnds(left, right)
}

/** Branches offered under Compare against. The checked-out branch is already the right side of the title. */
internal fun diffCompareBranches(names: List<String>, checkedOut: String?): List<String> {
    val current = checkedOut?.trim().orEmpty()
    return names.map { it.trim() }.filter { it.isNotEmpty() && it != current }.distinct()
}

internal fun diffCommitSubject(raw: String?): String? = raw?.trim()?.takeIf { it.isNotEmpty() }

/** Commits from a working-tree answer, newest first, skipping rows with no id. */
internal fun diffCommits(array: JSONArray?): List<DiffCommit> {
    if (array == null) return emptyList()
    val commits = ArrayList<DiffCommit>(array.length())
    for (index in 0 until array.length()) {
        val row = array.optJSONObject(index) ?: continue
        val sha = row.optString("sha").trim()
        val shortSha = row.optString("shortSha").trim().ifEmpty { sha.take(7) }
        if (sha.isEmpty() || shortSha.isEmpty()) continue
        commits += DiffCommit(sha, shortSha, diffCommitSubject(row.optString("subject")))
    }
    return commits
}

internal fun diffScopeFacts(json: JSONObject?): Pair<DiffScopeEnds?, List<DiffCommit>> {
    val commits = diffCommits(json?.optJSONArray("commits"))
    return diffScopeEnds(jsonText(json, "base"), jsonText(json, "branch")) to commits
}

private fun jsonText(json: JSONObject?, key: String): String? {
    if (json == null || json.isNull(key)) return null
    return json.optString(key).trim().takeIf { it.isNotEmpty() }
}

/** The path a unified diff writes, from its new side, else its old side. */
internal fun diffNewPath(diff: String): String? {
    val line = diff.lineSequence().firstOrNull { it.startsWith("+++ b/") } ?: diff.lineSequence().firstOrNull { it.startsWith("--- a/") } ?: return null
    val raw = line.removePrefix("+++ b/").removePrefix("--- a/").substringBefore('\t')
    if (raw == "/dev/null") return null
    return gitPath(raw)
}

private fun gitPath(raw: String): String? {
    val value = raw.trim()
    if (value.isEmpty()) return null
    return if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) value.substring(1, value.lastIndex) else value
}
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
