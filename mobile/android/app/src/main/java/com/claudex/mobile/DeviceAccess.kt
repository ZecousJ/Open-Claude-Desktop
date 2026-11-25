package com.claudex.mobile

import org.json.JSONObject
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.OffsetDateTime
import java.util.Locale
import kotlin.math.round

/**
 * What a location or calendar tool may return.
 * A denied or restricted permission returns no coordinates and no event titles.
 * An approximate grant, or an approximate request, keeps the fix to about a kilometre.
 */
internal object DeviceAccess {
    /**
     * The system map link for pins the model already named.
     * One pin opens that place. Several pins open the route from the first to the last.
     */
    fun mapLink(input: JSONObject): String? {
        if (!shortText(input, "title") || !shortText(input, "narrative")) return null
        if (input.has("mode") && !input.isNull("mode") && input.optString("mode") !in setOf("markers", "itinerary")) return null
        if (input.has("travel_mode") && !input.isNull("travel_mode") && input.optString("travel_mode") !in setOf("driving", "walking", "transit", "bicycling")) return null
        val showRoute = if (!input.has("show_route") || input.isNull("show_route")) null else input.opt("show_route") as? Boolean ?: return null
        val pins = if (input.has("markers") && !input.isNull("markers")) markerPins(input) ?: return null else placePins(input) ?: return null
        val opened = if (showRoute == false) listOf(pins.first()) else pins
        val link = if (opened.size == 1) {
            val pin = pins[0]
            "geo:${coord(pin.first.first)},${coord(pin.first.second)}?q=${URLEncoder.encode(pin.second, StandardCharsets.UTF_8)}"
        } else {
            val origin = pins.first().first
            val destination = pins.last().first
            val via = pins.drop(1).dropLast(1).joinToString("|") { "${coord(it.first.first)},${coord(it.first.second)}" }
            val route = "https://www.google.com/maps/dir/?api=1&origin=${coord(origin.first)},${coord(origin.second)}&destination=${coord(destination.first)},${coord(destination.second)}"
            if (via.isEmpty()) route else "$route&waypoints=${URLEncoder.encode(via, StandardCharsets.UTF_8)}"
        }
        return link.takeIf { it.length <= 2048 }
    }

    private fun markerPins(input: JSONObject): List<Pair<Pair<Double, Double>, String>>? {
        if (!input.has("markers") || input.isNull("markers")) return null
        val markers = input.optJSONArray("markers") ?: return null
        if (markers.length() !in 1..10) return null
        return List(markers.length()) { index ->
            val marker = markers.optJSONObject(index) ?: return null
            val title = (marker.opt("title") as? String)?.trim()?.takeIf { it.length in 1..200 } ?: return null
            if (marker.has("label") && !marker.isNull("label")) {
                val label = (marker.opt("label") as? String)?.trim()
                if (label.isNullOrEmpty() || label.length > 200) return null
            }
            pin(marker, title) ?: return null
        }
    }

    private fun placePins(input: JSONObject): List<Pair<Pair<Double, Double>, String>>? {
        val days = if (!input.has("days") || input.isNull("days")) null else input.optJSONArray("days") ?: return null
        val locations = if (days != null) {
            if (days.length() !in 1..10) return null
            val gathered = org.json.JSONArray()
            for (index in 0 until days.length()) {
                val day = days.optJSONObject(index) ?: return null
                val number = day.opt("day_number") as? Number ?: return null
                val dayNumber = number.toDouble()
                if (!dayNumber.isFinite() || dayNumber % 1.0 != 0.0 || dayNumber !in 1.0..366.0) return null
                if (!shortText(day, "title") || !shortText(day, "narrative")) return null
                val stops = day.optJSONArray("locations") ?: return null
                for (stop in 0 until stops.length()) gathered.put(stops.opt(stop))
            }
            gathered
        } else if (!input.has("locations") || input.isNull("locations")) return null else input.optJSONArray("locations") ?: return null
        if (locations.length() !in 1..10) return null
        return List(locations.length()) { index ->
            val place = locations.optJSONObject(index) ?: return null
            val name = (place.opt("name") as? String)?.trim()?.takeIf { it.length in 1..200 } ?: return null
            if (!shortText(place, "address") || !shortText(place, "notes") || !shortText(place, "place_id") || !shortText(place, "arrival_time")) return null
            pin(place, name) ?: return null
        }
    }

    private fun pin(item: JSONObject, title: String): Pair<Pair<Double, Double>, String>? {
        val latitude = (item.opt("latitude") as? Number)?.toDouble() ?: return null
        val longitude = (item.opt("longitude") as? Number)?.toDouble() ?: return null
        if (!latitude.isFinite() || !longitude.isFinite() || latitude !in -90.0..90.0 || longitude !in -180.0..180.0) return null
        return latitude to longitude to title
    }

    private fun shortText(input: JSONObject, key: String): Boolean {
        if (!input.has(key) || input.isNull(key)) return true
        val value = (input.opt(key) as? String)?.trim() ?: return false
        return value.isNotEmpty() && value.length <= 200
    }

    private fun coord(value: Double): String {
        val text = String.format(Locale.US, "%.6f", value).trimEnd('0').trimEnd('.')
        return if (text == "-0") "0" else text
    }

    /** Precise or approximate, as the location tool asked. Null when the request is not that tool. */
    fun locationRequest(input: JSONObject): String? = locationAccuracy(input.optString("accuracy").ifBlank { null })

    /** Off when location services are disabled. Denied when the app may not read a fix. */
    fun locationGate(servicesOn: Boolean, granted: String?): String? = when {
        !servicesOn -> "off"
        granted != "precise" && granted != "coarse" -> "denied"
        else -> null
    }

    fun locationAccuracy(value: String?): String? = when (value) {
        "precise", "approximate" -> value
        else -> null
    }

    /**
     * The coordinates that may leave the device. Null when permission does not allow a fix,
     * or the numbers are not a real position.
     */
    fun reveal(requested: String, granted: String, latitude: Double, longitude: Double): Pair<Double, Double>? {
        if (locationAccuracy(requested) == null) return null
        if (granted != "coarse" && granted != "precise") return null
        if (!latitude.isFinite() || !longitude.isFinite() || latitude !in -90.0..90.0 || longitude !in -180.0..180.0) return null
        if (requested == "approximate" || granted == "coarse") return coarse(latitude) to coarse(longitude)
        return latitude to longitude
    }

    fun calendarSearch(input: JSONObject): Search? {
        val calendarId = when (val field = textField(input, "calendar_id")) {
            is Field.Missing -> null
            is Field.Bad -> return null
            is Field.Ok -> field.value
        }
        if (calendarId != null && (calendarId.contains('/') || calendarId.contains('\\') || calendarId.contains(".."))) return null
        val text = when (val field = textField(input, "search_text")) {
            is Field.Missing -> null
            is Field.Bad -> return null
            is Field.Ok -> field.value
        }
        val start = when (val field = timeField(input, "start_time")) {
            is Field.Missing -> null
            is Field.Bad -> return null
            is Field.Ok -> field.value
        }
        val end = when (val field = timeField(input, "end_time")) {
            is Field.Missing -> null
            is Field.Bad -> return null
            is Field.Ok -> field.value
        }
        if (start != null && end != null && !end.isAfter(start)) return null
        val includeAllDay = if (!input.has("include_all_day") || input.isNull("include_all_day")) true else input.opt("include_all_day") as? Boolean ?: return null
        val limit = if (!input.has("limit") || input.isNull("limit")) 20 else exactInt(input.opt("limit")) ?: return null
        if (limit !in 1..50) return null
        return Search(calendarId, start?.toString(), end?.toString(), includeAllDay, limit, text)
    }

    /** Event titles stay on the device until calendar permission is granted. */
    fun visibleTitles(granted: Boolean, titles: List<String>): List<String> = if (granted) titles else emptyList()

    data class Found(val title: String, val allDay: Boolean, val calendarId: String)

    /** Titles that match one search. None leave the device without calendar permission. */
    fun matching(granted: Boolean, events: List<Found>, request: Search): List<String> {
        if (!granted) return emptyList()
        return events.filter { event ->
            (request.calendarId == null || event.calendarId == request.calendarId) &&
                (request.includeAllDay || !event.allDay) &&
                (request.text == null || event.title.contains(request.text, ignoreCase = true))
        }.map { it.title }.take(request.limit)
    }

    /** Events to add. Null when the request is not a create the calendar can apply. */
    fun newEvents(input: JSONObject): List<NewEvent>? = events(input, "new_events") { item ->
        val title = (item.opt("title") as? String)?.trim()?.takeIf { it.length in 1..200 } ?: return@events null
        val start = requiredTime(item, "start_time") ?: return@events null
        val end = when (val field = timeField(item, "end_time")) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value
        }
        if (end != null && !end.isAfter(start)) return@events null
        val allDay = if (!item.has("all_day") || item.isNull("all_day")) false else item.opt("all_day") as? Boolean ?: return@events null
        val calendarId = when (val field = optionalId(item, "calendar_id")) {
            is Field.Ok -> field.value
            else -> return@events null
        }
        val description = when (val field = textField(item, "event_description")) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value
        }
        val location = when (val field = textField(item, "location")) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value
        }
        val nudges = nudges(item) ?: return@events null
        val attendees = attendees(item) ?: return@events null
        val recurrence = when (val field = recurrence(item)) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value
        }
        NewEvent(title, start.toString(), end?.toString(), allDay, calendarId, description, location, nudges, recurrence, attendees)
    }

    /** Events to remove. A repeating event is not removed as a single occurrence unless the span says so. */
    fun removedEvents(input: JSONObject): List<RemovedEvent>? = events(input, "removed_events") { item ->
        val calendarId = requiredId(item, "calendar_id") ?: return@events null
        val eventId = requiredId(item, "event_id") ?: return@events null
        val span = item.optJSONObject("recurrence_span")?.optString("option")?.ifBlank { null } ?: "instance"
        if (span != "instance" && span != "series") return@events null
        RemovedEvent(calendarId, eventId, span)
    }

    data class Search(val calendarId: String?, val start: String?, val end: String?, val includeAllDay: Boolean, val limit: Int, val text: String?)
    data class Nudge(val method: String, val minutes: Int)
    data class Recurrence(val rule: String, val frequency: String, val interval: Int, val days: List<String>, val monthDay: Int?, val count: Int?, val until: String?)
    data class NewEvent(val title: String, val start: String, val end: String?, val allDay: Boolean, val calendarId: String?, val description: String?, val location: String?, val nudges: List<Nudge>, val recurrence: Recurrence?, val attendees: List<String>)
    data class RemovedEvent(val calendarId: String, val eventId: String, val span: String)
    data class UpdatedEvent(
        val calendarId: String, val eventId: String, val title: String?, val start: String?, val end: String?,
        val allDay: Boolean?, val description: String?, val location: String?, val availability: String?, val status: String?, val span: String
    )

    /** Changes to events that already exist. Null when an id or a new time is not usable. */
    fun updatedEvents(input: JSONObject): List<UpdatedEvent>? = events(input, "event_updates") { item ->
        val calendarId = requiredId(item, "calendar_id") ?: return@events null
        val eventId = requiredId(item, "event_id") ?: return@events null
        val title = when (val field = textField(item, "title")) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value
        }
        val start = when (val field = timeField(item, "start_time")) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value.toString()
        }
        val end = when (val field = timeField(item, "end_time")) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value.toString()
        }
        if (start != null && end != null && !Instant.parse(end).isAfter(Instant.parse(start))) return@events null
        val allDay = if (!item.has("all_day") || item.isNull("all_day")) null else item.opt("all_day") as? Boolean ?: return@events null
        val description = when (val field = textField(item, "event_description")) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value
        }
        val location = when (val field = textField(item, "location")) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value
        }
        val availability = when (val field = choice(item, "availability", setOf("busy", "free", "tentative"))) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value
        }
        val status = when (val field = choice(item, "status", setOf("confirmed", "tentative", "cancelled"))) {
            is Field.Missing -> null
            is Field.Bad -> return@events null
            is Field.Ok -> field.value
        }
        val span = item.optJSONObject("recurrence_span")?.optString("option")?.ifBlank { null } ?: "series"
        if (span != "instance" && span != "series") return@events null
        if (title == null && start == null && end == null && allDay == null && description == null && location == null && availability == null && status == null) return@events null
        UpdatedEvent(calendarId, eventId, title, start, end, allDay, description, location, availability, status, span)
    }

    private fun <T> events(input: JSONObject, key: String, read: (JSONObject) -> T?): List<T>? {
        val array = input.optJSONArray(key) ?: return null
        if (array.length() !in 1..20) return null
        return (0 until array.length()).map { index -> read(array.optJSONObject(index) ?: return null) ?: return null }
    }

    private fun requiredTime(input: JSONObject, key: String): Instant? = when (val field = timeField(input, key)) {
        is Field.Ok -> field.value
        else -> null
    }

    private fun optionalId(input: JSONObject, key: String): Field<String?> = when (val field = textField(input, key)) {
        is Field.Missing -> Field.Ok(null)
        is Field.Bad -> Field.Bad
        is Field.Ok -> if (field.value.length in 1..80 && field.value.matches(Regex("^[A-Za-z0-9_.:-]+$"))) Field.Ok(field.value) else Field.Bad
    }

    private fun nudges(item: JSONObject): List<Nudge>? {
        if (!item.has("nudges") || item.isNull("nudges")) return emptyList()
        val array = item.optJSONArray("nudges") ?: return null
        if (array.length() !in 0..10) return null
        val methods = setOf("fallback", "notification", "email", "sms", "alarm")
        return List(array.length()) { index ->
            val nudge = array.optJSONObject(index) ?: return null
            val method = nudge.optString("method")
            val minutes = minutesBefore(nudge.opt("minutes_before"))
            if (method !in methods || minutes == null || minutes !in 0..40_320) return null
            Nudge(method, minutes)
        }
    }

    private val weekdayOrder = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")
    private val rulePattern = Regex("^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;INTERVAL=([1-9]\\d{0,2}))?(?:;BYDAY=((?:SU|MO|TU|WE|TH|FR|SA)(?:,(?:SU|MO|TU|WE|TH|FR|SA)){0,6}))?(?:;BYMONTHDAY=((?:[1-9]|[12]\\d|3[01])))?(?:;COUNT=([1-9]\\d{0,2})|;UNTIL=(\\d{8}T\\d{6}Z))?$")

    private fun recurrence(item: JSONObject): Field<Recurrence> {
        if (!item.has("recurrence") || item.isNull("recurrence")) return Field.Missing
        val value = item.optJSONObject("recurrence") ?: return Field.Bad
        if (value.has("months") && !value.isNull("months") || value.has("position") && !value.isNull("position")) return Field.Bad
        val frequency = when (val field = choice(value, "frequency", setOf("daily", "weekly", "monthly", "yearly"))) {
            is Field.Ok -> field.value
            else -> return Field.Bad
        }
        if (textField(value, "human_readable_frequency") !is Field.Ok) return Field.Bad
        val rule = when (val field = textField(value, "rrule")) {
            is Field.Ok -> field.value.removePrefix("RRULE:")
            else -> return Field.Bad
        }
        val match = rulePattern.matchEntire(rule) ?: return Field.Bad
        if (match.groupValues[1] != frequency.uppercase()) return Field.Bad
        val interval = match.groupValues[2].ifEmpty { "1" }.toInt()
        if (interval !in 1..366) return Field.Bad
        if (value.has("interval") && !value.isNull("interval") && whole(value.opt("interval"), 1, 366) != interval) return Field.Bad
        val days = match.groupValues[3].takeIf { it.isNotEmpty() }?.split(",").orEmpty()
        if (days.distinct().size != days.size || days != days.sortedBy { weekdayOrder.indexOf(it) }) return Field.Bad
        if (days.isNotEmpty() && frequency != "weekly") return Field.Bad
        val requestedDays = value.optJSONArray("days_of_week")
        if (requestedDays != null && (0 until requestedDays.length()).map { requestedDays.optString(it) } != days) return Field.Bad
        val monthDay = match.groupValues[4].toIntOrNull()
        if (monthDay != null && frequency != "monthly") return Field.Bad
        if (value.has("day_of_month") && !value.isNull("day_of_month") && whole(value.opt("day_of_month"), 1, 31) != monthDay) return Field.Bad
        val count = match.groupValues[5].toIntOrNull()
        val until = match.groupValues[6].ifEmpty { null }
        val end = value.optJSONObject("end")
        if (end != null) {
            val type = end.optString("type")
            val matches = when (type) {
                "count" -> until == null && whole(end.opt("count"), 1, 999) == count
                "until" -> count == null && end.optString("until") == until
                else -> false
            }
            if (!matches) return Field.Bad
        }
        return Field.Ok(Recurrence(rule, frequency, interval, days, monthDay, count, until))
    }

    private fun whole(value: Any?, low: Int, high: Int): Int? {
        val number = value as? Number ?: return null
        val whole = number.toDouble()
        if (!whole.isFinite() || whole % 1.0 != 0.0 || whole !in low.toDouble()..high.toDouble()) return null
        return whole.toInt()
    }

    private val email = Regex("^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,24}$")

    private fun attendees(item: JSONObject): List<String>? {
        if (!item.has("attendees") || item.isNull("attendees")) return emptyList()
        val array = item.optJSONArray("attendees") ?: return null
        if (array.length() !in 0..20) return null
        val emails = List(array.length()) { index ->
            val value = (array.opt(index) as? String)?.trim() ?: return null
            if (!email.matches(value)) return null
            value
        }
        if (emails.map { it.lowercase() }.distinct().size != emails.size) return null
        return emails
    }

    private fun choice(input: JSONObject, key: String, allowed: Set<String>): Field<String> = when (val field = textField(input, key)) {
        is Field.Missing -> Field.Missing
        is Field.Bad -> Field.Bad
        is Field.Ok -> if (field.value in allowed) field else Field.Bad
    }

    private fun requiredId(input: JSONObject, key: String): String? = when (val field = optionalId(input, key)) {
        is Field.Ok -> field.value
        else -> null
    }

    private fun coarse(value: Double) = round(value * 100.0) / 100.0

    private sealed class Field<out T> {
        data object Missing : Field<Nothing>()
        data object Bad : Field<Nothing>()
        data class Ok<T>(val value: T) : Field<T>()
    }

    private fun textField(input: JSONObject, key: String): Field<String> {
        if (!input.has(key) || input.isNull(key)) return Field.Missing
        val value = (input.opt(key) as? String)?.trim() ?: return Field.Bad
        if (value.isEmpty() || value.length > 200) return Field.Bad
        return Field.Ok(value)
    }

    private fun timeField(input: JSONObject, key: String): Field<Instant> {
        if (!input.has(key) || input.isNull(key)) return Field.Missing
        val value = input.opt(key) as? String ?: return Field.Bad
        val instant = runCatching { Instant.parse(value) }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(value).toInstant() }.getOrNull()
            ?: return Field.Bad
        return Field.Ok(instant)
    }

    private fun minutesBefore(value: Any?): Int? {
        val number = value as? Number ?: return null
        val whole = number.toDouble()
        if (!whole.isFinite() || whole % 1.0 != 0.0 || whole !in 0.0..40_320.0) return null
        return whole.toInt()
    }

    private fun exactInt(value: Any?): Int? {
        val number = value as? Number ?: return null
        val whole = number.toDouble()
        if (!whole.isFinite() || whole % 1.0 != 0.0 || whole !in 1.0..50.0) return null
        return whole.toInt()
    }
}
