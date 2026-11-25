package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.math.RoundingMode
import java.net.URI

internal object ApiGroupPresentation {
    private fun rate(value: Any?): Double? = (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 }
    fun rates(available: Any?, own: Any?): Map<Long, Double> {
        val result = mutableMapOf<Long, Double>()
        (available as? JSONArray)?.objects()?.forEach { group ->
            val id = group.opt("id") as? Number
            val value = rate(group.opt("rate_multiplier"))
            if (id != null && id.toDouble() == id.toLong().toDouble() && id.toLong() in 1..9_007_199_254_740_991L && value != null) result[id.toLong()] = value
        }
        (own as? JSONObject)?.let { values -> values.keys().forEach { key ->
            val id = key.takeIf { it.matches(Regex("[0-9]+")) }?.toLongOrNull()
            val value = rate(values.opt(key))
            if (id != null && id in 1..9_007_199_254_740_991L && value != null) result[id] = value
        } }
        return result
    }
    fun rateText(value: Double?): String = value?.takeIf { it.isFinite() && it >= 0 }?.let {
        BigDecimal.valueOf(it).setScale(4, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString() + "x"
    } ?: UserText.get(R.string.claudex_rate_unavailable)
    fun origin(value: String): String? = runCatching { URI(value).takeIf { it.scheme in listOf("http", "https") && it.host != null && it.userInfo == null && it.query == null && it.fragment == null }?.let { "${it.scheme}://${it.host}${if (it.port == -1) "" else ":${it.port}"}" } }.getOrNull()
}
