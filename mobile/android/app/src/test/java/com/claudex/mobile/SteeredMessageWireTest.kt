package com.claudex.mobile

import com.claudex.core.Item
import kotlin.test.*
import org.junit.Test

class SteeredMessageWireTest {
    @Test fun consumedInstructionKeepsVisibleTextAndReceiptMetadata() {
        val item = Item("receipt", "userMessage", "Quoted \"instruction\"\nnext line", rawJson = """{"id":"receipt","type":"userMessage","steered":true,"clientId":"client-70","attachments":[{"id":"file-70"}]}""")
        val encoded = WireCodec.item(item)
        assertEquals(item.text, encoded.getString("text"))
        assertTrue(encoded.getBoolean("steered"))
        assertEquals("client-70", encoded.getString("clientId"))
        assertEquals("file-70", encoded.getJSONArray("attachments").getJSONObject(0).getString("id"))
    }
    @Test fun messageEncodingDoesNotReplaceStructuredToolPayloadWithNativeSummary() {
        val item = Item("tool", "commandExecution", "Native summary", rawJson = """{"id":"tool","type":"commandExecution","aggregatedOutput":"original output","command":"echo synthetic"}""")
        val encoded = WireCodec.item(item)
        assertFalse(encoded.has("text"))
        assertEquals("original output", encoded.getString("aggregatedOutput"))
    }
}
