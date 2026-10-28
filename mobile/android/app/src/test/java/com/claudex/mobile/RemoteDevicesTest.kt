package com.claudex.mobile

import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RemoteDevicesTest {
    private val turnOne = """{"id":"t1","prompt":"fix it","attachments":[],"items":[],"status":"completed","createdAt":0}"""
    private val conversation = """{"id":"c1","title":"Fix the build","mode":"code","cwd":"/Users/me/Claudex","providerId":"p1","model":"gpt-5.5","pinned":false,"archived":false,"createdAt":0,"updatedAt":1,"turns":[$turnOne]}"""
    private fun state() = DeviceConversationState("pc-0123456789", WireCodec.conversation(JSONObject(conversation)), emptyList())

    @Test fun turnEventsAppendReplaceAndPatch() {
        val running = """{"type":"conversation-turn","conversationId":"c1","turn":{"id":"t2","prompt":"run tests","attachments":[],"items":[],"status":"inProgress","createdAt":2},"conversation":{"title":"Run the tests","updatedAt":2}}"""
        val next = state().applying(JSONObject(running))!!
        assertEquals(listOf("t1", "t2"), next.conversation.turns.map { it.id })
        assertEquals("Run the tests", next.conversation.title)
        assertTrue(next.running)
        val done = next.applying(JSONObject(running.replace("inProgress", "completed")))!!
        assertEquals(2, done.conversation.turns.size)
        assertFalse(done.running)
        assertNull(state().applying(JSONObject(running.replace("\"conversationId\":\"c1\"", "\"conversationId\":\"c2\""))))
    }

    @Test fun approvalsComeAndGo() {
        val approval = """{"type":"approval","approval":{"id":7,"conversationId":"c1","method":"item/commandExecution/requestApproval","params":{"command":"npm test"}}}"""
        val waiting = state().applying(JSONObject(approval))!!.applying(JSONObject(approval))!!
        assertEquals(1, waiting.approvals.size)
        assertTrue(waiting.approvals.single().numericId)
        assertNull(state().applying(JSONObject(approval.replace("\"conversationId\":\"c1\"", "\"conversationId\":\"c9\""))))
        val resolved = waiting.applying(JSONObject("""{"type":"approval-resolved","id":7}"""))!!
        assertTrue(resolved.approvals.isEmpty())
        assertNull(resolved.applying(JSONObject("""{"type":"approval-resolved","id":7}""")))
    }

    @Test fun streamEventsAndWords() {
        assertEquals(DeviceStreamEvent.DevicesChanged, DeviceStreamEvent.from(JSONObject("""{"type":"devices-changed"}""")))
        val device = DeviceStreamEvent.from(JSONObject("""{"type":"device-event","deviceId":"pc-0123456789","event":{"type":"device-conversations"}}""")) as DeviceStreamEvent.Device
        assertEquals("pc-0123456789", device.id)
        assertEquals("device-conversations", device.event.getString("type"))
        assertNull(DeviceStreamEvent.from(JSONObject("""{"type":"device-event","event":{"type":"x"}}""")))
        assertNull(DeviceStreamEvent.from(JSONObject("""{"type":"conversation"}""")))
        assertEquals(R.string.claudex_msg_offline_computer, DeviceClient.messageRes("CLAUDEX_DEVICE_OFFLINE", "This computer is not online."))
        assertEquals(R.string.claudex_msg_request_answered, DeviceClient.messageRes(null, "This request was already answered."))
        assertEquals("Custom refusal", DeviceClient.message(null, "Custom refusal"))
        assertEquals("Claudex", DeviceConversationSummary("c", "t", "/Users/me/Claudex", 0, false, 0, "m").folderName)
        assertEquals("claudex", DeviceConversationSummary("c", "t", "C:\\build\\claudex", 0, false, 0, "m").folderName)
        assertEquals("Windows", DeviceInfo("pc-1", "Studio", "win32", "0.0.10", "").platformName)
    }
}
