package com.claudex.mobile

import com.claudex.core.*
import org.json.JSONObject

/**
 * The card needs only the descriptor; the app opens the picture from its own
 * file. 2 MiB (the inline thumbnail limit) left most generated pictures out.
 */
private const val MAX_IMAGE_BYTES = 64L * 1024 * 1024

internal data class ImageToolRequest(val itemId: String, val path: String, val viewed: Boolean)
internal object ImageToolSnapshotPolicy {
    private val mimes = setOf("image/png", "image/jpeg", "image/webp")
    fun request(item: Item): ImageToolRequest? {
        val viewed = item.type == "imageView"
        if (!viewed && item.type != "imageGeneration") return null
        val path = JSONObject(item.rawJson ?: "{}").optString(if (viewed) "path" else "savedPath")
        if (path.isBlank() || path.length > 4096 || '\u0000' in path) return null
        return ImageToolRequest(item.id, path, viewed)
    }
    fun descriptor(request: ImageToolRequest, snapshot: JSONObject): GeneratedFile? {
        val digest = snapshot.optString("digest")
        val mime = snapshot.optString("mime")
        val bytes = snapshot.opt("bytes") as? Number ?: return null
        val size = bytes.toLong()
        if (!Regex("[a-f0-9]{64}").matches(digest) || mime !in mimes || size <= 0 || size > MAX_IMAGE_BYTES || bytes.toDouble() != size.toDouble()) return null
        val extension = when (mime) { "image/png" -> "png"; "image/jpeg" -> "jpg"; else -> "webp" }
        val name = request.path.replace('\\', '/').substringAfterLast('/').ifBlank { "image.$extension" }
        return GeneratedFile("image-tool:${request.itemId}:$digest", if ('.' in name) name else "$name.$extension", "ready", digest, size, mime, true, language = "text", path = request.path)
    }
    fun matches(item: Item, request: ImageToolRequest) = this.request(item) == request
    fun retainCapturedImages(previous: Conversation?, incoming: Conversation): Conversation {
        if (previous == null || previous.id != incoming.id) return incoming
        return incoming.copy(turns = incoming.turns.map { turn ->
            val oldTurn = previous.turns.find { it.id == turn.id }
            turn.copy(items = turn.items.map { item ->
                val request = request(item)
                val old = oldTurn?.items?.find { it.id == item.id }
                if (request == null || old == null || !matches(old, request)) item
                else item.copy(generatedFiles = item.generatedFiles + old.generatedFiles.filter { file ->
                    file.id.startsWith("image-tool:") && file.path == request.path && item.generatedFiles.none { it.path == file.path }
                })
            })
        })
    }
}
