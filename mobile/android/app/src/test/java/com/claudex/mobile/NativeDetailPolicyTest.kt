package com.claudex.mobile
import com.claudex.core.ModelOption
import java.time.ZoneId
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class NativeDetailPolicyTest {
    @Test fun nanosecondTimesFollowTheDeviceZone() {
        val time = "2026-10-04T00:16:08.845736971+08:00"
        assertEquals("10月4日 00:16", NativeDetailPolicy.localTime(time, ZoneId.of("Asia/Shanghai")))
        assertEquals("10月3日 16:16", NativeDetailPolicy.localTime(time, ZoneId.of("UTC")))
        assertEquals(UserText.get(R.string.claudex_time_unavailable), NativeDetailPolicy.localTime("bad"))
    }
    @Test fun missingBalancesAreNotInventedAsZero() {
        assertNull(NativeDetailPolicy.balance(null, JSONObject()))
        assertEquals(1.25, NativeDetailPolicy.balance(JSONObject().put("balance", 1.25), null)!!, 0.0)
        assertEquals(0.0, NativeDetailPolicy.balance(null, JSONObject().put("balanceUsd", 0))!!, 0.0)
    }
    @Test fun modelPreferenceIncludesAccountOriginAndProvider() {
        assertNotEquals(NativeDetailPolicy.modelKey("origin", "a"), NativeDetailPolicy.modelKey("origin", "b"))
        assertNotEquals(NativeDetailPolicy.modelKey("origin", "a"), NativeDetailPolicy.modelKey("other", "a"))
        val model = ModelOption("same", "test", "test", "provider-b")
        assertEquals(model, NativeDetailPolicy.savedModel(JSONObject().put("model", "same").put("provider", "provider-b").toString(), listOf(model)))
        assertNull(NativeDetailPolicy.savedModel(JSONObject().put("model", "same").put("provider", "provider-a").toString(), listOf(model)))
    }
}
