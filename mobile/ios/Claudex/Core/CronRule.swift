import Foundation

/// The five-field cron expressions a task's Custom schedule takes: a port of the service's `shared/cron.ts`
/// (numeric fields only, 0 for Sunday, and nothing that runs more than once an hour), so the phone refuses
/// what the service would refuse.
public enum CronRule {
    public enum Problem: Equatable, Sendable { case invalid, subHourly, numericOnly, sundayIsZero }
    private static let bounds: [(Int, Int)] = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]

    private static func number(_ text: String) -> Int? {
        guard !text.isEmpty, text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return nil }
        return Int(text)
    }
    private static func field(_ text: String, _ bound: (Int, Int)) -> [Int]? {
        var values = Set<Int>()
        for piece in text.split(separator: ",", omittingEmptySubsequences: false) {
            let halves = piece.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard halves.count <= 2 else { return nil }
            var step = 1
            if halves.count == 2 {
                guard let value = number(halves[1]) else { return nil }
                step = value
            }
            guard step >= 1 else { return nil }
            var from = bound.0, to = bound.1
            if halves[0] != "*" {
                let range = halves[0].split(separator: "-", omittingEmptySubsequences: false).map(String.init)
                guard range.count <= 2, let low = number(range[0]) else { return nil }
                from = low
                if range.count == 2 {
                    guard let high = number(range[1]) else { return nil }
                    to = high
                } else {
                    to = halves.count == 1 ? low : bound.1
                }
            }
            guard from >= bound.0, to <= bound.1, from <= to else { return nil }
            var value = from
            while value <= to { values.insert(value); value += step }
        }
        return values.sorted()
    }
    private static func parts(_ expression: String) -> [String] {
        expression.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: \.isWhitespace).map(String.init)
    }

    public static func problem(_ expression: String) -> Problem? {
        let parts = parts(expression)
        guard parts.count == 5 else { return .invalid }
        if parts.contains(where: { $0.contains { ($0 >= "A" && $0 <= "Z") || ($0 >= "a" && $0 <= "z") || $0 == "?" || $0 == "#" } }) { return .numericOnly }
        if parts[4].split(separator: ",", omittingEmptySubsequences: false).contains(where: {
            $0.split(separator: "/", omittingEmptySubsequences: false)[0].split(separator: "-", omittingEmptySubsequences: false).contains("7")
        }) { return .sundayIsZero }
        let parsed = parts.enumerated().map { field($0.element, bounds[$0.offset]) }
        if parsed.contains(where: { $0?.isEmpty ?? true }) { return .invalid }
        if parsed[0]!.count > 1 { return .subHourly }
        return nil
    }
    /// The service's own `frequency` for a cron rule: hourly when its hour field is open, otherwise daily.
    public static func frequency(_ expression: String) -> String {
        guard problem(expression) == nil, field(parts(expression)[1], bounds[1])?.count == 24 else { return "daily" }
        return "hourly"
    }
    /// "M H * * d,d" for a time of day on some weekdays (Sunday = 0): what a rule saved as chosen days reads as.
    public static func forDays(time: String, days: [Int]) -> String {
        let clock = time.split(separator: ":").map { Int($0) ?? 0 }
        let list = Array(Set(days)).sorted()
        return "\(clock.count > 1 ? clock[1] : 0) \(clock.first ?? 0) * * \(list.count == 7 || list.isEmpty ? "*" : list.map(String.init).joined(separator: ","))"
    }
    /// A simple expression read back as a time of day on some weekdays; nil for anything that fires more often or on dates.
    public static func asDays(_ expression: String) -> (time: String, days: [Int])? {
        guard problem(expression) == nil else { return nil }
        let parts = parts(expression)
        guard let minutes = field(parts[0], bounds[0]), let hours = field(parts[1], bounds[1]), let months = field(parts[3], bounds[3]), let days = field(parts[4], bounds[4]),
              minutes.count == 1, hours.count == 1, parts[2].hasPrefix("*"), months.count == 12 else { return nil }
        return (String(format: "%02d:%02d", hours[0], minutes[0]), days)
    }
}
