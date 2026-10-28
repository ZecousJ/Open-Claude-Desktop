import Foundation

/// Official recency groups for chat lists. Order is the display order; a chat lands in the first bucket that matches
/// its local date.
public enum RecencyBucket: Int, CaseIterable, Sendable {
  case today, yesterday, thisWeek, lastWeek, thisMonth, lastMonth, thisYear, older

  /// The catalogue key of the bucket's title.
  public var stringKey: String {
    switch self {
    case .today: "recency_today"
    case .yesterday: "recency_yesterday"
    case .thisWeek: "recency_this_week"
    case .lastWeek: "recency_last_week"
    case .thisMonth: "recency_this_month"
    case .lastMonth: "recency_last_month"
    case .thisYear: "recency_this_year"
    case .older: "recency_older"
    }
  }

  /// Days between the two local dates: ≤0 today, 1 yesterday, <7 this week, <14 last week,
  /// then same month, previous month, same year, older.
  public static func of(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> RecencyBucket {
    let day = calendar.startOfDay(for: date)
    let today = calendar.startOfDay(for: now)
    let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
    if days <= 0 { return .today }
    if days == 1 { return .yesterday }
    if days < 7 { return .thisWeek }
    if days < 14 { return .lastWeek }
    let a = calendar.dateComponents([.year, .month], from: day)
    let b = calendar.dateComponents([.year, .month], from: today)
    if a.year == b.year && a.month == b.month { return .thisMonth }
    if let previous = calendar.date(byAdding: .month, value: -1, to: today) {
      let p = calendar.dateComponents([.year, .month], from: previous)
      if a.year == p.year && a.month == p.month { return .lastMonth }
    }
    return a.year == b.year ? .thisYear : .older
  }

  /// Groups items in bucket order, keeping each bucket's input order; empty buckets are dropped.
  public static func group<T>(_ items: [T], now: Date = Date(), calendar: Calendar = .current, date: (T) -> Date)
    -> [(bucket: RecencyBucket, items: [T])]
  {
    var buckets: [RecencyBucket: [T]] = [:]
    for item in items { buckets[of(date(item), now: now, calendar: calendar), default: []].append(item) }
    return allCases.compactMap { bucket in buckets[bucket].map { (bucket, $0) } }
  }
}
