package com.claudex.mobile

import com.claudex.core.ApiException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryLimitsTest {
    @Test fun conflictCoversAStaleRevisionAndAReset() {
        assertTrue(MemoryLimits.conflict(ApiException("CLAUDEX_MEMORY_CONFLICT", "Memory changed on another device. Reload it and try again.")))
        assertTrue(MemoryLimits.conflict(IllegalStateException("Memory was reset. Reload it before saving.")))
        assertTrue(MemoryLimits.conflict(IllegalStateException("Memory was cleared. Reload memory to obtain its current state.")))
        assertFalse(MemoryLimits.conflict(ApiException("CLAUDEX_MEMORY_TOO_LARGE", "This memory is too long. Shorten it and try again.")))
    }

    @Test fun oversizedMemoryNeverReachesTheRunner() = runBlocking {
        var called = false
        val api = ManagementApi { _, _ -> called = true; null }
        try {
            api.saveMemory(null, "记".repeat(6_000), 1)
            error("oversized memory was accepted")
        } catch (error: ApiException) {
            assertEquals("CLAUDEX_MEMORY_TOO_LARGE", error.code)
        }
        try {
            api.previewMemoryImport("a".repeat(MemoryLimits.IMPORT_BYTES + 1))
            error("oversized import was accepted")
        } catch (error: ApiException) {
            assertEquals("CLAUDEX_MEMORY_TOO_LARGE", error.code)
        }
        assertFalse(called)
    }
}
