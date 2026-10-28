package com.claudex.core

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.test.*
import org.junit.Test
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class DemoQueueCompletionTest {
    @Test fun completedSnapshotAllowsOneQueuedFollowup() = runTest {
        val immediate = CoroutineScope(coroutineContext + UnconfinedTestDispatcher(testScheduler))
        val repository = DemoRepository(immediate)
        val input = SendInput(null, "synthetic first", Mode.CHAT, DemoFixtures.snapshot().models.first(), emptyList())
        val id = repository.send(input)
        val outcome = CompletableDeferred<Result<String>>()
        var claimed = false
        val observer = immediate.launch {
            repository.snapshot.collect { snapshot ->
                val conversation = snapshot.conversations.firstOrNull { it.id == id }
                if (!claimed && conversation?.turns?.lastOrNull()?.status == TurnStatus.COMPLETED) {
                    claimed = true
                    outcome.complete(runCatching { repository.send(input.copy(conversationId = id, text = "synthetic queued")) })
                }
            }
        }
        try {
            advanceUntilIdle()
            assertEquals(id, outcome.await().getOrThrow())
            val conversation = repository.snapshot.value.conversations.first { it.id == id }
            assertEquals(listOf("synthetic first", "synthetic queued"), conversation.turns.map { it.prompt })
            assertTrue(conversation.turns.all { it.status == TurnStatus.COMPLETED })
        } finally {
            observer.cancelAndJoin()
            repository.signOut()
        }
    }
}
