package com.claudex.core

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Test
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class CoreTest {
    @Test fun duplicateEventsAreNotReplayed() { val cursor = EventCursor(); assertEquals(EventCursor.Decision.APPLY, cursor.receive(7)); assertEquals(EventCursor.Decision.DUPLICATE, cursor.receive(7)); assertEquals(7L, cursor.lastSequence) }
    @Test fun gapsRequireSnapshotWithoutAdvancingCursor() { val cursor = EventCursor(); cursor.reset(4); assertEquals(EventCursor.Decision.RESYNC, cursor.receive(6)); assertEquals(4L, cursor.lastSequence) }
    @Test fun nonResumedConnectionRequiresSnapshot() { val cursor = EventCursor(); cursor.reset(12); assertTrue(cursor.ready(false)); assertFalse(cursor.ready(true)) }
    @Test fun logoutRejectsStaleEpoch() { val epoch = SessionEpoch(); val request = epoch.value; epoch.invalidate(); assertFalse(epoch.accepts(request)) }
    @Test fun retryIsBoundedAndMutationsNotAssumedSafe() { assertEquals(1000, RetryPolicy.delayMs(0)); assertEquals(30000, RetryPolicy.delayMs(100)); assertTrue(RetryPolicy.retryRead(503)); assertFalse(RetryPolicy.retryRead(401)) }
    @Test fun validatesAttachmentBoundaries() { AttachmentPolicy.validate("ok.pdf", 1, 0); AttachmentPolicy.validate("max.pdf", AttachmentPolicy.MAX_BYTES, 9); assertFails { AttachmentPolicy.validate("large", AttachmentPolicy.MAX_BYTES + 1, 0) }; assertFails { AttachmentPolicy.validate("empty", 0, 0) }; assertFails { AttachmentPolicy.validate("extra", 1, 10) } }
    @Test fun chunkCountAvoidsEmptyTrailingChunk() { assertEquals(1, AttachmentPolicy.chunks(1024L * 1024)); assertEquals(2, AttachmentPolicy.chunks(1024L * 1024 + 1)) }
    @Test fun originRequiresHttpsAndRejectsCredentialsPathAndQuery() { assertEquals("example.com", NativeAuthSecurity.validateOrigin("https://example.com:8443").host); listOf("http://example.com", "https://user:secret@example.com", "https://example.com/login", "https://example.com?x=1").forEach { assertFails { NativeAuthSecurity.validateOrigin(it) } } }
    @Test fun pkceMatchesRfc7636() { assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", NativeAuthSecurity.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")); assertFalse(NativeAuthSecurity.validateCallback("first", "second")) }
    @Test fun demoSendActuallyStreamsAndCompletes() = runTest { val repo = DemoRepository(this); val id = repo.send(input()); assertEquals(TurnStatus.IN_PROGRESS, repo.snapshot.value.conversations.first { it.id == id }.turns.last().status); advanceUntilIdle(); val turn = repo.snapshot.value.conversations.first { it.id == id }.turns.last(); assertEquals(TurnStatus.COMPLETED, turn.status); assertTrue(turn.items.first().text.contains("本地演示")) }
    @Test fun stoppingGenerationRetainsPartialResult() = runTest { val repo = DemoRepository(this); val id = repo.send(input()); advanceTimeBy(500); repo.interrupt(id); val before = repo.snapshot.value.conversations.first { it.id == id }.turns.last(); advanceUntilIdle(); assertEquals(TurnStatus.INTERRUPTED, before.status); assertEquals(before, repo.snapshot.value.conversations.first { it.id == id }.turns.last()) }
    @Test fun repeatedSendWhileGeneratingDoesNotDuplicateTurn() = runTest { val repo = DemoRepository(this); val id = repo.send(input()); assertFailsWith<ApiException> { repo.send(input().copy(conversationId = id)) }; assertEquals(1, repo.snapshot.value.conversations.first { it.id == id }.turns.size); advanceUntilIdle() }
    @Test fun failureCanBeRetriedManuallyWithoutPhantomConversation() = runTest { val repo = DemoRepository(this); val count = repo.snapshot.value.conversations.size; repo.failNextSend = true; assertFailsWith<ApiException> { repo.send(input()) }; assertEquals(count, repo.snapshot.value.conversations.size); repo.send(input()); advanceUntilIdle(); assertEquals(count + 1, repo.snapshot.value.conversations.size) }
    @Test fun logoutDuringStreamCannotRestoreOldAccountData() = runTest { val repo = DemoRepository(this); repo.send(input()); advanceTimeBy(200); repo.signOut(); advanceUntilIdle(); assertTrue(repo.snapshot.value.conversations.isEmpty()); assertEquals(Connection.Offline, repo.connection.value) }
    @Test fun simulatedReconnectHasObservableStates() = runTest { val repo = DemoRepository(this); val job = launch { repo.simulateDisconnect() }; runCurrent(); assertIs<Connection.Reconnecting>(repo.connection.value); advanceUntilIdle(); job.join(); assertEquals(Connection.Connected, repo.connection.value) }
    @Test fun renamePinArchiveAndProjectEditsAreApplied() = runTest { val repo = DemoRepository(this); repo.updateConversation("demo-chat", "Renamed", true, true); val c = repo.snapshot.value.conversations.first { it.id == "demo-chat" }; assertEquals("Renamed", c.title); assertTrue(c.pinned && c.archived); val p = Project("new", "Project", "Description", "Instructions"); repo.saveProject(p); assertTrue(repo.snapshot.value.projects.contains(p)) }
    private fun input() = SendInput(null, "测试", Mode.CHAT, DemoFixtures.snapshot().models.first(), emptyList())
}
