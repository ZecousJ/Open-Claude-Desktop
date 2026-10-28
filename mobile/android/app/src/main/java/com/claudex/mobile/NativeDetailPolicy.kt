package com.claudex.mobile

import com.claudex.core.ModelOption
import org.json.JSONObject
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

internal object NativeDetailPolicy {
    fun localTime(value: String, zone: ZoneId = ZoneId.systemDefault()): String =
        runCatching { OffsetDateTime.parse(value).atZoneSameInstant(zone).format(DateTimeFormatter.ofPattern("M月d日 HH:mm", Locale.SIMPLIFIED_CHINESE)) }.getOrElse { UserText.get(R.string.claudex_time_unavailable) }
    fun balance(billing: JSONObject?, usage: JSONObject?): Double? =
        ((billing?.opt("balance") as? Number) ?: (usage?.opt("balanceUsd") as? Number))?.toDouble()?.takeIf { it.isFinite() }
    fun modelKey(origin: String, account: String): String? = account.takeIf { it.isNotBlank() }?.let {
        "model." + java.security.MessageDigest.getInstance("SHA-256").digest((origin + "\n" + it).toByteArray()).joinToString("") { b -> "%02x".format(b.toInt() and 255) }
    }
    fun savedModel(raw: String?, models: List<ModelOption>): ModelOption? = runCatching {
        val choice = JSONObject(raw ?: return null)
        models.find { it.id == choice.optString("model") && it.providerId == choice.optString("provider") }
    }.getOrNull()
}
