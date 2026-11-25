package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectorMenuTest {
    @Test fun allowlistKeepsOnlyTheMatchingDefinition() {
        val servers = JSONObject()
            .put("notes", JSONObject().put("command", "npx").put("args", JSONArray().put("notes")))
            .put("other", JSONObject().put("command", "npx").put("args", JSONArray().put("other")))
            .put("docs", JSONObject().put("url", "https://tools.example/mcp/docs"))
            .put("docsx", JSONObject().put("url", "https://tools.example/mcpx"))
            .put("extension", JSONObject().put("claudex_extension", true).put("command", "ext"))
        val policy = JSONObject().put("connectors", JSONArray()
            .put(JSONObject().put("name", "notes").put("command", "npx").put("args", JSONArray().put("notes")))
            .put(JSONObject().put("name", "docs").put("urlPrefix", "https://tools.example/mcp")))
            .put("desktopExtensionsEnabled", false)
        val rows = ConnectorMenu.rows(servers, policy, mapOf("notes" to false))
        assertEquals(listOf("docs"), rows.filter { it.on }.map { it.name })
        assertEquals(listOf("notes"), rows.filter { !it.on }.map { it.name })
    }

    @Test fun missingPolicyListsNothingAndADisabledAccountFlagStaysOff() {
        val servers = JSONObject().put("notes", JSONObject().put("enabled", false))
        assertTrue(ConnectorMenu.rows(servers, null, emptyMap()).isEmpty())
        val open = JSONObject()
        assertFalse(ConnectorMenu.rows(servers, open, emptyMap()).single().on)
        assertTrue(ConnectorMenu.rows(servers, open, mapOf("notes" to true)).single().on)
    }

    @Test fun prefixStopsAtAPathBoundary() {
        assertTrue(ConnectorMenu.urlUnderPrefix("https://tools.example/mcp/docs", "https://tools.example/mcp"))
        assertTrue(ConnectorMenu.urlUnderPrefix("https://tools.example/mcp", "https://tools.example/mcp"))
        assertFalse(ConnectorMenu.urlUnderPrefix("https://tools.example/mcpx", "https://tools.example/mcp"))
        assertFalse(ConnectorMenu.urlUnderPrefix("http://tools.example/mcp", "https://tools.example/mcp"))
    }
}
