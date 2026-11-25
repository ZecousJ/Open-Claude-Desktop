package com.claudex.mobile

/** Snapshot failures cannot turn each incoming frame into another read/reconnect. */
internal class EventResyncBudget(private val limit: Int = 3) {
    private var failures = 0
    fun canRead() = failures < limit
    fun failed() { failures++ }
    fun succeeded() { failures = 0 }
}

internal object SnapshotEventSequence {
    fun parse(header: String?): Long? = header?.toLongOrNull()?.takeIf { it in 0..9_007_199_254_740_991L }
    fun covered(cursor: Long?, snapshot: Long?): Long? = when {
        snapshot == null -> cursor
        cursor == null -> snapshot
        else -> maxOf(cursor, snapshot)
    }
}
