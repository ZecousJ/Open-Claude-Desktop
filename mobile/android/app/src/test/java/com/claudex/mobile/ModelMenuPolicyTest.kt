package com.claudex.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ModelMenuPolicyTest {
    @Test fun onlyRunnerEffortsAreSent() {
        assertEquals("high", ModelMenuPolicy.payloadEffort("high"))
        assertEquals("ultra", ModelMenuPolicy.payloadEffort("ultra"))
        assertNull(ModelMenuPolicy.payloadEffort("maxed"))
        assertNull(ModelMenuPolicy.payloadEffort(null))
    }
}
