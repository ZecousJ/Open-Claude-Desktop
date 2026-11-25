package com.claudex.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceHandoffTest {
    @Test fun aPhoneLinkOpensTheDialerAndAMessageStaysADraft() {
        assertEquals("tel:+15551212", DeviceHandoff.canonical("tel:+1 (555) 1212"))
        assertNull(DeviceHandoff.canonical("tel:12"))
        assertNull(DeviceHandoff.canonical("tel:+15551212?send=1"))
        assertEquals("sms:+15551212?body=hello%20there", DeviceHandoff.canonical("sms:+15551212?body=hello%20there"))
        assertEquals("smsto:?body=See%20you", DeviceHandoff.canonical("smsto:?body=See%20you"))
        assertNull(DeviceHandoff.canonical("sms:+15551212?send=1"))
        assertTrue(DeviceHandoff.mentions("Call tel:+1 (555) 1212.", "tel:+15551212"))
    }

    @Test fun androidSetsAClockOnlyWhileTheAppIsOpen() {
        val alarm = DeviceHandoff.clock("alarm_create_v0", JSONObject("""{"hour":7,"minute":30,"message":"Stand up"}"""), "android", true)
        assertTrue(alarm is DeviceHandoff.Clock.Alarm)
        assertEquals(7, (alarm as DeviceHandoff.Clock.Alarm).hour)
        val background = DeviceHandoff.clock("timer_create_v0", JSONObject("""{"duration_seconds":60,"message":"Tea"}"""), "android", false)
        assertTrue((background as DeviceHandoff.Clock.Failed).reason.contains("open on screen"))
        assertTrue(DeviceHandoff.clock("alarm_create_v0", JSONObject("""{"hour":7,"minute":30,"message":"Stand up"}"""), "ios", true) is DeviceHandoff.Clock.Failed)
        assertNull(DeviceHandoff.clock("other", JSONObject(), "android", true))
        assertTrue(DeviceHandoff.clock("timer_create_v0", JSONObject("""{"duration_seconds":0,"message":"Tea"}"""), "android", true) is DeviceHandoff.Clock.Failed)
    }
}
