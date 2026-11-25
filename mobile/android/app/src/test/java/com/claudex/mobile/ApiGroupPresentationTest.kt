package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ApiGroupPresentationTest {
    @Test fun ownRatesOverrideValidAvailableRatesAndZeroIsNotMissing() {
        val rates = ApiGroupPresentation.rates(JSONArray("""[{"id":1,"rate_multiplier":1.5},{"id":2,"rate_multiplier":0},{"id":3,"rate_multiplier":"1"}]"""), JSONObject("""{"1":0.25,"2":-1,"x":3}"""))
        assertEquals(mapOf(1L to 0.25, 2L to 0.0), rates)
        assertEquals("0x", ApiGroupPresentation.rateText(rates[2])); assertEquals("0.25x", ApiGroupPresentation.rateText(rates[1]))
        assertEquals(UserText.get(R.string.claudex_rate_unavailable), ApiGroupPresentation.rateText(rates[3]))
    }
    @Test fun metadataNeverDisplaysCredentialOrQueryOrigins() {
        assertEquals("https://example.com:8443", ApiGroupPresentation.origin("https://example.com:8443/api"))
        assertNull(ApiGroupPresentation.origin("https://secret@example.com"))
        assertNull(ApiGroupPresentation.origin("https://example.com?token=synthetic"))
        assertEquals(UserText.get(R.string.claudex_rate_unavailable), ApiGroupPresentation.rateText(Double.NaN))
    }
}
