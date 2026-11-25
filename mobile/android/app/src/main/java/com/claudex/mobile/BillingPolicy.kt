package com.claudex.mobile

import org.json.JSONObject
import java.util.Locale

/** The account's monthly spend cap and a redeem code, as the service reports them. */
object BillingPolicy {
    private val amount = Regex("""^\d+(\.\d{1,2})?$""")
    private val code = Regex("""^[A-Za-z0-9_-]{4,128}$""")
    private val reset = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$""")
    private val days = intArrayOf(31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

    data class Spend(val limitUsd: Double?, val usedUsd: Double, val resetsAt: String)
    data class Redeemed(val type: String, val value: Double, val plan: String, val days: Int)

    /** 20 or 20.50, with an optional dollar sign. Null when it is not an amount this account can save. */
    fun parseAmount(text: String): Double? {
        val value = text.replace(Regex("""[$,\s]"""), "")
        if (!amount.matches(value)) return null
        val number = value.toDoubleOrNull() ?: return null
        return if (number.isFinite() && number <= 100_000.0) number else null
    }

    fun money(value: Double, whole: Boolean = false): String {
        if (whole && value % 1.0 == 0.0) return "$${value.toLong()}"
        return String.format(Locale.US, "$%.2f", value)
    }

    /** The spend-limit document, or null when the service did not return one. */
    fun spend(data: JSONObject?): Spend? {
        if (data == null || data.optString("currency") != "USD" || !data.has("limit_usd") || !data.has("used_usd")) return null
        val used = data.optDouble("used_usd")
        if (!used.isFinite() || used < 0) return null
        val limit = if (data.isNull("limit_usd")) null else data.optDouble("limit_usd")
        if (limit != null && (!limit.isFinite() || limit < 0 || limit > 100_000.0)) return null
        val resets = data.optString("resets_at")
        if (!validReset(resets)) return null
        return Spend(limit, used, resets)
    }

    fun acceptsCode(raw: String) = code.matches(raw.trim())

    fun redeemed(data: JSONObject?): Redeemed? {
        if (data == null || !data.has("type")) return null
        val value = data.optDouble("value")
        return Redeemed(
            data.optString("type"),
            if (value.isFinite() && value >= 0) value else 0.0,
            data.optJSONObject("group")?.optString("name").orEmpty(),
            data.optInt("validity_days").coerceAtLeast(0),
        )
    }

    /** A known redeem refusal. Anything else stays with the caller. */
    fun redeemProblem(code: String): String? = when (code) {
        "REDEEM_CODE_NOT_FOUND" -> "missing"
        "REDEEM_CODE_USED" -> "used"
        "REDEEM_CODE_EXPIRED" -> "expired"
        "REDEEM_CODE_LOCKED" -> "locked"
        "REDEEM_RATE_LIMITED" -> "limited"
        else -> null
    }

    data class PayMethod(val id: String, val currency: String, val min: Double, val max: Double, val browser: Boolean)
    data class Checkout(val methods: List<PayMethod>, val balance: Boolean, val min: Double, val max: Double)
    sealed class PayLaunch {
        data class Open(val url: String) : PayLaunch()
        data class Qr(val code: String) : PayLaunch()
        data class CheckoutLink(val orderId: Long, val resume: String, val secret: String, val intent: String, val currency: String, val country: String, val env: String) : PayLaunch()
        data class Unavailable(val reason: String, val hide: Boolean) : PayLaunch()
    }
    sealed class TopUp {
        data class Browser(val url: String, val orderId: Long) : TopUp()
        data class Qr(val code: String, val orderId: Long) : TopUp()
        data class Failed(val reason: String) : TopUp()
    }

    private val aliases = mapOf("alipay" to "alipay", "alipay_direct" to "alipay", "wxpay" to "wxpay", "wxpay_direct" to "wxpay", "stripe" to "stripe", "airwallex" to "airwallex")
    private val methodOrder = listOf("alipay", "wxpay", "stripe", "airwallex")
    private val browserMethods = setOf("stripe", "airwallex")
    private val checkoutToken = Regex("""^[A-Za-z0-9_-]{16,200}$""")

    /** Methods this app can pay with. Card methods need the service's browser checkout. */
    fun checkout(info: JSONObject?, desktopCheckout: Boolean): Checkout? {
        val methods = info?.optJSONObject("methods") ?: return null
        val found = linkedMapOf<String, PayMethod>()
        val keys = methods.keys().asSequence().toList()
        for (key in keys) {
            val item = methods.optJSONObject(key) ?: continue
            val type = item.optString("payment_type").ifBlank { key }.take(40)
            val id = aliases[type] ?: continue
            if (browserMethods.contains(id) && !desktopCheckout) continue
            val canonical = type == id
            if (found.containsKey(id) && !canonical) continue
            val currency = item.optString("currency").trim().uppercase(Locale.US).takeIf { it.matches(Regex("[A-Z]{3}")) } ?: "CNY"
            found[id] = PayMethod(id, currency, item.optDouble("single_min").coerceAtLeast(0.0), item.optDouble("single_max").coerceAtLeast(0.0), browserMethods.contains(id))
        }
        val listed = methodOrder.mapNotNull { found[it] }
        if (listed.isEmpty()) return null
        val balance = info.optBoolean("balance_disabled") != true
        return Checkout(listed, balance, info.optDouble("global_min").coerceAtLeast(0.0), info.optDouble("global_max").coerceAtLeast(0.0))
    }

    /** Why this top-up cannot be ordered, or null when the amount is acceptable. */
    fun amountProblem(amount: Double?, method: PayMethod, floor: Double, ceiling: Double): String? {
        if (amount == null || !amount.isFinite() || amount <= 0) return "empty"
        val min = maxOf(method.min, floor)
        val caps = listOf(method.max, ceiling).filter { it > 0 }
        val max = caps.minOrNull() ?: Double.POSITIVE_INFINITY
        if (min > 0 && amount < min) return "low"
        if (amount > max) return "high"
        return null
    }

    /** How to pay an order the service just created. A client secret never becomes part of a URL. */
    fun launch(order: JSONObject?, desktopCheckout: Boolean): PayLaunch {
        if (order == null) return PayLaunch.Unavailable("unknown", false)
        val secret = order.optString("client_secret")
        if (secret.isNotEmpty()) {
            val resume = order.optString("resume_token")
            val orderId = order.optLong("order_id")
            if (!desktopCheckout || resume.isEmpty() || orderId <= 0) return PayLaunch.Unavailable("desktop", true)
            return PayLaunch.CheckoutLink(orderId, resume, secret, order.optString("intent_id"), order.optString("currency"), order.optString("country_code"), order.optString("payment_env"))
        }
        val result = order.optString("result_type")
        if (result == "oauth_required" || result == "jsapi_ready") return PayLaunch.Unavailable("wechat", true)
        val mode = order.optString("payment_mode").trim().lowercase(Locale.US)
        val redirect = mode == "redirect" || mode == "popup"
        val qr = order.optString("qr_code")
        val page = order.optString("pay_url")
        if (qr.isNotEmpty() && !(redirect && page.isNotEmpty())) return PayLaunch.Qr(qr.take(4000))
        if (page.isNotEmpty()) return httpsUrl(page, 4000)?.let { PayLaunch.Open(it) } ?: PayLaunch.Unavailable("insecure", false)
        return PayLaunch.Unavailable("unknown", false)
    }

    /** The service's browser checkout page. The token is the only thing added, and only as the fragment. */
    fun desktopPay(origin: String, token: String): String? {
        if (!checkoutToken.matches(token)) return null
        val base = origin.trim().trimEnd('/')
        val root = httpsUrl(base, 2000) ?: return null
        return "$root/desktop-pay#t=$token"
    }

    fun httpsUrl(value: String, max: Int = 2000): String? {
        if (value.isEmpty() || value.length > max) return null
        val uri = runCatching { java.net.URI(value) }.getOrNull() ?: return null
        if (!uri.isAbsolute || uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null) return null
        return value
    }

    fun validReset(value: String): Boolean {
        if (value.length > 64) return false
        val match = reset.matchEntire(value) ?: return false
        val year = match.groupValues[1].toInt()
        val month = match.groupValues[2].toInt()
        val day = match.groupValues[3].toInt()
        val hour = match.groupValues[4].toInt()
        val minute = match.groupValues[5].toInt()
        val second = match.groupValues[6].toInt()
        val leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        val length = if (month == 2 && leap) 29 else days.getOrNull(month - 1) ?: return false
        return month in 1..12 && day in 1..length && hour < 24 && minute < 60 && second < 60
    }
}
