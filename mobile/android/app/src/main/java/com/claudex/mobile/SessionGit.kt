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

private fun pullRequestParts(key: String?): Pair<String, Int>? {
    val raw = key?.trim().orEmpty()
    val hash = raw.lastIndexOf('#')
    if (hash <= 0) return null
    val repo = raw.substring(0, hash)
    val number = raw.substring(hash + 1).toIntOrNull() ?: return null
    if (number <= 0 || !Regex("""^[\w.-]+/[\w.-]+$""").matches(repo)) return null
    return repo to number
}

/** The GitHub page for a session pull request recorded as "owner/name#12". */
internal fun pullRequestUrl(key: String?): String? {
    val (repo, number) = pullRequestParts(key) ?: return null
    return "https://github.com/$repo/pull/$number"
}

/** The number shown on the pull-request chip, as "#12". */
internal fun pullRequestMark(key: String?): String? = pullRequestParts(key)?.let { "#${it.second}" }

/** "owner/name" and the pull-request number, for the service's pull endpoint. */
internal data class PullIdentity(val repository: String, val number: Int)

internal fun pullRequestIdentity(key: String?): PullIdentity? = pullRequestParts(key)?.let { PullIdentity(it.first, it.second) }

/** The CI chip. A pending check on a merged or closed request reads as unavailable. An unknown value is left out. */
internal enum class CiChip { PENDING, PASSED, FAILED, UNAVAILABLE }

/** Why this pull request is not ready to merge, in the order the row explains it. */
internal enum class MergeHold { QUEUED, DRAFT, CONFLICTS, BEHIND, BLOCKED, CHECKING }

/** The review line on a loaded pull request. An empty or unknown decision reads as no review yet. */
internal enum class PullReview { NONE, APPROVED, CHANGES, REQUIRED }

internal fun pullReview(review: String?): PullReview = when (review?.lowercase()) {
    "approved" -> PullReview.APPROVED
    "changes_requested" -> PullReview.CHANGES
    "review_required" -> PullReview.REQUIRED
    else -> PullReview.NONE
}

internal fun mergeHold(state: String?, conflicting: Boolean, mergeState: String?): MergeHold? = when {
    state == "queued" -> MergeHold.QUEUED
    state == "draft" -> MergeHold.DRAFT
    conflicting -> MergeHold.CONFLICTS
    mergeState == "behind" -> MergeHold.BEHIND
    mergeState == "blocked" -> MergeHold.BLOCKED
    mergeState == "unknown" -> MergeHold.CHECKING
    else -> null
}

/** One conversation output opens itself. More than one opens the outputs sheet. */
internal enum class OutputOpen { NONE, DIRECT, SHEET }

internal fun outputOpen(count: Int): OutputOpen = when {
    count <= 0 -> OutputOpen.NONE
    count == 1 -> OutputOpen.DIRECT
    else -> OutputOpen.SHEET
}

/** An open request whose check list was counted and came back empty. */
internal fun noChecksReported(checks: String?, state: String?): Boolean {
    val live = state == "open" || state == "draft" || state == "queued"
    return live && checks == "none"
}

internal fun ciChip(checks: String?, state: String?): CiChip? {
    val live = state == "open" || state == "draft" || state == "queued"
    return when (checks) {
        "passed" -> CiChip.PASSED
        "failed" -> CiChip.FAILED
        "pending" -> if (live) CiChip.PENDING else CiChip.UNAVAILABLE
        "none", "skipped" -> CiChip.UNAVAILABLE
        else -> null
    }
}

/** A base branch worth naming: another branch with a plain name. */
internal fun usableBaseBranch(base: String?, branch: String): String? {
    if (base.isNullOrBlank() || base == branch) return null
    return if (Regex("""^[\w./-]+$""").matches(base)) base else null
}

/** What `codeGitStatus` says about the folder, enough to offer a pull request. */
internal data class BranchOffer(
    val branch: String,
    val repository: String?,
    val baseBranch: String?,
    val cwd: String?,
    val cloud: Boolean,
    val pushed: Boolean,
    val dirty: Boolean,
    val ahead: Int,
)

internal fun branchOffer(status: JSONObject?, cloud: Boolean, cwd: String?): BranchOffer? {
    if (status == null || status.optString("state") != "ready") return null
    val branch = status.optString("branch").trim().takeIf { it.isNotEmpty() } ?: return null
    return BranchOffer(
        branch,
        status.optString("repository").trim().takeIf { it.isNotEmpty() },
        status.optString("baseBranch").trim().takeIf { it.isNotEmpty() },
        cwd?.trim()?.takeIf { it.isNotEmpty() },
        cloud,
        status.optBoolean("pushed"),
        status.optBoolean("dirty"),
        status.optInt("ahead"),
    )
}

/** The push button is offered when the folder has a GitHub remote, a feature branch, and something to send. */
internal fun offersPullRequest(offer: BranchOffer, running: Boolean): Boolean {
    if (running || offer.repository.isNullOrEmpty()) return false
    if (offer.baseBranch != null && offer.branch == offer.baseBranch) return false
    if (offer.cloud && !offer.pushed) return false
    return offer.dirty || offer.ahead > 0
}

/** The message the push button sends. Claude commits, pushes and opens the request. */
internal fun createPrPrompt(offer: BranchOffer): String {
    val open = if (offer.cloud)
        "Open the PR with the github create_pull_request tool, with `draft` false: the user chose “Create PR”, not “Create draft PR”, for this request."
    else
        "Open the PR with `gh pr create`. Do not pass `--draft`: the user chose “Create PR”, not “Create draft PR”, for this request, and that explicit choice overrides any saved memory, standing instruction, or earlier plan to open it as a draft."
    val push = if (offer.cloud) "Push the branch with the github push tool." else "Push the branch to the remote."
    val baseHint = if (offer.cloud)
        "When the target below names a base branch, pass it as `base`; otherwise leave `base` off."
    else
        "When the target below names a base branch and that branch exists on origin (`git ls-remote --heads origin <base>`), pass it with `--base`; otherwise leave `--base` off and let gh infer it."
    val lines = mutableListOf(
        "## Overview",
        "",
        "Create a pull request for the changes in this session, ready for review (not a draft).",
        "",
        "## Steps",
        "",
        "1. Check for uncommitted changes. If any exist, stage and commit them with a message that describes what changed and why.",
        "2. $push",
        "3. $open $baseHint Write a title that summarizes the change and a body that covers what changed, why, and anything a reviewer should know. If the repo has a PR template, follow it.",
        "4. Report the PR URL when done. Wrap the URL in a `<pr-created>` tag on its own line so the UI can render a live status card, like this: `<pr-created>https://github.com/owner/repo/pull/123</pr-created>`",
        "",
        "If a PR already exists for this branch, push any new commits and report the existing URL wrapped in the same `<pr-created>` tag instead of creating a duplicate, and leave that PR's draft or ready state as it is.",
        "",
        "## Target",
        "",
    )
    offer.repository?.let { lines += "Repository: $it" }
    lines += "Branch: ${offer.branch}"
    usableBaseBranch(offer.baseBranch, offer.branch)?.let { lines += "Base branch: $it" }
    if (!offer.cloud) offer.cwd?.let { lines += "Working directory: $it" }
    return "<create-pr-command>\n${lines.joinToString("\n")}\n</create-pr-command>"
}

/** What the diff page says while it reads a session's working tree. */
internal enum class DiffNotice { LOADING, UNAVAILABLE, UNABLE, PARTIAL, EDITS_ONLY, TOO_MANY, EMPTY, NONE, READY, STALE }

/** An empty listing says “No changes” once a commit or another branch is selected, and “No changes yet” on All changes. */
internal fun diffSettledNotice(notice: DiffNotice, narrowed: Boolean): DiffNotice =
    if (notice == DiffNotice.EMPTY && narrowed) DiffNotice.NONE else notice

/** A later read failed. A page that already loaded keeps that diff and says it may be out of date. */
internal fun diffRefreshFailure(hadListing: Boolean, turnChanges: Boolean): DiffNotice =
    if (hadListing) DiffNotice.STALE else if (turnChanges) DiffNotice.EDITS_ONLY else DiffNotice.UNABLE

internal object DiffListing {
    /**
     * A ready tree with a diff shows the files. A truncated tree still shows what arrived, and says some
     * files may be missing; a truncated tree with nothing to show is too large. A session that is not a
     * git checkout cannot show a diff. A failed read falls back to the edits already on the turn.
     */
    fun notice(loaded: Boolean, failed: Boolean, state: String?, truncated: Boolean, treeDiff: Boolean, turnChanges: Boolean): DiffNotice {
        if (!loaded) return DiffNotice.LOADING
        if (failed) return if (turnChanges) DiffNotice.EDITS_ONLY else DiffNotice.UNABLE
        if (state == "not-git" || state == "no-folder") return DiffNotice.UNAVAILABLE
        if (truncated && !treeDiff) return DiffNotice.TOO_MANY
        if (truncated) return DiffNotice.PARTIAL
        if (!treeDiff && turnChanges) return DiffNotice.EDITS_ONLY
        if (!treeDiff) return DiffNotice.EMPTY
        return DiffNotice.READY
    }
}
