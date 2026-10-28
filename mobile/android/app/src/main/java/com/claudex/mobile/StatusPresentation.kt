package com.claudex.mobile

import org.json.JSONObject
import java.net.URLEncoder
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal object StatusPresentation {
    private val slotFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")
    fun path(end: String?): String {
        require(end == null || end.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}")))
        return "/api/v1/claudex/status?hours=24&step=10" + (end?.let { "&end=" + URLEncoder.encode(it, "UTF-8") } ?: "")
    }
    fun previous(start: String): String? = runCatching { LocalDateTime.parse(start, slotFormat).minusMinutes(10).format(slotFormat) }.getOrNull()
    fun next(end: String, timezone: String, now: Long): String? = runCatching {
        val next = LocalDateTime.parse(end, slotFormat).plusHours(24)
        val current = java.time.Instant.ofEpochMilli(now).atZone(ZoneId.of(timezone)).toLocalDateTime()
        next.takeIf { it < current }?.format(slotFormat)
    }.getOrNull()
    private val rangeFormat = DateTimeFormatter.ofPattern("M月d日 HH:mm")
    /** The window as the page shows it ("10月2日 19:10 — 10月3日 19:00"); the server's text when it does not parse. */
    fun range(start: String, end: String): String = runCatching {
        LocalDateTime.parse(start, slotFormat).format(rangeFormat) + " — " + LocalDateTime.parse(end, slotFormat).format(rangeFormat)
    }.getOrDefault("$start — $end")
    fun uptime(value: Any?): String = (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..100.0 }?.let {
        String.format(java.util.Locale.getDefault(), "%.2f%%", it)
    } ?: UserText.get(R.string.claudex_status_no_data)
    /** The state words follow the web catalog's status vocabulary (Degraded performance, Outage, Investigating, Identified, Monitoring, Resolved). */
    @androidx.annotation.StringRes fun labelRes(level: String): Int = when (level) { "operational" -> R.string.claudex_status_level_operational; "degraded" -> R.string.claudex_status_level_degraded; "outage" -> R.string.claudex_status_level_outage; else -> R.string.claudex_status_no_data }
    @androidx.annotation.StringRes fun incidentRes(status: String): Int = when (status) { "investigating" -> R.string.claudex_status_incident_investigating; "identified" -> R.string.claudex_status_incident_identified; "monitoring" -> R.string.claudex_status_incident_monitoring; "resolved" -> R.string.claudex_status_incident_resolved; else -> R.string.claudex_status_incident_unknown }
    fun label(level: String) = UserText.get(labelRes(level))
    fun incident(status: String) = UserText.get(incidentRes(status))
    fun slots(channel: JSONObject) = channel.optJSONArray("days")?.objects().orEmpty().take(366)
    fun channels(data: JSONObject) = data.optJSONArray("platforms")?.objects().orEmpty().take(50)
    fun incidents(data: JSONObject) = data.optJSONArray("incidents")?.objects().orEmpty().take(200)
}
