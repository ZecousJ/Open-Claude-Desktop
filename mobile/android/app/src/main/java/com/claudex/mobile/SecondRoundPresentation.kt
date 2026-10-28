package com.claudex.mobile

import androidx.annotation.StringRes
import com.claudex.core.Mode
import org.json.JSONObject

internal object CapacityErrorPresentation {
    private const val userMessage = "You already have as many runs going as your account allows. Wait for one to finish, then try again."
    /** The string resource for the service's capacity refusal, or null when the error is not one. */
    @StringRes fun resource(code: String, message: String, scope: String? = null): Int? = when {
        code != "CLAUDEX_WEB_CAPACITY" -> null
        scope == "user" || message == userMessage -> R.string.claudex_msg_runs_limit
        else -> R.string.claudex_msg_service_busy
    }
    fun message(code: String, message: String, scope: String? = null): String = resource(code, message, scope)?.let { UserText.get(it) } ?: message
}

internal object DraftScopePolicy {
    fun key(conversationId: String?, projectId: String?, mode: Mode): String = conversationId ?: when (mode) {
        Mode.CHAT -> "new:${projectId.orEmpty()}"
        Mode.CODE -> "new:code:${projectId.orEmpty()}"
        Mode.COWORK -> "new:cowork:${projectId.orEmpty()}"
    }
}

internal object ConversationLoadingPresentation {
    fun thinking(running: Boolean, failed: Boolean, document: Boolean) = running && !failed && !document
}

internal object UsageWindowPresentation {
    fun visible(plan: JSONObject?) = plan?.optJSONArray("windows")?.objects().orEmpty().filter { row ->
        row.optString("label").isNotBlank() && (row.opt("percent") as? Number)?.toDouble()?.isFinite() == true
    }
}

/** Display-only metadata rule; never opens a picker or reads attachment bytes. */
internal object PhotoAttachmentName {
    fun display(name: String, mime: String?, photoPicker: Boolean, index: Int, defaultName: String = UserText.get(R.string.claudex_attachment_default_name), titled: (Int, String) -> String = { n, ext -> UserText.get(R.string.claudex_photo_attachment_name, n, ext) }): String {
        if (!photoPicker || mime?.startsWith("image/") != true || (name !in listOf("", defaultName) && !name.matches(Regex("[0-9]+(?:\\.[A-Za-z0-9]+)?")))) return name
        val extension = name.substringAfterLast('.', "").lowercase().takeIf { it.matches(Regex("[a-z0-9]{1,8}")) }
            ?: when (mime) { "image/png" -> "png"; "image/webp" -> "webp"; "image/gif" -> "gif"; "image/heic" -> "heic"; else -> "jpg" }
        return titled(index.coerceAtLeast(1), extension)
    }
}
