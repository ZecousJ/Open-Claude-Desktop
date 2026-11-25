package com.claudex.mobile

import com.claudex.core.Mode
import java.net.URI
import java.net.URLDecoder

/** A claudex:// or https://claudex.zecous.cn link. The text is only placed in the composer. */
internal sealed class AppLink {
    data class Chat(val id: String) : AppLink()
    data class Project(val id: String) : AppLink()
    data class Composer(val mode: Mode, val prompt: String?) : AppLink()
}

internal object AppLinks {
    private val sites = setOf("claudex.zecous.cn", "claude.ai")
    private val id = Regex("^[A-Za-z0-9_-]{1,128}$")

    fun parse(href: String): AppLink? {
        val uri = runCatching { URI(href) }.getOrNull() ?: return null
        if (uri.userInfo != null) return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()
        val path = (uri.rawPath ?: "").split("/").filter { it.isNotEmpty() }.map { decode(it) ?: return null }
        val parts = when (scheme) {
            "claudex" -> {
                val all = listOfNotNull(host?.let { decode(it) }) + path
                if (all.firstOrNull() in sites) all.drop(1) else all
            }
            "https" -> if (host == "claudex.zecous.cn") path else return null
            else -> return null
        }
        val prompt = query(uri, "q")?.take(10_000)?.takeIf { it.isNotEmpty() }
        val first = parts.getOrNull(0)
        val second = parts.getOrNull(1)
        if (parts.size == 1 && first == "new") return AppLink.Composer(if (query(uri, "surface") == "cowork") Mode.COWORK else Mode.CHAT, prompt)
        if (first == "chat" && second == "new") return AppLink.Composer(Mode.CHAT, prompt)
        if (first == "cowork" && second == "new") return AppLink.Composer(Mode.COWORK, prompt)
        if (first == "cowork" && second == "project" && valid(parts.getOrNull(2))) return AppLink.Project(parts[2])
        if ((first == "chat" || first == "conversation") && valid(second)) return AppLink.Chat(second!!)
        if (first == "project" && valid(second)) return AppLink.Project(second!!)
        if (first == "code" && (second == null || second == "new")) {
            if (query(uri, "ssh_host") != null) return null
            return AppLink.Composer(Mode.CODE, prompt ?: query(uri, "prompt")?.take(10_000)?.takeIf { it.isNotEmpty() })
        }
        if (first == "code" && (second == "continue" || second == "needs-input") && valid(query(uri, "session"))) return AppLink.Chat(query(uri, "session")!!)
        return null
    }

    private fun valid(value: String?) = value != null && id.matches(value)
    private fun decode(value: String) = runCatching { URLDecoder.decode(value, Charsets.UTF_8) }.getOrNull()
    private fun query(uri: URI, name: String): String? {
        val raw = uri.rawQuery ?: return null
        return raw.split("&").firstNotNullOfOrNull { pair ->
            val bits = pair.split("=", limit = 2)
            if (decode(bits[0]) == name) decode(bits.getOrElse(1) { "" }) else null
        }
    }
}
