package com.claudex.mobile
internal data class PendingSend(
    val id: String,
    val text: String,
    val attachments: List<String>,
    val projectId: String? = null,
    val resultId: String? = null,
    val failure: String? = null,
    val uploadFailed: Boolean = false,
    val sending: Boolean = false,
)
