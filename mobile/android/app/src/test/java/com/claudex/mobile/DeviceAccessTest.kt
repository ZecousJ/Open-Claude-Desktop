package com.claudex.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceAccessTest {
    @Test fun anApproximateFixDoesNotKeepTheStreet() {
        val rough = DeviceAccess.reveal("approximate", "precise", 31.2304, 121.4737)
        assertEquals(31.23, rough!!.first, 0.0)
        assertEquals(121.47, rough.second, 0.0)
        val coarseGrant = DeviceAccess.reveal("precise", "coarse", 31.2304, 121.4737)
        assertEquals(31.23, coarseGrant!!.first, 0.0)
        val exact = DeviceAccess.reveal("precise", "precise", 31.2304, 121.4737)
        assertEquals(31.2304, exact!!.first, 0.0)
        assertNull(DeviceAccess.reveal("precise", "none", 31.2304, 121.4737))
        assertNull(DeviceAccess.reveal("street", "precise", 31.2304, 121.4737))
        assertEquals("precise", DeviceAccess.locationRequest(JSONObject("""{"accuracy":"precise"}""")))
        assertNull(DeviceAccess.locationRequest(JSONObject("""{"accuracy":"street"}""")))
        assertEquals("off", DeviceAccess.locationGate(false, "precise"))
        assertEquals("denied", DeviceAccess.locationGate(true, "none"))
        assertNull(DeviceAccess.locationGate(true, "coarse"))
        assertEquals("geo:37.5,-122.25?q=Cafe", DeviceAccess.mapLink(JSONObject("""{"markers":[{"latitude":37.5,"longitude":-122.25,"title":"Cafe"}]}""")))
        assertTrue(DeviceAccess.mapLink(JSONObject("""{"markers":[{"latitude":37.5,"longitude":-122.25,"title":"Cafe"},{"latitude":37.8,"longitude":-122.4,"title":"Park"}]}"""))!!.startsWith("https://www.google.com/maps/dir/"))
        assertNull(DeviceAccess.mapLink(JSONObject("""{"markers":[{"latitude":99,"longitude":0,"title":"Cafe"}]}""")))
        assertEquals("geo:37.5,-122.25?q=Cafe", DeviceAccess.mapLink(JSONObject("""{"locations":[{"latitude":37.5,"longitude":-122.25,"name":"Cafe"}],"travel_mode":"walking"}""")))
        assertNull(DeviceAccess.mapLink(JSONObject("""{"locations":[{"latitude":37.5,"longitude":-122.25,"name":"Cafe"}],"travel_mode":"flying"}""")))
    }

    @Test fun aCalendarSearchStaysEmptyUntilPermissionIsGranted() {
        val search = DeviceAccess.calendarSearch(JSONObject("""{"start_time":"2026-11-21T00:00:00Z","end_time":"2026-11-22T00:00:00+08:00","limit":10}"""))
        assertEquals(10, search!!.limit)
        assertTrue(search.includeAllDay)
        assertNull(DeviceAccess.calendarSearch(JSONObject("""{"start_time":"2026-11-22T00:00:00Z","end_time":"2026-11-21T00:00:00Z"}""")))
        assertNull(DeviceAccess.calendarSearch(JSONObject("""{"calendar_id":"../other"}""")))
        assertTrue(DeviceAccess.visibleTitles(false, listOf("Dentist")).isEmpty())
        assertEquals(listOf("Dentist"), DeviceAccess.visibleTitles(true, listOf("Dentist")))
        val found = listOf(DeviceAccess.Found("Dentist", false, "3"), DeviceAccess.Found("Holiday", true, "3"), DeviceAccess.Found("Other", false, "4"))
        assertTrue(DeviceAccess.matching(false, found, search).isEmpty())
        assertEquals(listOf("Dentist"), DeviceAccess.matching(true, found, search.copy(text = "den", includeAllDay = false, calendarId = "3")))
        val created = DeviceAccess.newEvents(JSONObject("""{"new_events":[{"title":"Dentist","start_time":"2026-11-21T10:00:00Z","all_day":false}]}"""))
        assertEquals("Dentist", created!![0].title)
        assertTrue(created[0].nudges.isEmpty())
        val reminded = DeviceAccess.newEvents(JSONObject("""{"new_events":[{"title":"Dentist","start_time":"2026-11-21T10:00:00Z","nudges":[{"method":"notification","minutes_before":15}]}]}"""))
        assertEquals(15, reminded!![0].nudges[0].minutes)
        assertNull(DeviceAccess.newEvents(JSONObject("""{"new_events":[{"title":"Dentist","start_time":"2026-11-21T10:00:00Z","nudges":[{"method":"push","minutes_before":15}]}]}""")))
        val weekly = DeviceAccess.newEvents(JSONObject("""{"new_events":[{"title":"Standup","start_time":"2026-11-21T10:00:00Z","recurrence":{"frequency":"weekly","human_readable_frequency":"Every Monday","rrule":"FREQ=WEEKLY;INTERVAL=1;BYDAY=MO","days_of_week":["MO"]}}]}"""))
        assertEquals("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", weekly!![0].recurrence!!.rule)
        assertNull(DeviceAccess.newEvents(JSONObject("""{"new_events":[{"title":"Standup","start_time":"2026-11-21T10:00:00Z","recurrence":{"frequency":"weekly","human_readable_frequency":"Every day","rrule":"FREQ=DAILY;INTERVAL=1"}}]}""")))
        val invited = DeviceAccess.newEvents(JSONObject("""{"new_events":[{"title":"Standup","start_time":"2026-11-21T10:00:00Z","attendees":["ada@example.com"]}]}"""))
        assertEquals(listOf("ada@example.com"), invited!![0].attendees)
        assertNull(DeviceAccess.newEvents(JSONObject("""{"new_events":[{"title":"Standup","start_time":"2026-11-21T10:00:00Z","attendees":["ada"]}]}""")))
        assertNull(DeviceAccess.newEvents(JSONObject("""{"new_events":[{"title":"Dentist","start_time":"2026-11-21T11:00:00Z","end_time":"2026-11-21T10:00:00Z"}]}""")))
        val removed = DeviceAccess.removedEvents(JSONObject("""{"removed_events":[{"calendar_id":"3","event_id":"9","recurrence_span":{"option":"series"}}]}"""))
        assertEquals("series", removed!![0].span)
        assertNull(DeviceAccess.removedEvents(JSONObject("""{"removed_events":[{"calendar_id":"../x","event_id":"9"}]}""")))
        val updated = DeviceAccess.updatedEvents(JSONObject("""{"event_updates":[{"calendar_id":"3","event_id":"9","title":"Moved","availability":"free"}]}"""))
        assertEquals("Moved", updated!![0].title)
        assertEquals("free", updated[0].availability)
        assertEquals("series", updated[0].span)
        assertNull(DeviceAccess.updatedEvents(JSONObject("""{"event_updates":[{"calendar_id":"3","event_id":"9"}]}""")))
        assertNull(DeviceAccess.updatedEvents(JSONObject("""{"event_updates":[{"calendar_id":"3","event_id":"9","title":"Moved","availability":"maybe"}]}""")))
    }
}
