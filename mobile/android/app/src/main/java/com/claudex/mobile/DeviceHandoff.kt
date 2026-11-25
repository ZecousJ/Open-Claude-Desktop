package com.claudex.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.AlarmClock
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * System handoff for a clock, a phone number, or a message draft.
 * A call is never placed and a message is never sent from this app.
 * Android may hand a clock time to the system clock without an extra confirmation
 * only while this app is open on screen. iOS always leaves that confirmation to the system.
 */
internal object DeviceHandoff {
    private const val ALARM = "alarm_create_v0"
    private const val TIMER = "timer_create_v0"
    private val phone = Regex("^\\+?[0-9]{3,15}$")

    fun canonical(raw: String): String? {
        if (raw.length !in 1..2048 || raw.any { it < ' ' || it == '\\' }) return null
        val scheme = raw.substringBefore(':', "").lowercase()
        val rest = raw.substringAfter(':', "")
        return when (scheme) {
            "tel" -> digits(rest.takeIf { '?' !in it && '#' !in it } ?: return null)?.let { "tel:$it" }
            "sms", "smsto" -> message(scheme, rest)
            else -> null
        }
    }

    /** Opens a map pin or route outside this app. False when no maps app or browser can take it. */
    fun openMap(context: Context, link: String): Boolean {
        if (!link.startsWith("geo:") && !link.startsWith("https://www.google.com/maps/")) return false
        val uri = Uri.parse(link)
        val maps = Intent(Intent.ACTION_VIEW, uri).setPackage("com.google.android.apps.maps").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (maps.resolveActivity(context.packageManager) != null && runCatching { context.startActivity(maps) }.isSuccess) return true
        val any = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (runCatching { context.startActivity(any) }.isSuccess) return true
        if (!link.startsWith("geo:")) return false
        val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/maps/search/?api=1&query=${link.removePrefix("geo:").substringBefore('?')}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(web) }.isSuccess
    }

    /** True when [source] contains the same dial or message draft as [canonical]. */
    fun mentions(source: String, canonical: String): Boolean {
        val pattern = Regex("(?i)(?:tel:|sms:|smsto:)[+0-9() .?%=&~_-]{1,300}")
        return pattern.findAll(source).any { match ->
            var value = match.value.trimEnd('.', ',', ';', '!', '?')
            while (value.endsWith(')') && value.count { it == ')' } > value.count { it == '(' }) value = value.dropLast(1)
            canonical(value) == canonical
        }
    }

    fun viewIntent(url: String): Intent {
        val canonical = canonical(url) ?: return Intent(Intent.ACTION_VIEW, Uri.parse(url))
        return if (canonical.startsWith("tel:")) Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", canonical.removePrefix("tel:"), null))
        else Intent(Intent.ACTION_SENDTO, Uri.parse(canonical))
    }

    sealed class Clock {
        data class Alarm(val hour: Int, val minute: Int, val message: String, val days: List<Int>?, val vibrate: Boolean?) : Clock()
        data class Timer(val seconds: Int, val message: String) : Clock()
        data class Failed(val reason: String) : Clock()
    }

    /**
     * The clock request the model named. Null when [name] is not a clock tool.
     * [platform] is "android" or "ios". A background Android request is the official refusal.
     */
    fun clock(name: String, input: JSONObject, platform: String, foreground: Boolean): Clock? {
        if (name != ALARM && name != TIMER) return null
        if (platform == "android" && !foreground) {
            val which = if (name == ALARM) "alarm" else "timer"
            return Clock.Failed("Failed to set $which: Android only lets Claude set a $which while the Claude app is open on screen, and it is not right now, so no $which was set. Tell the user it was not set; it will work once the Claude app is open on screen.")
        }
        if (platform != "android") return Clock.Failed(if (name == ALARM) "Failed to set alarm." else "Failed to set timer on device.")
        return if (name == ALARM) alarm(input) else timer(input)
    }

    fun clockIntent(plan: Clock): Intent? = when (plan) {
        is Clock.Alarm -> Intent(AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(AlarmClock.EXTRA_HOUR, plan.hour)
            putExtra(AlarmClock.EXTRA_MINUTES, plan.minute)
            putExtra(AlarmClock.EXTRA_MESSAGE, plan.message)
            putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            plan.vibrate?.let { putExtra(AlarmClock.EXTRA_VIBRATE, it) }
            plan.days?.let { putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS, ArrayList(it)) }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        is Clock.Timer -> Intent(AlarmClock.ACTION_SET_TIMER).apply {
            putExtra(AlarmClock.EXTRA_LENGTH, plan.seconds)
            putExtra(AlarmClock.EXTRA_MESSAGE, plan.message)
            putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        is Clock.Failed -> null
    }

    private fun alarm(input: JSONObject): Clock {
        val hour = exactInt(input, "hour") ?: return Clock.Failed("Failed to set alarm.")
        val minute = exactInt(input, "minute") ?: return Clock.Failed("Failed to set alarm.")
        val message = text(input, "message") ?: return Clock.Failed("Failed to set alarm.")
        if (hour !in 0..23 || minute !in 0..59) return Clock.Failed("Failed to set alarm.")
        val days = if (input.has("days") && !input.isNull("days")) days(input.optJSONArray("days")) ?: return Clock.Failed("Failed to set alarm.") else null
        val vibrate = if (input.has("vibrate") && !input.isNull("vibrate")) input.opt("vibrate") as? Boolean ?: return Clock.Failed("Failed to set alarm.") else null
        return Clock.Alarm(hour, minute, message, days, vibrate)
    }

    private fun timer(input: JSONObject): Clock {
        val seconds = exactInt(input, "duration_seconds") ?: return Clock.Failed("Failed to set timer on device.")
        val message = text(input, "message") ?: return Clock.Failed("Failed to set timer on device.")
        if (seconds !in 1..86_400) return Clock.Failed("Failed to set timer on device.")
        return Clock.Timer(seconds, message)
    }

    private fun days(array: JSONArray?): List<Int>? {
        if (array == null || array.length() !in 1..7) return null
        val values = (0 until array.length()).map { exactInt(array.opt(it)) ?: return null }
        if (values.distinct().size != values.size || values.any { it !in 1..7 }) return null
        return values
    }

    private fun text(input: JSONObject, key: String): String? {
        val value = input.opt(key) as? String ?: return null
        val trimmed = value.trim()
        return trimmed.takeIf { it.length in 1..200 }
    }

    private fun exactInt(input: JSONObject, key: String): Int? = if (input.has(key) && !input.isNull(key)) exactInt(input.opt(key)) else null

    private fun exactInt(value: Any?): Int? {
        val number = value as? Number ?: return null
        val whole = number.toDouble()
        if (!whole.isFinite() || whole % 1.0 != 0.0 || whole !in Int.MIN_VALUE.toDouble()..Int.MAX_VALUE.toDouble()) return null
        return whole.toInt()
    }

    private fun digits(raw: String?): String? {
        if (raw.isNullOrEmpty()) return null
        val cleaned = buildString {
            for (ch in raw) when (ch) {
                in '0'..'9', '+' -> append(ch)
                ' ', '(', ')', '-', '.' -> Unit
                else -> return null
            }
        }
        if (cleaned.count { it == '+' } > 1 || (cleaned.contains('+') && !cleaned.startsWith('+'))) return null
        return cleaned.takeIf { phone.matches(it) }
    }

    private fun message(scheme: String, rest: String): String? {
        if ('#' in rest) return null
        val recipient = rest.substringBefore('?')
        val query = rest.substringAfter('?', "")
        if ('?' in query) return null
        val number = if (recipient.isEmpty()) "" else digits(recipient) ?: return null
        val body = if (query.isEmpty()) null else {
            if (!query.startsWith("body=")) return null
            decode(query.removePrefix("body=")) ?: return null
        }
        if (number.isEmpty() && body.isNullOrEmpty()) return null
        val encoded = body?.let(::encode).orEmpty()
        val target = if (number.isEmpty()) "$scheme:?body=$encoded" else if (body == null) "$scheme:$number" else "$scheme:$number?body=$encoded"
        return target
    }

    private fun decode(value: String): String? {
        if (value.length > 3000 || value.any { it == '+' || it <= ' ' }) return null
        val text = runCatching { URLDecoder.decode(value, StandardCharsets.UTF_8) }.getOrNull() ?: return null
        if (text.length !in 1..1000 || text.any { it < ' ' && it != '\n' && it != '\t' }) return null
        return text
    }

    private fun encode(text: String): String = buildString {
        for (ch in text) when {
            ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch in "-_.~" -> append(ch)
            ch == ' ' -> append("%20")
            else -> ch.toString().toByteArray(StandardCharsets.UTF_8).forEach { append("%" + "%02X".format(it.toInt() and 0xFF)) }
        }
    }
}
