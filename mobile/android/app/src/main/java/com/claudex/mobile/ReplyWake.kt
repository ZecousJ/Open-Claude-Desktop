package com.claudex.mobile

import android.content.Context
import android.os.PowerManager

/** Keeps the processor awake while a reply is still being written, including with the screen off. */
internal class ReplyWake(context: Context) {
    private val lock = context.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "claudex:reply")
        .apply { setReferenceCounted(false) }

    fun hold() {
        if (!lock.isHeld) lock.acquire(HOLD_LIMIT)
    }

    fun release() {
        if (lock.isHeld) lock.release()
    }

    private companion object {
        const val HOLD_LIMIT = 10 * 60 * 1000L
    }
}
