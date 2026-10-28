package com.claudex.mobile

import android.content.Context
import android.content.res.Resources
import androidx.annotation.StringRes

/**
 * Words for the lines a person can read that are produced outside a composable (errors, notices, queue states).
 * They live in res/values*.xml like every other string; this only reaches them without a Context at hand.
 * Installed once from the activity / view model; before that (unit tests) it answers with the key's number.
 */
internal object UserText {
    @Volatile private var resources: Resources? = null
    fun install(context: Context) {
        resources = context.applicationContext.resources
        com.claudex.core.CoreText.resolver = { message ->
            get(when (message) {
                com.claudex.core.CoreMessage.FILE_UNAVAILABLE -> R.string.claudex_msg_file_unavailable
                com.claudex.core.CoreMessage.FILE_TOO_LARGE -> R.string.claudex_msg_file_too_large
                com.claudex.core.CoreMessage.FILE_CHECK_FAILED -> R.string.generic_error_something_went_wrong_try_again
                com.claudex.core.CoreMessage.IMAGE_ALT -> R.string.claudex_image_alt
            })
        }
    }
    fun get(@StringRes id: Int, vararg args: Any): String = resources?.getString(id, *args) ?: "#$id"
    fun plural(@androidx.annotation.PluralsRes id: Int, quantity: Int, vararg args: Any): String = resources?.getQuantityString(id, quantity, *args) ?: "#$id"
}

/** The refusal for a file that cannot be added: the official limit lines (chat_input_attachment_limit_reached_toast, chat_input_file_too_large, chat_input_upload_failed). */
internal object AttachmentText {
    fun id(reason: com.claudex.core.AttachmentRejection.Reason): Int = when (reason) {
        com.claudex.core.AttachmentRejection.Reason.COUNT -> R.string.chat_input_attachment_limit_reached_toast
        com.claudex.core.AttachmentRejection.Reason.SIZE -> R.string.chat_input_file_too_large
        com.claudex.core.AttachmentRejection.Reason.NAME -> R.string.chat_input_upload_failed
    }
    fun of(reason: com.claudex.core.AttachmentRejection.Reason): String = when (reason) {
        com.claudex.core.AttachmentRejection.Reason.COUNT -> UserText.get(id(reason), com.claudex.core.AttachmentPolicy.MAX_COUNT)
        com.claudex.core.AttachmentRejection.Reason.SIZE -> UserText.get(id(reason), (com.claudex.core.AttachmentPolicy.MAX_BYTES / (1024 * 1024)).toInt())
        com.claudex.core.AttachmentRejection.Reason.NAME -> UserText.get(id(reason))
    }
}
