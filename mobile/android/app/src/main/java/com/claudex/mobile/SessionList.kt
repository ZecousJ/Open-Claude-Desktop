package com.claudex.mobile

import androidx.annotation.StringRes
import androidx.compose.ui.graphics.vector.ImageVector
import com.claudex.core.*
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The session list's filters, in the official order: All, Working, Needs input, Ready for
 * review, Completed, Archived. Each session is in one bucket, decided in the order the live session list decides
 * it (`ZM`): archived, then waiting on an approval, then running, then a pull request waiting for a reviewer,
 * then finished.
 */
internal enum class SessionFilter(@StringRes val label: Int) {
    ALL(R.string.session_filter_all), WORKING(R.string.session_filter_working), NEEDS_INPUT(R.string.session_filter_needs_input),
    READY_FOR_REVIEW(R.string.session_filter_ready_for_review), COMPLETED(R.string.session_filter_completed), ARCHIVED(R.string.session_filter_archived);

    /** The menu glyph of each filter: filter, spinner, warningFilled, prOpen, check, archive. */
    val icon: ImageVector get() = when (this) {
        ALL -> AppGlyphs.filter; WORKING -> AppGlyphs.spinner; NEEDS_INPUT -> AppGlyphs.warningFilled
        READY_FOR_REVIEW -> AppGlyphs.prOpen; COMPLETED -> AppGlyphs.check; ARCHIVED -> AppGlyphs.archive
    }
}

internal object SessionList {
    /** A turn is still running. */
    fun working(c: Conversation): Boolean = c.turns.lastOrNull()?.status == TurnStatus.IN_PROGRESS

    /** [waiting] holds the conversations with an open approval, [review] the ones whose pull request waits for a reviewer. */
    fun matches(filter: SessionFilter, c: Conversation, waiting: Set<String>, review: Set<String>): Boolean {
        if (filter == SessionFilter.ARCHIVED) return c.archived
        if (c.archived) return false
        val needsInput = c.id in waiting
        val running = !needsInput && working(c)
        val reviewing = !needsInput && !running && c.id in review
        return when (filter) {
            SessionFilter.ALL -> true
            SessionFilter.WORKING -> running
            SessionFilter.NEEDS_INPUT -> needsInput
            SessionFilter.READY_FOR_REVIEW -> reviewing
            SessionFilter.COMPLETED -> !needsInput && !reviewing && c.turns.lastOrNull()?.status == TurnStatus.COMPLETED
            SessionFilter.ARCHIVED -> false
        }
    }

    /** Cowork tasks make no pull requests, so their menu has no Ready for review. */
    val coworkFilters: List<SessionFilter> = SessionFilter.entries.filter { it != SessionFilter.READY_FOR_REVIEW }
}

/** A pull request on github.com, named as the service asks about it. */
internal data class PullRef(val repository: String, val number: Int) {
    val key: String get() = "${repository.lowercase()}#$number"
}

/** One answer of `POST /api/v1/claudex/web/github/pull/states`. */
internal data class PullVerdict(val key: String, val awaitsReview: Boolean)

/**
 * Ready for review: a finished Code session whose pull request is open, not a draft and not yet answered by a
 * reviewer (the live list counts such a request as `awaitsReview`). The session's own request is the last one
 * its reply tagged `<pr-created>` (shared/pull-request.ts `sessionPullRequest`); a plain link in a reply is not.
 */
internal object SessionReviewPolicy {
    const val PATH = "/api/v1/claudex/web/github/pull/states"
    /** The service answers at most this many requests at a time. */
    const val MAX_ASKED = 40
    const val MAX_AGE_MS = 60_000L
    private val tagged = Regex("<pr-created>\\s*(https?://[^\\s<]+?)\\s*</pr-created>", RegexOption.IGNORE_CASE)
    private val address = Regex("^https://github\\.com/([^/\\s]+)/([^/\\s]+)/pull/(\\d+)")

    fun parse(url: String): PullRef? {
        val m = address.find(url.trim()) ?: return null
        val number = m.groupValues[3].toIntOrNull()?.takeIf { it in 1..999_999_999 } ?: return null
        return PullRef("${m.groupValues[1]}/${m.groupValues[2]}", number)
    }

    fun pullRequest(c: Conversation): PullRef? {
        for (turn in c.turns.asReversed()) for (item in turn.items.asReversed()) {
            if (item.type != "agentMessage" || item.text.isEmpty()) continue
            for (match in tagged.findAll(item.text).toList().asReversed()) parse(match.groupValues[1])?.let { return it }
        }
        return null
    }

    /** The sessions worth asking about: Code sessions that are not archived and not running, newest first, with their request. */
    fun candidates(conversations: List<Conversation>): Map<String, PullRef> {
        val found = LinkedHashMap<String, PullRef>()
        for (c in conversations.filter { it.mode == Mode.CODE && !it.archived && !SessionList.working(it) }.sortedByDescending { it.updatedAt }) {
            if (found.size >= MAX_ASKED) break
            pullRequest(c)?.let { found[c.id] = it }
        }
        return found
    }

    fun request(refs: Collection<PullRef>): org.json.JSONObject =
        org.json.JSONObject().put("pulls", org.json.JSONArray(refs.map { org.json.JSONObject().put("repo", it.repository).put("number", it.number) }))

    fun verdicts(response: org.json.JSONObject): List<PullVerdict> {
        val states = response.optJSONObject("data")?.optJSONArray("states") ?: return emptyList()
        return (0 until states.length()).mapNotNull { i ->
            val s = states.optJSONObject(i) ?: return@mapNotNull null
            val repository = s.optString("repository"); val number = s.optInt("number")
            if (repository.isBlank() || number < 1) null else PullVerdict(PullRef(repository, number).key, s.optBoolean("awaits_review"))
        }
    }
}

/**
 * The sessions waiting for a reviewer, kept for the list. A verdict is asked again when it is older than a
 * minute or [force] is set (pull to refresh); a failed question keeps the last answer, since GitHub may simply
 * not be connected or reachable.
 */
internal class SessionReview(private val ask: suspend (List<PullRef>) -> List<PullVerdict>?, private val now: () -> Long = System::currentTimeMillis) {
    val ready = MutableStateFlow<Set<String>>(emptySet())
    private val verdicts = HashMap<String, Pair<Boolean, Long>>()

    suspend fun load(conversations: List<Conversation>, force: Boolean = false) {
        val candidates = SessionReviewPolicy.candidates(conversations)
        val stale = candidates.values.distinctBy { it.key }.filter { force || (verdicts[it.key]?.second ?: Long.MIN_VALUE) + SessionReviewPolicy.MAX_AGE_MS <= now() }
        if (stale.isNotEmpty()) {
            val answered = ask(stale)
            if (answered != null) {
                val at = now(); val seen = answered.map { it.key }.toSet()
                answered.forEach { verdicts[it.key] = it.awaitsReview to at }
                // A request GitHub no longer answers for (gone, private) is no longer waiting.
                stale.filter { it.key !in seen }.forEach { verdicts[it.key] = false to at }
            }
        }
        ready.value = candidates.filterValues { verdicts[it.key]?.first == true }.keys.toSet()
    }

    fun clear() { verdicts.clear(); ready.value = emptySet() }
}
