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
}
