package com.claudex.mobile

import com.claudex.core.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SessionListTest {
    private fun turn(status: TurnStatus, vararg texts: String) = Turn("t-${texts.size}-$status", "go", items = texts.mapIndexed { i, t -> Item("i$i", "agentMessage", t) }, status = status)
    private fun session(id: String, vararg turns: Turn, archived: Boolean = false, mode: Mode = Mode.CODE, updated: Long = 1) =
        Conversation(id, id, mode, "p", "m", archived = archived, updatedAt = updated, turns = turns.toList())

    @Test fun filtersFollowTheOfficialOrder() {
        assertEquals(listOf("ALL", "WORKING", "NEEDS_INPUT", "READY_FOR_REVIEW", "COMPLETED", "ARCHIVED"), SessionFilter.entries.map { it.name })
        assertFalse(SessionFilter.READY_FOR_REVIEW in SessionList.coworkFilters)
        assertEquals(5, SessionList.coworkFilters.size)
    }

    @Test fun eachSessionIsInOneBucket() {
        val done = session("done", turn(TurnStatus.COMPLETED))
        val running = session("running", turn(TurnStatus.IN_PROGRESS))
        val asking = session("asking", turn(TurnStatus.IN_PROGRESS))
        val reviewing = session("reviewing", turn(TurnStatus.COMPLETED))
        val archived = session("archived", turn(TurnStatus.COMPLETED), archived = true)
        val failed = session("failed", turn(TurnStatus.FAILED))
        val all = listOf(done, running, asking, reviewing, archived, failed)
        val waiting = setOf("asking"); val review = setOf("reviewing", "running", "asking")
        fun ids(f: SessionFilter) = all.filter { SessionList.matches(f, it, waiting, review) }.map { it.id }
        assertEquals(listOf("done", "running", "asking", "reviewing", "failed"), ids(SessionFilter.ALL))
        assertEquals(listOf("running"), ids(SessionFilter.WORKING))
        assertEquals(listOf("asking"), ids(SessionFilter.NEEDS_INPUT))
        // A running or waiting session is never "ready", whatever its last pull request says.
        assertEquals(listOf("reviewing"), ids(SessionFilter.READY_FOR_REVIEW))
        assertEquals(listOf("done"), ids(SessionFilter.COMPLETED))
        assertEquals(listOf("archived"), ids(SessionFilter.ARCHIVED))
    }

    @Test fun theSessionsPullRequestIsTheLastTaggedOne() {
        val first = "Done.\n<pr-created>https://github.com/octo/hello/pull/3</pr-created>"
        val second = "Pushed again.\n<pr-created> https://github.com/Octo/Hello/pull/9 </pr-created>"
        val c = session("c", turn(TurnStatus.COMPLETED, first), turn(TurnStatus.COMPLETED, second, "See https://github.com/octo/hello/pull/12 for context"))
        assertEquals(PullRef("Octo/Hello", 9), SessionReviewPolicy.pullRequest(c))
        assertEquals("octo/hello#9", SessionReviewPolicy.pullRequest(c)!!.key)
        // A plain link is not the session's own, and only github.com is asked about.
        assertNull(SessionReviewPolicy.pullRequest(session("plain", turn(TurnStatus.COMPLETED, "https://github.com/octo/hello/pull/12"))))
        assertNull(SessionReviewPolicy.pullRequest(session("ghe", turn(TurnStatus.COMPLETED, "<pr-created>https://git.example.com/a/b/pull/1</pr-created>"))))
        assertNull(SessionReviewPolicy.pullRequest(session("none")))
    }

    @Test fun onlyFinishedCodeSessionsAreAskedAbout() {
        val tag = "<pr-created>https://github.com/octo/hello/pull/%d</pr-created>"
        val list = listOf(
            session("a", turn(TurnStatus.COMPLETED, tag.format(1)), updated = 5),
            session("running", turn(TurnStatus.IN_PROGRESS, tag.format(2)), updated = 9),
            session("archived", turn(TurnStatus.COMPLETED, tag.format(3)), archived = true),
            session("chat", turn(TurnStatus.COMPLETED, tag.format(4)), mode = Mode.CHAT),
            session("b", turn(TurnStatus.COMPLETED, tag.format(5)), updated = 7),
            session("plain", turn(TurnStatus.COMPLETED, "no request")),
        )
        assertEquals(listOf("b", "a"), SessionReviewPolicy.candidates(list).keys.toList())
        val many = (1..60).map { session("s$it", turn(TurnStatus.COMPLETED, tag.format(it)), updated = it.toLong()) }
        assertEquals(SessionReviewPolicy.MAX_ASKED, SessionReviewPolicy.candidates(many).size)
    }

    @Test fun theServiceBodyAndAnswerRoundTrip() {
        val body = SessionReviewPolicy.request(listOf(PullRef("octo/hello", 7)))
        assertEquals("octo/hello", body.getJSONArray("pulls").getJSONObject(0).getString("repo"))
        assertEquals(7, body.getJSONArray("pulls").getJSONObject(0).getInt("number"))
        val answer = JSONObject("""{"code":0,"data":{"states":[{"repository":"octo/hello","number":7,"state":"open","review":"review_required","awaits_review":true},{"repository":"octo/hello","number":8,"state":"draft","awaits_review":false},{"number":9}]}}""")
        assertEquals(listOf(PullVerdict("octo/hello#7", true), PullVerdict("octo/hello#8", false)), SessionReviewPolicy.verdicts(answer))
        assertTrue(SessionReviewPolicy.verdicts(JSONObject("{}")).isEmpty())
    }

    @Test fun verdictsAreKeptForAMinuteAndAFailedQuestionKeepsThem() = runBlocking {
        val tag = "<pr-created>https://github.com/octo/hello/pull/%d</pr-created>"
        val list = listOf(session("a", turn(TurnStatus.COMPLETED, tag.format(1))), session("b", turn(TurnStatus.COMPLETED, tag.format(2))), session("gone", turn(TurnStatus.COMPLETED, tag.format(3))))
        var clock = 1_000_000L
        val asked = mutableListOf<List<String>>()
        var answer: List<PullVerdict>? = listOf(PullVerdict("octo/hello#1", true), PullVerdict("octo/hello#2", false))
        val review = SessionReview({ refs -> asked += refs.map { it.key }; answer }, { clock })
        review.load(list)
        assertEquals(setOf("a"), review.ready.value)
        assertEquals(1, asked.size)
        // Inside the minute nothing is asked again; the filter reads the kept answers.
        clock += 30_000; review.load(list)
        assertEquals(1, asked.size)
        // Pull to refresh asks at once; a failed question keeps the last answer.
        answer = null; review.load(list, force = true)
        assertEquals(2, asked.size); assertEquals(setOf("a"), review.ready.value)
        // After the minute a request, and one GitHub no longer answers for, is asked again and answered.
        clock += 61_000; answer = listOf(PullVerdict("octo/hello#2", true))
        review.load(list)
        assertEquals(setOf("b"), review.ready.value)
        review.clear(); assertTrue(review.ready.value.isEmpty())
    }
}
