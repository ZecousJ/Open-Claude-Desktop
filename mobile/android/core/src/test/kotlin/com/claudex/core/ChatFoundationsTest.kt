package com.claudex.core

import kotlinx.coroutines.*
import org.junit.Test
import java.security.MessageDigest
import java.util.Base64
import kotlin.test.*

class ChatFoundationsTest {
    @Test fun markdownStructuresAndNestedLists() {
        val parsed = Markdown.blocks("# Title\n\n- outer\n  1. inner\n\n> quote\n\n---")
        assertEquals(listOf("heading", "list", "list", "quote", "rule"), parsed.map { it.kind })
        assertEquals(1, parsed[2].level); assertEquals("1.", parsed[2].label)
    }
    @Test fun incompleteStreamingFencePreservesEveryByte() {
        val prefixes = listOf("```kotlin\nval x =", "```kotlin\nval x = 1\n", "```kotlin\nval x = 1\n```\nDone")
        val parsed = prefixes.map(Markdown::blocks)
        assertEquals("val x =", parsed[0].single().text)
        assertEquals("val x = 1\n", parsed[1].single().text)
        assertEquals("Done", parsed[2].last().text)
    }
    @Test fun escapedFenceAndRawHtmlNeverBecomeExecutableContent() {
        val parsed = Markdown.blocks("\\```html\n<script>alert(1)</script>")
        assertEquals("paragraph", parsed.single().kind); assertTrue(parsed.single().text.contains("<script>"))
    }
    @Test fun longFenceRequiresMatchingClose() {
        assertEquals("a\n```\nb", Markdown.blocks("````js\na\n```\nb\n````").single().text)
    }
    @Test fun tableAlignmentAndEscapedPipes() {
        val table = Markdown.blocks("| A | B |\n| :--- | ---: |\n| a\\|b | c |").single()
        assertEquals("table", table.kind); assertEquals(listOf("a|b", "c"), table.rows[1])
    }
    @Test fun codeAndMathAreExplicitSourceKinds() {
        assertEquals("mermaid", Markdown.blocks("```mermaid\ngraph LR\n```").single().label)
        assertEquals("math", Markdown.blocks("$$\nx^2\n$$").single().kind)
    }
    @Test fun inlineFormattingAndSafeLinks() {
        assertEquals(listOf("bold", "text", "italic", "text", "code", "text", "link", "text", "image"), Markdown.spans("**bold** *italics* `code` [site](https://example.org) ![pic](https://example.org/p.png)").map { it.kind })
        assertEquals("https://example.org", Markdown.safeUrl("https://example.org"))
        listOf("javascript:alert(1)", "file:///tmp/a", "data:text/html,hi", "https://user:pass@example.org", "https://example.org\n@evil.test", "https://example.org\\@evil.test").forEach { assertNull(Markdown.safeUrl(it)) }
    }
    private fun binary(bytes: ByteArray) = GeneratedFile("f", "../result.pdf", "ready", MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }, bytes.size.toLong(), "application/pdf", true)
    @Test fun generatedSnapshotChecksBytesAndDigest() {
        val bytes = "%PDF-fixture\u0000\u00ff".toByteArray(); val file = binary(bytes)
        assertContentEquals(bytes, GeneratedFilePolicy.decode(file, Base64.getEncoder().encodeToString(bytes)))
        assertFails { GeneratedFilePolicy.decode(file, "not base64!!") }
        assertFails { GeneratedFilePolicy.decode(file.copy(bytes = 1), Base64.getEncoder().encodeToString(bytes)) }
        assertFails { GeneratedFilePolicy.decode(file.copy(digest = "0".repeat(64)), Base64.getEncoder().encodeToString(bytes)) }
    }
    @Test fun unavailableOversizedAndUnsafeFileNames() {
        assertFails { GeneratedFilePolicy.validate(binary(byteArrayOf()).copy(state = "unavailable")) }
        assertFails { GeneratedFilePolicy.validate(binary(byteArrayOf()).copy(bytes = GeneratedFilePolicy.MAX_BYTES + 1L)) }
        assertFails { GeneratedFilePolicy.validate(binary(byteArrayOf()).copy(digest = "../../secret")) }
        assertEquals("report.pdf", GeneratedFilePolicy.exportName("../../report.pdf"))
        assertEquals("name.txt", GeneratedFilePolicy.exportName("C:\\secret\\name.txt"))
        assertEquals("download", GeneratedFilePolicy.exportName("\n\u0000"))
    }
    @Test fun branchGroupingMatchesWebLatestContinuation() {
        val original = Turn("a", "prompt", createdAt = 1, responseGroupId = "g", promptGroupId = "p", promptVersionId = "v1")
        val retry = original.copy(id = "b", createdAt = 2)
        val edited = original.copy(id = "c", prompt = "edited", responseGroupId = "g2", promptVersionId = "v2", createdAt = 3)
        val c = Conversation("c", "Chat", providerId = "p", model = "m", turns = listOf(retry), branchVisit = 5, savedBranches = listOf(ConversationBranch("old", listOf(original), 1), ConversationBranch("edited", listOf(edited), 2)))
        assertEquals(listOf("a", "b"), TurnVersions.versions(c, retry).map { it.turnId })
        assertEquals(listOf("b", "c"), TurnVersions.versions(c, retry, true).map { it.turnId })
    }
    @Test fun feedbackKeysAreJsonCompatible() { assertEquals("[\"c\\\"\",\"t\\n\"]", feedbackKey("c\"", "t\n")) }
    @Test fun demoRetryEditSelectAndDeletionRetainOtherConversations() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default); val repo = DemoRepository(scope)
        try {
            repo.retryResponse("demo-chat", "demo-turn", "demo", "demo-auto"); repo.interrupt("demo-chat")
            val c = repo.snapshot.value.conversations.first { it.id == "demo-chat" }; val t = c.turns.last()
            assertEquals(2, TurnVersions.versions(c, t).size)
            repo.selectVersion(c.id, t.id, "demo-turn", false)
            assertEquals("demo-turn", repo.snapshot.value.conversations.first { it.id == c.id }.turns.single().id)
            repo.editPrompt(c.id, "demo-turn", "Edited locally", "demo", "demo-auto"); repo.interrupt(c.id)
            assertEquals("Edited locally", repo.snapshot.value.conversations.first { it.id == c.id }.turns.last().prompt)
            repo.deleteProject("demo-project")
            assertTrue(repo.snapshot.value.conversations.any { it.id == c.id }); assertNull(repo.snapshot.value.conversations.first { it.id == c.id }.projectId)
            repo.deleteConversation(c.id)
            assertFalse(repo.snapshot.value.conversations.any { it.id == c.id }); assertTrue(repo.snapshot.value.conversations.any { it.id == "demo-code" })
        } finally { scope.cancel() }
    }
    @Test fun promptVersionKeyDoesNotDependOnRepresentativeReplyId() {
        val original = Turn("a", "question", createdAt = 1, responseGroupId = "g", promptVersionId = "p")
        val current = original.copy(id = "b", createdAt = 2)
        val c = Conversation("c", "Chat", providerId = "provider", model = "model", turns = listOf(current), branchVisit = 1, savedBranches = listOf(ConversationBranch("old", listOf(original), 9)))
        val version = TurnVersions.versions(c, current, true).single()
        assertEquals("a", version.turnId); assertEquals(current.promptVersionId, version.versionKey)
    }
    @Test fun staleMutationDoesNotDropNewerContinuationOrExternalBranch() {
        val turn = Turn("t", "prompt")
        val before = Conversation("c", "Chat", providerId = "p", model = "m", turns = listOf(turn), activeBranchId = "old", branchVisit = 1)
        val returned = before.copy(activeBranchId = "retry", branchVisit = 2, turns = listOf(turn.copy(id = "retry-turn")))
        val continuation = returned.copy(turns = returned.turns + Turn("follow-up", "continue"))
        assertEquals(continuation, ConversationMutationReconciler.merge(before, continuation, returned))
        val external = before.copy(activeBranchId = "external", branchVisit = 3)
        assertEquals(external, ConversationMutationReconciler.merge(before, external, returned))
        val streamed = before.copy(turns = listOf(returned.turns.single().copy(items = listOf(Item("i", "agentMessage", "new text")))))
        assertEquals("new text", ConversationMutationReconciler.merge(before, streamed, returned).turns.single().items.single().text)
    }
}
