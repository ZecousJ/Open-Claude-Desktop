import XCTest
@testable import ClaudexCore

final class DeviceAccessTests: XCTestCase {
    func testAnApproximateFixDoesNotKeepTheStreet() {
        let rough = DeviceAccess.reveal(requested: "approximate", granted: "precise", latitude: 31.2304, longitude: 121.4737)
        XCTAssertEqual(rough?.0 ?? 0, 31.23, accuracy: 0.0001)
        XCTAssertEqual(rough?.1 ?? 0, 121.47, accuracy: 0.0001)
        let coarse = DeviceAccess.reveal(requested: "precise", granted: "coarse", latitude: 31.2304, longitude: 121.4737)
        XCTAssertEqual(coarse?.0 ?? 0, 31.23, accuracy: 0.0001)
        let exact = DeviceAccess.reveal(requested: "precise", granted: "precise", latitude: 31.2304, longitude: 121.4737)
        XCTAssertEqual(exact?.0 ?? 0, 31.2304, accuracy: 0.0001)
        XCTAssertNil(DeviceAccess.reveal(requested: "precise", granted: "none", latitude: 31.2304, longitude: 121.4737))
        XCTAssertNil(DeviceAccess.reveal(requested: "street", granted: "precise", latitude: 31.2304, longitude: 121.4737))
        XCTAssertEqual(DeviceAccess.locationRequest(.object(["accuracy": .string("precise")])), "precise")
        XCTAssertNil(DeviceAccess.locationRequest(.object(["accuracy": .string("street")])))
        XCTAssertEqual(DeviceAccess.locationGate(servicesOn: false, granted: "precise"), "off")
        XCTAssertEqual(DeviceAccess.locationGate(servicesOn: true, granted: "none"), "denied")
        XCTAssertNil(DeviceAccess.locationGate(servicesOn: true, granted: "coarse"))
        XCTAssertEqual(DeviceAccess.mapLink(.object(["markers": .array([.object(["latitude": .number(37.5), "longitude": .number(-122.25), "title": .string("Cafe")])])])), "geo:37.5,-122.25?q=Cafe")
        XCTAssertTrue(DeviceAccess.mapLink(.object(["markers": .array([
            .object(["latitude": .number(37.5), "longitude": .number(-122.25), "title": .string("Cafe")]),
            .object(["latitude": .number(37.8), "longitude": .number(-122.4), "title": .string("Park")])
        ])]))?.hasPrefix("https://www.google.com/maps/dir/") == true)
        XCTAssertNil(DeviceAccess.mapLink(.object(["markers": .array([.object(["latitude": .number(99), "longitude": .number(0), "title": .string("Cafe")])])])))
        XCTAssertEqual(DeviceAccess.mapLink(.object(["locations": .array([.object(["latitude": .number(37.5), "longitude": .number(-122.25), "name": .string("Cafe")])]), "travel_mode": .string("walking")])), "geo:37.5,-122.25?q=Cafe")
        XCTAssertNil(DeviceAccess.mapLink(.object(["locations": .array([.object(["latitude": .number(37.5), "longitude": .number(-122.25), "name": .string("Cafe")])]), "travel_mode": .string("flying")])))
    }

    func testACalendarSearchStaysEmptyUntilPermissionIsGranted() {
        let input = JSONValue.object([
            "start_time": .string("2026-11-21T00:00:00Z"),
            "end_time": .string("2026-11-22T00:00:00+08:00"),
            "limit": .number(10)
        ])
        XCTAssertEqual(DeviceAccess.calendarSearch(input)?.limit, 10)
        XCTAssertEqual(DeviceAccess.calendarSearch(input)?.includeAllDay, true)
        XCTAssertNil(DeviceAccess.calendarSearch(.object(["start_time": .string("2026-11-22T00:00:00Z"), "end_time": .string("2026-11-21T00:00:00Z")])))
        XCTAssertNil(DeviceAccess.calendarSearch(.object(["calendar_id": .string("../other")])))
        XCTAssertTrue(DeviceAccess.visibleTitles(granted: false, titles: ["Dentist"]).isEmpty)
        XCTAssertEqual(DeviceAccess.visibleTitles(granted: true, titles: ["Dentist"]), ["Dentist"])
        let found = [
            DeviceAccess.Found(title: "Dentist", allDay: false, calendarId: "3"),
            DeviceAccess.Found(title: "Holiday", allDay: true, calendarId: "3")
        ]
        let search = DeviceAccess.calendarSearch(input)
        XCTAssertTrue(DeviceAccess.matching(granted: false, events: found, request: search!).isEmpty)
        XCTAssertEqual(DeviceAccess.matching(granted: true, events: found, request: search!), ["Dentist", "Holiday"])
        let created = DeviceAccess.newEvents(.object(["new_events": .array([.object(["title": .string("Dentist"), "start_time": .string("2026-11-21T10:00:00Z"), "all_day": .bool(false)])])]))
        XCTAssertEqual(created?.first?.title, "Dentist")
        XCTAssertEqual(created?.first?.nudges, [])
        let reminded = DeviceAccess.newEvents(.object([
            "new_events": .array([
                .object([
                    "title": .string("Dentist"),
                    "start_time": .string("2026-11-21T10:00:00Z"),
                    "nudges": .array([
                        .object(["method": .string("notification"), "minutes_before": .number(15)])
                    ])
                ])
            ])
        ]))
        XCTAssertEqual(reminded?.first?.nudges.first?.minutes, 15)
        XCTAssertNil(DeviceAccess.newEvents(.object([
            "new_events": .array([
                .object([
                    "title": .string("Dentist"),
                    "start_time": .string("2026-11-21T10:00:00Z"),
                    "nudges": .array([
                        .object(["method": .string("push"), "minutes_before": .number(15)])
                    ])
                ])
            ])
        ])))
        XCTAssertNil(DeviceAccess.newEvents(.object(["new_events": .array([.object(["title": .string("Dentist"), "start_time": .string("2026-11-21T11:00:00Z"), "end_time": .string("2026-11-21T10:00:00Z")])])])))
        let weekly = DeviceAccess.newEvents(.object([
            "new_events": .array([
                .object([
                    "title": .string("Standup"),
                    "start_time": .string("2026-11-21T10:00:00Z"),
                    "recurrence": .object([
                        "frequency": .string("weekly"),
                        "human_readable_frequency": .string("Every Monday"),
                        "rrule": .string("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO"),
                        "days_of_week": .array([.string("MO")])
                    ])
                ])
            ])
        ]))
        XCTAssertEqual(weekly?.first?.recurrence?.rule, "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO")
        let invited = DeviceAccess.newEvents(.object([
            "new_events": .array([
                .object([
                    "title": .string("Standup"),
                    "start_time": .string("2026-11-21T10:00:00Z"),
                    "attendees": .array([.string("ada@example.com")])
                ])
            ])
        ]))
        XCTAssertEqual(invited?.first?.attendees, ["ada@example.com"])
        XCTAssertNil(DeviceAccess.newEvents(.object([
            "new_events": .array([
                .object([
                    "title": .string("Standup"),
                    "start_time": .string("2026-11-21T10:00:00Z"),
                    "attendees": .array([.string("ada")])
                ])
            ])
        ])))
        XCTAssertNil(DeviceAccess.newEvents(.object([
            "new_events": .array([
                .object([
                    "title": .string("Standup"),
                    "start_time": .string("2026-11-21T10:00:00Z"),
                    "recurrence": .object([
                        "frequency": .string("weekly"),
                        "human_readable_frequency": .string("Every day"),
                        "rrule": .string("FREQ=DAILY;INTERVAL=1")
                    ])
                ])
            ])
        ])))
        let removed = DeviceAccess.removedEvents(.object(["removed_events": .array([.object(["calendar_id": .string("3"), "event_id": .string("9"), "recurrence_span": .object(["option": .string("series")])])])]))
        XCTAssertEqual(removed?.first?.span, "series")
        XCTAssertNil(DeviceAccess.removedEvents(.object(["removed_events": .array([.object(["calendar_id": .string("../x"), "event_id": .string("9")])])])))
        let updated = DeviceAccess.updatedEvents(.object(["event_updates": .array([.object(["calendar_id": .string("3"), "event_id": .string("9"), "title": .string("Moved"), "availability": .string("free")])])]))
        XCTAssertEqual(updated?.first?.title, "Moved")
        XCTAssertEqual(updated?.first?.availability, "free")
        XCTAssertEqual(updated?.first?.span, "series")
        XCTAssertNil(DeviceAccess.updatedEvents(.object(["event_updates": .array([.object(["calendar_id": .string("3"), "event_id": .string("9")])])])))
        XCTAssertNil(DeviceAccess.updatedEvents(.object(["event_updates": .array([.object(["calendar_id": .string("3"), "event_id": .string("9"), "title": .string("Moved"), "availability": .string("maybe")])])])))
    }
}
