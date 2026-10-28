package com.claudex.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdatePolicyTest {
    private val sha = "a".repeat(64)
    private fun apps(url: String, version: String = "0.8.0", hash: String = sha, notes: String? = null) =
        JSONObject().put("data", JSONObject().put("android", JSONObject().put("version", version).put("url", url).put("sha256", hash).apply { notes?.let { put("notes", it) } }))

    @Test fun versionsCompareAsNumbers() {
        assertTrue(AppUpdatePolicy.newer("0.10.0", "0.9.3"))
        assertTrue(AppUpdatePolicy.newer("0.8.0", "0.7.0"))
        assertFalse(AppUpdatePolicy.newer("0.7.0", "0.7.0"))
        assertFalse(AppUpdatePolicy.newer("0.6.9", "0.7.0"))
        assertFalse(AppUpdatePolicy.newer("latest", "0.7.0"))
    }

    @Test fun aReleaseComesOnlyFromTheAppsOwnServiceOverHttps() {
        val origin = "https://claudex.example.com"
        val ok = AppUpdatePolicy.release(apps("https://claudex.example.com/downloads/claudex/android/0.8.0/Claudex-0.8.0.apk", notes = " 新功能 "), origin)
        assertEquals("0.8.0", ok?.version); assertEquals("新功能", ok?.notes)
        assertNull(AppUpdatePolicy.release(apps("https://evil.example/Claudex.apk"), origin))
        assertNull(AppUpdatePolicy.release(apps("http://claudex.example.com/a.apk"), origin))
        assertNull(AppUpdatePolicy.release(apps("https://x@claudex.example.com/a.apk"), origin))
        assertNull(AppUpdatePolicy.release(apps("https://claudex.example.com/a.zip"), origin))
        assertNull(AppUpdatePolicy.release(apps("https://claudex.example.com/a.apk", hash = "nope"), origin))
    }
}
