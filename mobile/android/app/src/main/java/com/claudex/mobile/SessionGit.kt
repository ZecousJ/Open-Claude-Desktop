package com.claudex.mobile

import com.claudex.core.Conversation
import com.claudex.core.TurnStatus
import org.json.JSONObject

/**
 * What a cloud Code session knows about its repository, branch and pull requests. The runner writes them onto
 * the session (`repository`, `branch`, `gitState`, `pullRequests`, shared/session-git.ts in the main repo) and
 * they arrive in the conversation's wire metadata, so they are read from [Conversation.rawJson].
 *
 * The Code list searches the title, repository and branch (official `session_list_search_a11y`), has the sixth
 * filter "Ready for review" and the session menu's "Copy branch". The rules here are the same as the shared
 * TypeScript ones (`isReviewReady`, `sessionMatchesSearch`).
 *
 * A pull request's state is the one the runner read after the session's last turn; a request merged or closed on
 * GitHub since then is found by asking the service ([pullStates]) when the list is shown.
 */
internal object SessionGit {
    internal data class Facts(
        /** "owner/name". */
        val repository: String?,
        val branch: String?,
        val dirty: Boolean,
        val unpushed: Boolean,
        /** The newest pull request's state ("open", "draft", "queued", "merged", "closed"), if the session opened one. */
        val pullRequestState: String?,
        /** The newest pull request as "owner/name#12", the key the service answers by. */
        val pullRequestKey: String?,
    )

    private val empty = Facts(null, null, dirty = false, unpushed = false, pullRequestState = null, pullRequestKey = null)
    private val cache = object : LinkedHashMap<String, Facts>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Facts>) = size > 256
    }

    /** The session's facts; nothing when it carries none (a session started before they were recorded). */
    fun facts(rawJson: String?): Facts {
        if (rawJson.isNullOrEmpty()) return empty
        synchronized(cache) { cache[rawJson]?.let { return it } }
        val facts = runCatching { parse(JSONObject(rawJson)) }.getOrDefault(empty)
        synchronized(cache) { cache[rawJson] = facts }
        return facts
    }

    fun facts(conversation: Conversation): Facts = facts(conversation.rawJson)

    private fun parse(json: JSONObject): Facts {
        val state = json.optJSONObject("gitState")
        val pullRequests = json.optJSONArray("pullRequests")
        val latest = pullRequests?.let { if (it.length() > 0) it.optJSONObject(it.length() - 1) else null }
        val repository = latest?.optString("repository").orEmpty()
        val number = latest?.optInt("number", 0) ?: 0
        return Facts(
            repository = json.optJSONObject("repository")?.optString("fullName")?.trim()?.takeIf { it.isNotEmpty() },
            branch = json.optString("branch").trim().takeIf { it.isNotEmpty() },
            dirty = state?.optBoolean("dirty") == true,
            unpushed = state?.optBoolean("unpushed") == true,
            pullRequestState = latest?.optString("state")?.takeIf { it.isNotEmpty() },
            pullRequestKey = if (repository.isNotEmpty() && number > 0) "$repository#$number" else null,
        )
    }

    /** The branch the session works on, for "Copy branch" (shown only when there is one). */
    fun branch(conversation: Conversation): String? = facts(conversation).branch

    /** The Code list search: the title, the repository or the branch contains the text (case-insensitive). */
    fun matches(conversation: Conversation, query: String): Boolean {
        val needle = query.trim()
        if (needle.isEmpty()) return true
        val facts = facts(conversation)
        return conversation.title.contains(needle, ignoreCase = true) ||
            facts.repository?.contains(needle, ignoreCase = true) == true ||
            facts.branch?.contains(needle, ignoreCase = true) == true
    }
}
