package com.claudex.mobile

import java.io.File

/** The zip the service builds for the signed-in account. The name comes from the download, never from a path. */
object AccountExport {
    const val BYTE_LIMIT = 512L * 1024 * 1024
    private val named = Regex("""filename="([A-Za-z0-9._-]{1,80})"""")

    fun filename(disposition: String?): String {
        val candidate = named.find(disposition ?: "")?.groupValues?.getOrNull(1)
        return if (candidate != null && candidate.endsWith(".zip") && !candidate.contains("..")) candidate else "claudex-export.zip"
    }

    fun isZip(magic: ByteArray, count: Int): Boolean {
        if (count < 4) return false
        return magic[0] == 0x50.toByte() && magic[1] == 0x4B.toByte() && magic[2] == 0x03.toByte() && magic[3] == 0x04.toByte()
            || magic[0] == 0x50.toByte() && magic[1] == 0x4B.toByte() && magic[2] == 0x05.toByte() && magic[3] == 0x06.toByte()
    }

    fun location(cache: File) = File(cache, "exports")
}
