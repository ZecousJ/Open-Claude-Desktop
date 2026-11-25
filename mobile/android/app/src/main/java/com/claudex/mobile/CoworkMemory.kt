package com.claudex.mobile

import com.claudex.core.ApiException
import org.json.JSONArray
import org.json.JSONObject

/** Hosted Cowork account files. A write carries the epoch and revision it was read from. */
internal object CoworkMemory {
    const val PATH = "/api/v1/claudex/memory/cowork"
    data class File(val path: String, val content: String)
    data class Snapshot(val revision: String, val epoch: String, val files: List<File>)

    fun validKey(key: String): Boolean {
        if (key.isEmpty() || key.length > 1024 || key.startsWith("/") || key == "." || key == ".." || !key.endsWith(".md", ignoreCase = true)) return false
        if (key.any { it == '\\' || it == '\u0000' || it == '*' || it == '?' || it == '[' || it == ']' }) return false
        return key.split('/').none { it.isEmpty() || it == "." || it == ".." }
    }

    fun parse(data: JSONObject): Snapshot {
        val entries = data.optJSONObject("entries") ?: JSONObject()
        val files = entries.keys().asSequence().filter(::validKey).sorted().map { File(it, entries.optString(it)) }.toList()
        return Snapshot(data.optString("revision"), data.optString("epoch"), files)
    }

    suspend fun load(api: NativeApi) = parse(api.request(PATH, authorized = true, method = "GET").getJSONObject("data"))

    suspend fun write(api: NativeApi, snapshot: Snapshot, path: String, content: String): Snapshot {
        require(validKey(path) && content.length <= 262_144)
        val body = JSONObject().put("expected_epoch", snapshot.epoch).put("expected_revision", snapshot.revision).put("entries", JSONObject().put(path, content))
        return parse(api.request(PATH, body, authorized = true, method = "PUT").getJSONObject("data"))
    }

    suspend fun delete(api: NativeApi, snapshot: Snapshot, path: String): Snapshot {
        require(validKey(path))
        val body = JSONObject().put("expected_epoch", snapshot.epoch).put("expected_revision", snapshot.revision).put("delete_keys", JSONArray().put(path))
        return parse(api.request(PATH, body, authorized = true, method = "PUT").getJSONObject("data"))
    }

    suspend fun reset(api: NativeApi, snapshot: Snapshot): Snapshot {
        val body = JSONObject().put("expected_epoch", snapshot.epoch)
        return parse(api.request(PATH, body, authorized = true, method = "DELETE").getJSONObject("data"))
    }

    fun conflict(error: Throwable) = error is ApiException && error.code in setOf("CLAUDEX_COWORK_MEMORY_CONFLICT", "CLAUDEX_COWORK_MEMORY_RESET")
}
