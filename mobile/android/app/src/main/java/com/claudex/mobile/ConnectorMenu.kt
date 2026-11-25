package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

/**
 * The add-menu connector switches. A session override wins over the account's enabled flag.
 * The administrator's allowlist comes from clientPolicy; until that answer arrives, nothing is listed.
 */
internal object ConnectorMenu {
    data class Row(val name: String, val on: Boolean)

    fun rows(servers: JSONObject?, policy: JSONObject?, overrides: Map<String, Boolean>): List<Row> {
        if (servers == null || policy == null) return emptyList()
        return servers.keys().asSequence().filter { validName(it) && allowed(policy, it, servers.optJSONObject(it)) }
            .map { name ->
                val config = servers.getJSONObject(name)
                val configured = config.opt("enabled") != false
                Row(name, (overrides[name] ?: configured) != false)
            }
            .sortedBy { it.name }
            .toList()
    }

    fun overridesOf(raw: String?): Map<String, Boolean> {
        val stored = raw?.let(::JSONObject)?.optJSONObject("connectorOverrides") ?: return emptyMap()
        return stored.keys().asSequence().filter(::validName).mapNotNull { key ->
            (stored.opt(key) as? Boolean)?.let { key to it }
        }.toMap()
    }

    fun toggled(current: Map<String, Boolean>, name: String, on: Boolean): Map<String, Boolean> {
        require(validName(name))
        return current + (name to on)
    }

    fun validName(name: String) = name.isNotEmpty() && name.length <= 500 && name.none { it == '\u0000' }

    private fun allowed(policy: JSONObject, name: String, server: JSONObject?): Boolean {
        if (server == null) return false
        if (server.opt("claudex_extension") == true && policy.opt("desktopExtensionsEnabled") == false) return false
        if (server.has("command") && !server.isNull("command") && server.opt("claudex_extension") != true && policy.opt("developerMcpEnabled") == false) return false
        if (!policy.has("connectors") || policy.isNull("connectors")) return true
        val rules = policy.optJSONArray("connectors") ?: return false
        return (0 until rules.length()).any { matches(rules.optJSONObject(it), name, server) }
    }

    private fun matches(rule: JSONObject?, name: String, server: JSONObject): Boolean {
        if (rule == null || rule.optString("name") != name) return false
        if (rule.has("command") && !rule.isNull("command")) {
            return server.optString("command") == rule.optString("command") && sameList(server.opt("args"), rule.optJSONArray("args")) && !server.has("url")
        }
        if (rule.has("url") && !rule.isNull("url")) return server.optString("url") == rule.optString("url") && !server.has("command")
        if (rule.has("urlPrefix") && !rule.isNull("urlPrefix")) {
            return !server.has("command") && urlUnderPrefix(server.optString("url"), rule.optString("urlPrefix"))
        }
        return true
    }

    private fun sameList(value: Any?, expected: JSONArray?): Boolean {
        val actual = (value as? JSONArray)?.let { array -> (0 until array.length()).map { array.opt(it) } } ?: emptyList()
        val wanted = expected?.let { array -> (0 until array.length()).map { array.opt(it) } } ?: emptyList()
        return actual == wanted
    }

    /** An https prefix covers that path and its children, not a longer sibling such as "mcpx". */
    fun urlUnderPrefix(url: String, prefix: String): Boolean {
        val target = runCatching { URI(url) }.getOrNull() ?: return false
        val start = runCatching { URI(prefix) }.getOrNull() ?: return false
        if (target.scheme != "https" || start.scheme != "https") return false
        if (!target.userInfo.isNullOrEmpty() || !start.rawQuery.isNullOrEmpty() || !start.rawFragment.isNullOrEmpty()) return false
        if (!target.host.equals(start.host, ignoreCase = true)) return false
        val targetPort = if (target.port == -1) 443 else target.port
        val startPort = if (start.port == -1) 443 else start.port
        if (targetPort != startPort) return false
        val href = href(target)
        val base = href(start)
        if (!href.startsWith(base)) return false
        return base.endsWith("/") || href.length == base.length || href[base.length] in "/?#"
    }

    private fun href(uri: URI): String {
        val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
        val path = uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
        val query = uri.rawQuery?.let { "?$it" }.orEmpty()
        val fragment = uri.rawFragment?.let { "#$it" }.orEmpty()
        return "https://${uri.host.lowercase()}$port$path$query$fragment"
    }
}
