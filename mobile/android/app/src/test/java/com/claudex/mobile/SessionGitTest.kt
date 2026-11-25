package com.claudex.mobile

import com.claudex.core.Conversation
import com.claudex.core.Mode
import com.claudex.core.Turn
import com.claudex.core.TurnStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SessionGitTest {
    private fun session(
        raw: String? = null,
        title: String = "Fix login",
        status: TurnStatus = TurnStatus.COMPLETED,
        archived: Boolean = false,
    ) = Conversation(
        id = "c1", title = title, mode = Mode.CODE, providerId = "p", model = "m", archived = archived,
        turns = listOf(Turn("t1", "go", status = status)), rawJson = raw,
    )

    @Test fun factsAreReadFromTheWireMetadata() {
        val facts = SessionGit.facts(
            """{"repository":{"fullName":"Octo/Repo","url":"https://github.com/Octo/Repo"},"branch":"feature/login","gitState":{"dirty":true,"unpushed":false,"checkedAt":1},"pullRequests":[{"number":1,"state":"merged"},{"number":2,"state":"open"}]}""",
        )
        assertEquals("Octo/Repo", facts.repository)
        assertEquals("feature/login", facts.branch)
        assertTrue(facts.dirty)
        assertFalse(facts.unpushed)
        assertEquals("open", facts.pullRequestState)
        // A session from before they were recorded, or a broken document, carries nothing.
        assertNull(SessionGit.facts(null).branch)
        assertNull(SessionGit.facts("{}").repository)
        assertNull(SessionGit.facts("not json").branch)
        assertNull(SessionGit.branch(session("""{"branch":"  "}""")))
    }

    @Test fun searchMatchesTitleRepositoryAndBranch() {
        val c = session("""{"repository":{"fullName":"Octo/Repo"},"branch":"feature/login-fix"}""")
        assertTrue(SessionGit.matches(c, "fix login"))
        assertTrue(SessionGit.matches(c, "octo/repo"))
        assertTrue(SessionGit.matches(c, " LOGIN-FIX "))
        assertFalse(SessionGit.matches(c, "payments"))
        assertTrue(SessionGit.matches(c, "   "))
        // Without recorded facts only the title is searched.
        assertFalse(SessionGit.matches(session(), "octo"))
    }

    @Test fun diffNoticeFollowsTheWorkingTree() {
        assertEquals(DiffNotice.LOADING, DiffListing.notice(false, false, null, false, false, false))
        assertEquals(DiffNotice.UNAVAILABLE, DiffListing.notice(true, false, "not-git", false, false, true))
        assertEquals(DiffNotice.UNAVAILABLE, DiffListing.notice(true, false, "no-folder", false, false, false))
        assertEquals(DiffNotice.UNABLE, DiffListing.notice(true, true, null, false, false, false))
        assertEquals(DiffNotice.EDITS_ONLY, DiffListing.notice(true, true, null, false, false, true))
        assertEquals(DiffNotice.TOO_MANY, DiffListing.notice(true, false, "ready", true, false, false))
        assertEquals(DiffNotice.PARTIAL, DiffListing.notice(true, false, "ready", true, true, false))
        assertEquals(DiffNotice.EMPTY, DiffListing.notice(true, false, "ready", false, false, false))
        assertEquals(DiffNotice.READY, DiffListing.notice(true, false, "ready", false, true, false))
        assertEquals(DiffNotice.NONE, diffSettledNotice(DiffNotice.EMPTY, true))
        assertEquals(DiffNotice.EMPTY, diffSettledNotice(DiffNotice.EMPTY, false))
        assertEquals(DiffNotice.READY, diffSettledNotice(DiffNotice.READY, true))
        assertEquals(DiffNotice.STALE, diffRefreshFailure(true, true))
        assertEquals(DiffNotice.EDITS_ONLY, diffRefreshFailure(false, true))
        assertEquals(DiffNotice.UNABLE, diffRefreshFailure(false, false))
        val feature = BranchOffer("feature", "owner/name", "main", "/src", false, false, true, 0)
        assertTrue(offersPullRequest(feature, false))
        assertFalse(offersPullRequest(feature, true))
        assertFalse(offersPullRequest(feature.copy(repository = null, dirty = true), false))
        assertFalse(offersPullRequest(feature.copy(branch = "main", baseBranch = "main", dirty = true), false))
        assertFalse(offersPullRequest(feature.copy(cloud = true, pushed = false, dirty = true), false))
        assertNull(usableBaseBranch("main", "main"))
        assertNull(usableBaseBranch("bad name", "feature"))
        val prompt = createPrPrompt(feature)
        assertTrue(prompt.startsWith("<create-pr-command>"))
        assertTrue(prompt.contains("Repository: owner/name"))
        assertTrue(prompt.contains("Branch: feature"))
        assertTrue(prompt.contains("Base branch: main"))
        assertTrue(prompt.contains("Working directory: /src"))
        assertTrue(prompt.contains("gh pr create"))
        assertEquals("https://github.com/owner/name/pull/12", pullRequestUrl("owner/name#12"))
        assertEquals("#12", pullRequestMark("owner/name#12"))
        assertEquals(CiChip.PASSED, ciChip("passed", "open"))
        assertEquals(CiChip.UNAVAILABLE, ciChip("pending", "merged"))
        assertEquals(CiChip.PENDING, ciChip("pending", "draft"))
        assertNull(ciChip(null, "open"))
        assertEquals(MergeHold.DRAFT, mergeHold("draft", true, "behind"))
        assertEquals(MergeHold.CONFLICTS, mergeHold("open", true, "blocked"))
        assertEquals(MergeHold.BEHIND, mergeHold("open", false, "behind"))
        assertEquals(MergeHold.CHECKING, mergeHold("open", false, "unknown"))
        assertNull(mergeHold("open", false, "clean"))
        assertEquals(PullReview.APPROVED, pullReview("APPROVED"))
        assertEquals(PullReview.CHANGES, pullReview("changes_requested"))
        assertEquals(PullReview.REQUIRED, pullReview("review_required"))
        assertEquals(PullReview.NONE, pullReview(null))
        assertEquals(OutputOpen.NONE, outputOpen(0))
        assertEquals(OutputOpen.DIRECT, outputOpen(1))
        assertEquals(OutputOpen.SHEET, outputOpen(2))
        assertTrue(noChecksReported("none", "open"))
        assertFalse(noChecksReported("none", "merged"))
        assertFalse(noChecksReported("skipped", "open"))
        assertNull(pullRequestUrl("owner/name"))
        assertNull(pullRequestUrl("bad name#1"))
    }
}
