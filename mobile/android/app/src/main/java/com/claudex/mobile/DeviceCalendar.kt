package com.claudex.mobile

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import java.time.Instant
import java.util.TimeZone

/**
 * Reads and writes the system calendar after the person has allowed it.
 * A missing permission returns no titles and does not change any event.
 * One occurrence of a repeating event is left in place; removing the series removes the event.
 */
internal object DeviceCalendar {
    private const val WRITABLE = CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR

    /** Reads matching titles and keeps them on the device. Empty means the search ran. */
    fun search(context: Context, request: DeviceAccess.Search): String? {
        if (!can(context, Manifest.permission.READ_CALENDAR)) return context.getString(R.string.calendar_events_permission_denied_system)
        val start = request.start?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: Instant.now()
        val end = request.end?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: start.plusSeconds(7 * 86_400)
        val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
        ContentUris.appendId(builder, start.toEpochMilli())
        ContentUris.appendId(builder, end.toEpochMilli())
        val cursor = runCatching {
            context.contentResolver.query(builder.build(), arrayOf(CalendarContract.Instances.TITLE, CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.CALENDAR_ID), null, null, null)
        }.getOrNull() ?: return null
        val found = mutableListOf<DeviceAccess.Found>()
        cursor.use {
            val titleColumn = it.getColumnIndexOrThrow(CalendarContract.Instances.TITLE)
            val allDayColumn = it.getColumnIndexOrThrow(CalendarContract.Instances.ALL_DAY)
            val calendarColumn = it.getColumnIndexOrThrow(CalendarContract.Instances.CALENDAR_ID)
            while (it.moveToNext()) found += DeviceAccess.Found(it.getString(titleColumn).orEmpty(), it.getInt(allDayColumn) == 1, it.getLong(calendarColumn).toString())
        }
        DeviceAccess.matching(true, found, request)
        return ""
    }

    /** Reads calendar names and keeps them on the device. Empty means the list was read. */
    fun names(context: Context): String? {
        if (!can(context, Manifest.permission.READ_CALENDAR)) return context.getString(R.string.calendar_events_permission_denied_system)
        val cursor = runCatching {
            context.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, arrayOf(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME), "${CalendarContract.Calendars.VISIBLE}=1", null, null)
        }.getOrNull() ?: return null
        val titles = mutableListOf<String>()
        cursor.use {
            val column = it.getColumnIndexOrThrow(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME)
            while (it.moveToNext()) titles += it.getString(column).orEmpty()
        }
        DeviceAccess.visibleTitles(true, titles)
        return ""
    }

    fun create(context: Context, events: List<DeviceAccess.NewEvent>): String {
        if (!can(context, Manifest.permission.WRITE_CALENDAR)) return context.getString(R.string.calendar_events_permission_denied_system)
        val writable = writableCalendars(context)
        if (writable.isEmpty()) return context.getString(R.string.calendar_event_create_status_failed)
        var made = 0
        for (event in events) {
            val calendarId = event.calendarId?.toLongOrNull()?.takeIf { it in writable } ?: writable.first()
            val start = runCatching { Instant.parse(event.start) }.getOrNull() ?: continue
            val end = event.end?.let { runCatching { Instant.parse(it) }.getOrNull() }
                ?: start.plusSeconds(if (event.allDay) 86_400 else 3_600)
            val values = ContentValues()
            values.put(CalendarContract.Events.CALENDAR_ID, calendarId)
            values.put(CalendarContract.Events.TITLE, event.title)
            values.put(CalendarContract.Events.DTSTART, start.toEpochMilli())
            values.put(CalendarContract.Events.DTEND, end.toEpochMilli())
            values.put(CalendarContract.Events.EVENT_TIMEZONE, if (event.allDay) "UTC" else TimeZone.getDefault().id)
            values.put(CalendarContract.Events.ALL_DAY, if (event.allDay) 1 else 0)
            event.description?.let { values.put(CalendarContract.Events.DESCRIPTION, it) }
            event.location?.let { values.put(CalendarContract.Events.EVENT_LOCATION, it) }
            event.recurrence?.let { values.put(CalendarContract.Events.RRULE, it.rule) }
            val inserted = runCatching { context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values) }.getOrNull() ?: continue
            val id = ContentUris.parseId(inserted)
            val storedRule = rule(context, id, calendarId)
            if (present(context, id, event.title) && reminders(context, id, event.nudges) && storedRule == event.recurrence?.rule.orEmpty() && attendees(context, id, event.attendees)) made += 1
            else runCatching { context.contentResolver.delete(inserted, null, null) }
        }
        return if (made == events.size) "" else context.getString(R.string.calendar_event_create_status_failed)
    }

    fun delete(context: Context, events: List<DeviceAccess.RemovedEvent>): String {
        if (!can(context, Manifest.permission.WRITE_CALENDAR)) return context.getString(R.string.calendar_events_permission_denied_system)
        var removed = 0
        for (event in events) {
            val id = event.eventId.toLongOrNull() ?: continue
            val calendarId = event.calendarId.toLongOrNull() ?: continue
            val rule = rule(context, id, calendarId) ?: continue
            if (event.span == "instance" && rule.isNotEmpty()) continue
            val uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id)
            val count = runCatching { context.contentResolver.delete(uri, "${CalendarContract.Events.CALENDAR_ID}=?", arrayOf(calendarId.toString())) }.getOrDefault(0)
            if (count > 0 && !present(context, id, null)) removed += 1
        }
        return if (removed == events.size) "" else context.getString(R.string.calendar_event_delete_status_failed)
    }

    fun update(context: Context, events: List<DeviceAccess.UpdatedEvent>): String {
        if (!can(context, Manifest.permission.WRITE_CALENDAR)) return context.getString(R.string.calendar_events_permission_denied_system)
        var changed = 0
        for (event in events) {
            val id = event.eventId.toLongOrNull() ?: continue
            val calendarId = event.calendarId.toLongOrNull() ?: continue
            val existing = rule(context, id, calendarId) ?: continue
            if (event.span == "instance" && existing.isNotEmpty()) continue
            val values = ContentValues()
            event.title?.let { values.put(CalendarContract.Events.TITLE, it) }
            event.start?.let { runCatching { Instant.parse(it) }.getOrNull() }?.let { values.put(CalendarContract.Events.DTSTART, it.toEpochMilli()) }
            event.end?.let { runCatching { Instant.parse(it) }.getOrNull() }?.let { values.put(CalendarContract.Events.DTEND, it.toEpochMilli()) }
            event.allDay?.let { values.put(CalendarContract.Events.ALL_DAY, if (it) 1 else 0) }
            event.description?.let { values.put(CalendarContract.Events.DESCRIPTION, it) }
            event.location?.let { values.put(CalendarContract.Events.EVENT_LOCATION, it) }
            event.availability?.let { values.put(CalendarContract.Events.AVAILABILITY, when (it) { "free" -> CalendarContract.Events.AVAILABILITY_FREE; "tentative" -> CalendarContract.Events.AVAILABILITY_TENTATIVE; else -> CalendarContract.Events.AVAILABILITY_BUSY }) }
            event.status?.let { values.put(CalendarContract.Events.STATUS, when (it) { "tentative" -> CalendarContract.Events.STATUS_TENTATIVE; "cancelled" -> CalendarContract.Events.STATUS_CANCELED; else -> CalendarContract.Events.STATUS_CONFIRMED }) }
            if (values.size() == 0) continue
            val uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id)
            val count = runCatching { context.contentResolver.update(uri, values, "${CalendarContract.Events.CALENDAR_ID}=?", arrayOf(calendarId.toString())) }.getOrDefault(0)
            if (count > 0 && present(context, id, event.title)) changed += 1
        }
        return if (changed == events.size) "" else context.getString(R.string.calendar_event_update_status_failed)
    }

    private fun attendees(context: Context, eventId: Long, emails: List<String>): Boolean {
        if (emails.isEmpty()) return true
        for (email in emails) {
            val values = ContentValues()
            values.put(CalendarContract.Attendees.EVENT_ID, eventId)
            values.put(CalendarContract.Attendees.ATTENDEE_EMAIL, email)
            values.put(CalendarContract.Attendees.ATTENDEE_TYPE, CalendarContract.Attendees.TYPE_REQUIRED)
            values.put(CalendarContract.Attendees.ATTENDEE_STATUS, CalendarContract.Attendees.ATTENDEE_STATUS_NONE)
            values.put(CalendarContract.Attendees.ATTENDEE_RELATIONSHIP, CalendarContract.Attendees.RELATIONSHIP_ATTENDEE)
            if (runCatching { context.contentResolver.insert(CalendarContract.Attendees.CONTENT_URI, values) }.getOrNull() == null) return false
        }
        val cursor = runCatching {
            context.contentResolver.query(CalendarContract.Attendees.CONTENT_URI, arrayOf(CalendarContract.Attendees.ATTENDEE_EMAIL), "${CalendarContract.Attendees.EVENT_ID}=?", arrayOf(eventId.toString()), null)
        }.getOrNull() ?: return false
        cursor.use {
            val found = mutableListOf<String>()
            val column = it.getColumnIndexOrThrow(CalendarContract.Attendees.ATTENDEE_EMAIL)
            while (it.moveToNext()) found += it.getString(column)
            return found.sorted() == emails.sorted()
        }
    }

    private fun reminders(context: Context, eventId: Long, nudges: List<DeviceAccess.Nudge>): Boolean {
        if (nudges.isEmpty()) return true
        for (nudge in nudges) {
            val values = ContentValues()
            values.put(CalendarContract.Reminders.EVENT_ID, eventId)
            values.put(CalendarContract.Reminders.MINUTES, nudge.minutes)
            values.put(CalendarContract.Reminders.METHOD, when (nudge.method) {
                "email" -> CalendarContract.Reminders.METHOD_EMAIL
                "sms" -> CalendarContract.Reminders.METHOD_SMS
                "alarm" -> CalendarContract.Reminders.METHOD_ALARM
                else -> CalendarContract.Reminders.METHOD_ALERT
            })
            if (runCatching { context.contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, values) }.getOrNull() == null) return false
        }
        val cursor = runCatching {
            context.contentResolver.query(CalendarContract.Reminders.CONTENT_URI, arrayOf(CalendarContract.Reminders.MINUTES, CalendarContract.Reminders.METHOD), "${CalendarContract.Reminders.EVENT_ID}=?", arrayOf(eventId.toString()), null)
        }.getOrNull() ?: return false
        cursor.use {
            val found = mutableListOf<Pair<Int, Int>>()
            val minutesColumn = it.getColumnIndexOrThrow(CalendarContract.Reminders.MINUTES)
            val methodColumn = it.getColumnIndexOrThrow(CalendarContract.Reminders.METHOD)
            while (it.moveToNext()) found += it.getInt(minutesColumn) to it.getInt(methodColumn)
            val expected = nudges.map { nudge ->
                nudge.minutes to when (nudge.method) {
                    "email" -> CalendarContract.Reminders.METHOD_EMAIL
                    "sms" -> CalendarContract.Reminders.METHOD_SMS
                    "alarm" -> CalendarContract.Reminders.METHOD_ALARM
                    else -> CalendarContract.Reminders.METHOD_ALERT
                }
            }
            return found.sortedWith(compareBy({ pair -> pair.first }, { pair -> pair.second })) == expected.sortedWith(compareBy({ pair -> pair.first }, { pair -> pair.second }))
        }
    }

    private fun can(context: Context, permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun writableCalendars(context: Context): List<Long> {
        if (!can(context, Manifest.permission.READ_CALENDAR)) return emptyList()
        val cursor = runCatching {
            context.contentResolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL),
                "${CalendarContract.Calendars.VISIBLE}=1", null, null
            )
        }.getOrNull() ?: return emptyList()
        cursor.use {
            val ids = mutableListOf<Long>()
            val idColumn = it.getColumnIndex(CalendarContract.Calendars._ID)
            val accessColumn = it.getColumnIndex(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL)
            while (it.moveToNext()) if (it.getInt(accessColumn) >= WRITABLE) ids += it.getLong(idColumn)
            return ids
        }
    }

    private fun rule(context: Context, id: Long, calendarId: Long): String? {
        val cursor = runCatching {
            context.contentResolver.query(
                ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id),
                arrayOf(CalendarContract.Events.CALENDAR_ID, CalendarContract.Events.RRULE),
                null, null, null
            )
        }.getOrNull() ?: return null
        cursor.use {
            if (!it.moveToFirst()) return null
            if (it.getLong(it.getColumnIndexOrThrow(CalendarContract.Events.CALENDAR_ID)) != calendarId) return null
            return it.getString(it.getColumnIndexOrThrow(CalendarContract.Events.RRULE)).orEmpty()
        }
    }

    private fun present(context: Context, id: Long, title: String?): Boolean {
        val cursor = runCatching {
            context.contentResolver.query(
                ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id),
                arrayOf(CalendarContract.Events.TITLE, CalendarContract.Events.DELETED),
                null, null, null
            )
        }.getOrNull() ?: return false
        cursor.use {
            if (!it.moveToFirst() || it.getInt(it.getColumnIndexOrThrow(CalendarContract.Events.DELETED)) == 1) return false
            return title == null || it.getString(it.getColumnIndexOrThrow(CalendarContract.Events.TITLE)) == title
        }
    }
}
