import Foundation

/// What a location or calendar tool may return.
/// A denied or restricted permission returns no coordinates and no event titles.
/// An approximate grant, or an approximate request, keeps the fix to about a kilometre.
public enum DeviceAccess {
    public struct Search: Equatable, Sendable {
        public let calendarId: String?
        public let start: String?
        public let end: String?
        public let includeAllDay: Bool
        public let limit: Int
        public let text: String?
    }

    /// The system map link for pins the model already named.
    /// One pin opens that place. Several pins open the route from the first to the last.
    public static func mapLink(_ input: JSONValue) -> String? {
        guard short(input, "title"), short(input, "narrative") else { return nil }
        if input.object?["mode"] != nil && input["mode"] != .null && input["mode"].string != "markers" && input["mode"].string != "itinerary" { return nil }
        if input.object?["travel_mode"] != nil && input["travel_mode"] != .null && !["driving", "walking", "transit", "bicycling"].contains(input["travel_mode"].string ?? "") { return nil }
        let showRoute: Bool?
        if input.object?["show_route"] == nil || input["show_route"] == .null { showRoute = nil }
        else if let value = input["show_route"].bool { showRoute = value }
        else { return nil }
        let pins: [(Double, Double, String)]
        if input.object?["markers"] != nil && input["markers"] != .null {
            guard let parsed = markerPins(input) else { return nil }
            pins = parsed
        } else if let parsed = placePins(input) { pins = parsed }
        else { return nil }
        let opened = showRoute == false ? Array(pins.prefix(1)) : pins
        let link: String
        if opened.count == 1, let pin = opened.first {
            let query = pin.2.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            link = "geo:\(coord(pin.0)),\(coord(pin.1))?q=\(query)"
        } else {
            let origin = opened[0]
            let destination = opened[opened.count - 1]
            var route = "https://www.google.com/maps/dir/?api=1&origin=\(coord(origin.0)),\(coord(origin.1))&destination=\(coord(destination.0)),\(coord(destination.1))"
            let via = opened.dropFirst().dropLast().map { "\(coord($0.0)),\(coord($0.1))" }.joined(separator: "|")
            if !via.isEmpty, let encoded = via.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { route += "&waypoints=\(encoded)" }
            link = route
        }
        return link.count <= 2048 ? link : nil
    }

    private static func markerPins(_ input: JSONValue) -> [(Double, Double, String)]? {
        guard let markers = input["markers"].array, (1...10).contains(markers.count) else { return nil }
        var pins: [(Double, Double, String)] = []
        for marker in markers {
            guard short(marker, "label"), let title = marker["title"].string?.trimmingCharacters(in: .whitespacesAndNewlines), (1...200).contains(title.count),
                  let pin = pin(marker, title) else { return nil }
            pins.append(pin)
        }
        return pins
    }

    private static func placePins(_ input: JSONValue) -> [(Double, Double, String)]? {
        let places: [JSONValue]
        if input.object?["days"] != nil && input["days"] != .null {
            guard let days = input["days"].array, (1...10).contains(days.count) else { return nil }
            var gathered: [JSONValue] = []
            for day in days {
                guard let number = day["day_number"].number, number.isFinite, number.rounded() == number, (1.0...366.0).contains(number),
                      short(day, "title"), short(day, "narrative"), let stops = day["locations"].array else { return nil }
                gathered.append(contentsOf: stops)
            }
            places = gathered
        } else if let locations = input["locations"].array { places = locations }
        else { return nil }
        guard (1...10).contains(places.count) else { return nil }
        var pins: [(Double, Double, String)] = []
        for place in places {
            guard short(place, "address"), short(place, "notes"), short(place, "place_id"), short(place, "arrival_time"),
                  let name = place["name"].string?.trimmingCharacters(in: .whitespacesAndNewlines), (1...200).contains(name.count),
                  let pin = pin(place, name) else { return nil }
            pins.append(pin)
        }
        return pins
    }

    private static func pin(_ item: JSONValue, _ title: String) -> (Double, Double, String)? {
        guard let latitude = item["latitude"].number, let longitude = item["longitude"].number,
              latitude.isFinite, longitude.isFinite, (-90.0...90.0).contains(latitude), (-180.0...180.0).contains(longitude) else { return nil }
        return (latitude, longitude, title)
    }

    private static func short(_ input: JSONValue, _ key: String) -> Bool {
        if input.object?[key] == nil || input[key] == .null { return true }
        guard let value = input[key].string?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return (1...200).contains(value.count)
    }

    private static func coord(_ value: Double) -> String {
        let text = String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), value)
        var trimmed = text
        while trimmed.contains(".") && (trimmed.hasSuffix("0") || trimmed.hasSuffix(".")) { trimmed.removeLast() }
        return trimmed == "-0" ? "0" : trimmed
    }

    /// Precise or approximate, as the location tool asked. Nil when the request is not that tool.
    public static func locationRequest(_ input: JSONValue) -> String? {
        locationAccuracy(input["accuracy"].string)
    }

    /// Off when location services are disabled. Denied when the app may not read a fix.
    public static func locationGate(servicesOn: Bool, granted: String?) -> String? {
        if !servicesOn { return "off" }
        if granted != "precise" && granted != "coarse" { return "denied" }
        return nil
    }

    public static func locationAccuracy(_ value: String?) -> String? {
        value == "precise" || value == "approximate" ? value : nil
    }

    /// The coordinates that may leave the device. Nil when permission does not allow a fix.
    public static func reveal(requested: String, granted: String, latitude: Double, longitude: Double) -> (Double, Double)? {
        guard locationAccuracy(requested) != nil, granted == "coarse" || granted == "precise",
              latitude.isFinite, longitude.isFinite, (-90.0...90.0).contains(latitude), (-180.0...180.0).contains(longitude) else { return nil }
        if requested == "approximate" || granted == "coarse" { return (coarse(latitude), coarse(longitude)) }
        return (latitude, longitude)
    }

    public static func calendarSearch(_ input: JSONValue) -> Search? {
        guard let calendarId = optionalText(input, "calendar_id"),
              calendarId?.contains("/") != true, calendarId?.contains("\\") != true, calendarId?.contains("..") != true,
              let text = optionalText(input, "search_text"),
              let start = optionalTime(input, "start_time"),
              let end = optionalTime(input, "end_time") else { return nil }
        if let start, let end, end <= start { return nil }
        let includeAllDay: Bool
        if input.object?["include_all_day"] == nil || input["include_all_day"] == .null { includeAllDay = true }
        else if let value = input["include_all_day"].bool { includeAllDay = value }
        else { return nil }
        let limit: Int
        if input.object?["limit"] == nil || input["limit"] == .null { limit = 20 }
        else if let value = exactInt(input["limit"]), (1...50).contains(value) { limit = value }
        else { return nil }
        return Search(calendarId: calendarId, start: start.map(iso), end: end.map(iso), includeAllDay: includeAllDay, limit: limit, text: text)
    }

    /// Event titles stay on the device until calendar permission is granted.
    public static func visibleTitles(granted: Bool, titles: [String]) -> [String] {
        granted ? titles : []
    }

    public struct Found: Equatable, Sendable {
        public let title: String
        public let allDay: Bool
        public let calendarId: String
    }

    /// Titles that match one search. None leave the device without calendar permission.
    public static func matching(granted: Bool, events: [Found], request: Search) -> [String] {
        guard granted else { return [] }
        return events.filter { event in
            (request.calendarId == nil || event.calendarId == request.calendarId) &&
                (request.includeAllDay || !event.allDay) &&
                (request.text == nil || event.title.range(of: request.text ?? "", options: .caseInsensitive) != nil)
        }.prefix(request.limit).map(\.title)
    }

    public struct Nudge: Equatable, Sendable {
        public let method: String
        public let minutes: Int
    }

    public struct NewEvent: Equatable, Sendable {
        public let title: String
        public let start: String
        public let end: String?
        public let allDay: Bool
        public let calendarId: String?
        public let description: String?
        public let location: String?
        public let nudges: [Nudge]
        public let recurrence: Recurrence?
        public let attendees: [String]
    }

    public struct Recurrence: Equatable, Sendable {
        public let rule: String
        public let frequency: String
        public let interval: Int
        public let days: [String]
        public let monthDay: Int?
        public let count: Int?
        public let until: String?
    }

    public struct RemovedEvent: Equatable, Sendable {
        public let calendarId: String
        public let eventId: String
        public let span: String
    }

    /// Events to add. Nil when the request is not a create the calendar can apply.
    public static func newEvents(_ input: JSONValue) -> [NewEvent]? {
        guard let items = input["new_events"].array, (1...20).contains(items.count) else { return nil }
        var events: [NewEvent] = []
        for item in items {
            guard let title = item["title"].string?.trimmingCharacters(in: .whitespacesAndNewlines), (1...200).contains(title.count),
                  let start = parse(item["start_time"].string ?? "") else { return nil }
            let end: Date?
            if item.object?["end_time"] == nil || item["end_time"] == .null { end = nil }
            else if let date = parse(item["end_time"].string ?? "") { end = date }
            else { return nil }
            if let end, end <= start { return nil }
            let allDay: Bool
            if item.object?["all_day"] == nil || item["all_day"] == .null { allDay = false }
            else if let value = item["all_day"].bool { allDay = value }
            else { return nil }
            guard let calendarId = optionalId(item, "calendar_id"),
                  let description = optionalText(item, "event_description"),
                  let location = optionalText(item, "location"),
                  let nudges = nudges(item),
                  let recurrence = recurrence(item),
                  let attendees = attendees(item) else { return nil }
            events.append(NewEvent(title: title, start: iso(start), end: end.map(iso), allDay: allDay, calendarId: calendarId, description: description, location: location, nudges: nudges, recurrence: recurrence, attendees: attendees))
        }
        return events
    }

    /// Events to remove. A repeating event is not removed as one occurrence unless the span says so.
    public static func removedEvents(_ input: JSONValue) -> [RemovedEvent]? {
        guard let items = input["removed_events"].array, (1...20).contains(items.count) else { return nil }
        var events: [RemovedEvent] = []
        for item in items {
            guard let calendarId = optionalId(item, "calendar_id") ?? nil,
                  let eventId = optionalId(item, "event_id") ?? nil else { return nil }
            let span = item["recurrence_span"]["option"].string ?? "instance"
            guard span == "instance" || span == "series" else { return nil }
            events.append(RemovedEvent(calendarId: calendarId, eventId: eventId, span: span))
        }
        return events
    }

    public struct UpdatedEvent: Equatable, Sendable {
        public let calendarId: String
        public let eventId: String
        public let title: String?
        public let start: String?
        public let end: String?
        public let allDay: Bool?
        public let description: String?
        public let location: String?
        public let availability: String?
        public let status: String?
        public let span: String
    }

    /// Changes to events that already exist. Nil when an id or a new time is not usable.
    public static func updatedEvents(_ input: JSONValue) -> [UpdatedEvent]? {
        guard let items = input["event_updates"].array, (1...20).contains(items.count) else { return nil }
        var events: [UpdatedEvent] = []
        for item in items {
            guard let calendarId = optionalId(item, "calendar_id") ?? nil,
                  let eventId = optionalId(item, "event_id") ?? nil else { return nil }
            guard let title = optionalText(item, "title"),
                  let start = optionalTime(item, "start_time"),
                  let end = optionalTime(item, "end_time"),
                  let description = optionalText(item, "event_description"),
                  let location = optionalText(item, "location") else { return nil }
            if let start, let end, end <= start { return nil }
            let allDay: Bool?
            if item.object?["all_day"] == nil || item["all_day"] == .null { allDay = nil }
            else if let value = item["all_day"].bool { allDay = value }
            else { return nil }
            guard let availability = choice(item, "availability", ["busy", "free", "tentative"]),
                  let status = choice(item, "status", ["confirmed", "tentative", "cancelled"]) else { return nil }
            let span = item["recurrence_span"]["option"].string ?? "series"
            guard span == "instance" || span == "series" else { return nil }
            if title == nil && start == nil && end == nil && allDay == nil && description == nil && location == nil && availability == nil && status == nil { return nil }
            events.append(UpdatedEvent(calendarId: calendarId, eventId: eventId, title: title, start: start.map(iso), end: end.map(iso), allDay: allDay, description: description, location: location, availability: availability, status: status, span: span))
        }
        return events
    }

    private static func coarse(_ value: Double) -> Double {
        (value * 100).rounded() / 100
    }

    private static let weekdayOrder = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
    private static let rulePattern = try! NSRegularExpression(pattern: "^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;INTERVAL=([1-9]\\d{0,2}))?(?:;BYDAY=((?:SU|MO|TU|WE|TH|FR|SA)(?:,(?:SU|MO|TU|WE|TH|FR|SA)){0,6}))?(?:;BYMONTHDAY=((?:[1-9]|[12]\\d|3[01])))?(?:;COUNT=([1-9]\\d{0,2})|;UNTIL=(\\d{8}T\\d{6}Z))?$")

    private static func recurrence(_ item: JSONValue) -> Recurrence?? {
        if item.object?["recurrence"] == nil || item["recurrence"] == .null { return .some(nil) }
        let value = item["recurrence"]
        if value["months"] != .null || value["position"] != .null { return nil }
        guard let frequency = choice(value, "frequency", ["daily", "weekly", "monthly", "yearly"]) ?? nil,
              (optionalText(value, "human_readable_frequency") ?? nil) != nil,
              let rule = optionalText(value, "rrule") ?? nil else { return nil }
        let body = rule.hasPrefix("RRULE:") ? String(rule.dropFirst(6)) : rule
        let range = NSRange(body.startIndex..., in: body)
        guard let match = rulePattern.firstMatch(in: body, range: range), match.range.length == body.utf16.count else { return nil }
        func group(_ index: Int) -> String? {
            let found = match.range(at: index)
            guard found.location != NSNotFound, let text = Range(found, in: body) else { return nil }
            return String(body[text])
        }
        guard group(1)?.lowercased() == frequency else { return nil }
        let interval = Int(group(2) ?? "1") ?? 0
        guard (1...366).contains(interval) else { return nil }
        if value.object?["interval"] != nil && value["interval"] != .null && whole(value["interval"], 1, 366) != interval { return nil }
        let days = group(3)?.split(separator: ",").map(String.init) ?? []
        guard Set(days).count == days.count, days == days.sorted(by: { weekdayOrder.firstIndex(of: $0)! < weekdayOrder.firstIndex(of: $1)! }) else { return nil }
        if !days.isEmpty && frequency != "weekly" { return nil }
        if let requested = value["days_of_week"].array?.compactMap(\.string), requested != days { return nil }
        let monthDay = group(4).flatMap(Int.init)
        if monthDay != nil && frequency != "monthly" { return nil }
        if value.object?["day_of_month"] != nil && value["day_of_month"] != .null && whole(value["day_of_month"], 1, 31) != monthDay { return nil }
        let count = group(5).flatMap(Int.init)
        let until = group(6)
        if value["end"] != .null {
            let type = value["end"]["type"].string
            let matches = type == "count" && until == nil && whole(value["end"]["count"], 1, 999) == count
                || type == "until" && count == nil && value["end"]["until"].string == until
            if !matches { return nil }
        }
        return Recurrence(rule: body, frequency: frequency, interval: interval, days: days, monthDay: monthDay, count: count, until: until)
    }

    private static func whole(_ value: JSONValue, _ low: Int, _ high: Int) -> Int? {
        guard let number = value.number, number.isFinite, number.rounded() == number, (Double(low)...Double(high)).contains(number) else { return nil }
        return Int(number)
    }

    private static let email = try! NSRegularExpression(pattern: "^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,24}$")

    private static func attendees(_ item: JSONValue) -> [String]? {
        if item.object?["attendees"] == nil || item["attendees"] == .null { return [] }
        guard let values = item["attendees"].array, values.count <= 20 else { return nil }
        var emails: [String] = []
        for value in values {
            guard let email = value.string?.trimmingCharacters(in: .whitespacesAndNewlines),
                  self.email.firstMatch(in: email, range: NSRange(email.startIndex..., in: email))?.range.length == email.utf16.count else { return nil }
            emails.append(email)
        }
        guard Set(emails.map { $0.lowercased() }).count == emails.count else { return nil }
        return emails
    }

    private static func nudges(_ item: JSONValue) -> [Nudge]? {
        if item.object?["nudges"] == nil || item["nudges"] == .null { return [] }
        guard let items = item["nudges"].array, items.count <= 10 else { return nil }
        let methods: Set<String> = ["fallback", "notification", "email", "sms", "alarm"]
        var nudges: [Nudge] = []
        for nudge in items {
            guard let method = nudge["method"].string, methods.contains(method),
                  let minutes = minutesBefore(nudge["minutes_before"]) else { return nil }
            nudges.append(Nudge(method: method, minutes: minutes))
        }
        return nudges
    }

    private static func choice(_ input: JSONValue, _ key: String, _ allowed: Set<String>) -> String?? {
        guard let value = optionalText(input, key) else { return nil }
        if value == nil { return .some(nil) }
        guard let value, allowed.contains(value) else { return nil }
        return value
    }

    private static func optionalId(_ input: JSONValue, _ key: String) -> String?? {
        guard let text = optionalText(input, key) else { return nil }
        if text == nil { return .some(nil) }
        guard let text, (1...80).contains(text.count), text.range(of: #"^[A-Za-z0-9_.:-]+$"#, options: .regularExpression) != nil else { return nil }
        return text
    }

    private static func optionalText(_ input: JSONValue, _ key: String) -> String?? {
        guard input.object?[key] != nil else { return .some(nil) }
        if input[key] == .null { return .some(nil) }
        guard let value = input[key].string?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty, value.count <= 200 else { return nil }
        return value
    }

    private static func optionalTime(_ input: JSONValue, _ key: String) -> Date?? {
        guard input.object?[key] != nil else { return .some(nil) }
        if input[key] == .null { return .some(nil) }
        guard let value = input[key].string, let date = parse(value) else { return nil }
        return date
    }

    private static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }

    private static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    private static func minutesBefore(_ value: JSONValue) -> Int? {
        guard let number = value.number, number.isFinite, number.rounded() == number, (0...40_320).contains(number) else { return nil }
        return Int(number)
    }

    private static func exactInt(_ value: JSONValue) -> Int? {
        guard let number = value.number, number.isFinite, number.rounded() == number, (1...50).contains(number) else { return nil }
        return Int(number)
    }
}
