package com.claudex.mobile

import org.json.JSONObject
import kotlin.test.*

class SidebarPolicyTest {
    @Test fun profileUsesUsernameBeforeEmailWithHonestFallback() {
        assertEquals("synthetic-user", SidebarPolicy.accountName(JSONObject("""{"username":"synthetic-user","email":"test@example.invalid"}"""), "fallback"))
        assertEquals("test@example.invalid", SidebarPolicy.accountName(JSONObject("""{"username":"","email":"test@example.invalid"}"""), "fallback"))
        assertEquals("fallback", SidebarPolicy.accountName(null, "fallback"))
    }
    @Test fun unreadSurvivesWireRoundTripAndServerMetadataPatch() {
        val wire = JSONObject("""{"id":"synthetic-chat","title":"Synthetic","providerId":"test","model":"test","unread":true,"turns":[]}""")
        val conversation = WireCodec.conversation(wire)
        assertTrue(conversation.unread)
        assertTrue(WireCodec.conversation(conversation).getBoolean("unread"))
        val read = WireCodec.mergeConversationPatch(conversation, JSONObject().put("unread", false))
        assertFalse(read.unread)
        assertFalse(WireCodec.conversation(read).getBoolean("unread"))
    }
    @Test fun oldServerWithoutUnreadDefaultsToRead() {
        assertFalse(WireCodec.conversation(JSONObject("""{"id":"old","providerId":"test","model":"test"}""")).unread)
    }
    @Test fun aReadObservedDuringAnOlderMutationIsNotOverwritten() {
        val before = WireCodec.conversation(JSONObject("""{"id":"synthetic","providerId":"test","model":"test","unread":true}"""))
        val current = WireCodec.mergeConversationPatch(before, JSONObject().put("unread", false))
        val result = WireCodec.preserveObservedMetadata(before, current, before, before)
        assertFalse(result.unread)
        assertFalse(WireCodec.conversation(result).getBoolean("unread"))
    }
}
