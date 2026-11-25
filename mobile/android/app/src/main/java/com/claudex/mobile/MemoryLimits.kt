package com.claudex.mobile

import com.claudex.core.ApiException

/**
 * The memory service's size and conflict rules. A document save uses the revision it was read from;
 * a stale revision is refused, and the screen drops that snapshot so the next preview reads the current memory.
 */
internal object MemoryLimits {
    const val DOC_BYTES = 16 * 1024
    const val IMPORT_BYTES = 32 * 1024

    fun utf8Bytes(text: String) = text.toByteArray(Charsets.UTF_8).size

    /** Another device wrote first, or memory was reset, so this snapshot must not be saved again. */
    fun conflict(error: Throwable): Boolean {
        val code = (error as? ApiException)?.code.orEmpty()
        val message = error.message.orEmpty()
        return code == "CLAUDEX_MEMORY_CONFLICT" ||
            message.contains("changed on another device", ignoreCase = true) ||
            message.contains("Reload it before saving") ||
            message.contains("Reload memory to obtain")
    }
}
