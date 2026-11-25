import Foundation

/// System handoff for a clock, a phone number, or a message draft.
/// A call is never placed and a message is never sent from this app.
/// Android may hand a clock time to the system clock without an extra confirmation
/// only while the app is open on screen. iOS always leaves that confirmation to the system.
public enum DeviceHandoff {
    public enum Clock: Equatable, Sendable {
        case alarm(hour: Int, minute: Int, message: String, days: [Int]?, vibrate: Bool?)
        case timer(seconds: Int, message: String)
        case failed(String)
    }

    /// The dial or message draft, or nil when the text is not one this app will hand to the system.
    public static func canonical(_ raw: String) -> String? {
        guard raw.utf8.count <= 2_048, !raw.unicodeScalars.contains(where: { $0.value < 32 || $0 == "\\" }) else { return nil }
        let parts = raw.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let scheme = parts[0].lowercased()
        let rest = String(parts[1])
        switch scheme {
        case "tel":
            guard !rest.contains("?"), !rest.contains("#"), let number = digits(rest) else { return nil }
            return "tel:" + number
        case "sms", "smsto":
            return message(scheme, rest)
        default:
            return nil
        }
    }

    public static func mentions(_ source: String, _ canonical: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: #"(?i)(?:tel:|sms:|smsto:)[+0-9() .?%=&~_-]{1,300}"#) else { return false }
        for match in regex.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            guard let range = Range(match.range, in: source) else { continue }
            var value = String(source[range])
            while let last = value.last, ".,;:!?".contains(last) { value.removeLast() }
            while value.last == ")" && value.filter({ $0 == ")" }).count > value.filter({ $0 == "(" }).count { value.removeLast() }
            if Self.canonical(value) == canonical { return true }
        }
        return false
    }

    /// The clock request the model named. Nil when [name] is not a clock tool.
    public static func clock(name: String, input: JSONValue, platform: String, foreground: Bool) -> Clock? {
        guard name == "alarm_create_v0" || name == "timer_create_v0" else { return nil }
        if platform == "android" && !foreground {
            let which = name == "alarm_create_v0" ? "alarm" : "timer"
            return .failed("Failed to set \(which): Android only lets Claude set a \(which) while the Claude app is open on screen, and it is not right now, so no \(which) was set. Tell the user it was not set; it will work once the Claude app is open on screen.")
        }
        if platform != "android" {
            return .failed(name == "alarm_create_v0" ? "Failed to set alarm." : "Failed to set timer on device.")
        }
        return name == "alarm_create_v0" ? alarm(input) : timer(input)
    }

    private static func alarm(_ input: JSONValue) -> Clock {
        guard let hour = exactInt(input, "hour"), let minute = exactInt(input, "minute"), let message = text(input, "message"),
              (0...23).contains(hour), (0...59).contains(minute) else { return .failed("Failed to set alarm.") }
        let days: [Int]?
        if input.object?["days"] == nil || input["days"] == .null { days = nil }
        else if let parsed = dayList(input["days"]) { days = parsed }
        else { return .failed("Failed to set alarm.") }
        let vibrate: Bool?
        if input.object?["vibrate"] == nil || input["vibrate"] == .null { vibrate = nil }
        else if let value = input["vibrate"].bool { vibrate = value }
        else { return .failed("Failed to set alarm.") }
        return .alarm(hour: hour, minute: minute, message: message, days: days, vibrate: vibrate)
    }

    private static func timer(_ input: JSONValue) -> Clock {
        guard let seconds = exactInt(input, "duration_seconds"), let message = text(input, "message"),
              (1...86_400).contains(seconds) else { return .failed("Failed to set timer on device.") }
        return .timer(seconds: seconds, message: message)
    }

    private static func dayList(_ value: JSONValue) -> [Int]? {
        guard let values = value.array, (1...7).contains(values.count) else { return nil }
        var days: [Int] = []
        for item in values {
            guard let number = exactNumber(item), (1...7).contains(number), !days.contains(number) else { return nil }
            days.append(number)
        }
        return days
    }

    private static func text(_ input: JSONValue, _ key: String) -> String? {
        guard let value = input[key].string?.trimmingCharacters(in: .whitespacesAndNewlines), (1...200).contains(value.count) else { return nil }
        return value
    }

    private static func exactInt(_ input: JSONValue, _ key: String) -> Int? {
        guard input.object?[key] != nil, input[key] != .null else { return nil }
        return exactNumber(input[key])
    }

    private static func exactNumber(_ value: JSONValue) -> Int? {
        guard let number = value.number, number.isFinite, number.rounded() == number,
              number >= Double(Int.min), number <= Double(Int.max) else { return nil }
        return Int(number)
    }

    private static func digits(_ raw: String) -> String? {
        guard !raw.isEmpty else { return nil }
        var cleaned = ""
        for character in raw {
            switch character {
            case "0"..."9", "+": cleaned.append(character)
            case " ", "(", ")", "-", ".": continue
            default: return nil
            }
        }
        if cleaned.filter({ $0 == "+" }).count > 1 || (cleaned.contains("+") && !cleaned.hasPrefix("+")) { return nil }
        guard cleaned.range(of: #"^\+?[0-9]{3,15}$"#, options: .regularExpression) != nil else { return nil }
        return cleaned
    }

    private static func message(_ scheme: String, _ rest: String) -> String? {
        guard !rest.contains("#"), !rest.contains("?") || rest.filter({ $0 == "?" }).count == 1 else { return nil }
        let recipient = rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let query = rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).dropFirst().first.map(String.init) ?? ""
        let number = recipient.isEmpty ? "" : (digits(recipient) ?? "")
        if !recipient.isEmpty && number.isEmpty { return nil }
        let body: String?
        if query.isEmpty { body = nil }
        else {
            guard query.hasPrefix("body=") else { return nil }
            guard let decoded = decode(String(query.dropFirst(5))) else { return nil }
            body = decoded
        }
        if number.isEmpty && (body ?? "").isEmpty { return nil }
        let encoded = body.map { $0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)?.replacingOccurrences(of: "&", with: "%26") ?? "" } ?? ""
        if body != nil && encoded.isEmpty { return nil }
        if number.isEmpty { return "\(scheme):?body=\(encoded)" }
        if body == nil { return "\(scheme):\(number)" }
        return "\(scheme):\(number)?body=\(encoded)"
    }

    private static func decode(_ value: String) -> String? {
        guard value.utf8.count <= 3_000, !value.contains("+"), !value.unicodeScalars.contains(where: { $0.value <= 32 }) else { return nil }
        guard let text = value.removingPercentEncoding, (1...1_000).contains(text.count) else { return nil }
        if text.unicodeScalars.contains(where: { $0.value < 32 && $0 != "\n" && $0 != "\t" }) { return nil }
        return text
    }
}
