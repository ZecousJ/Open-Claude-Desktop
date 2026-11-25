import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

/// String catalogues and recency buckets (portable: runs under `swift test` and in Xcode).
final class FoundationTests: XCTestCase {
  private var stringsDirectory: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Claudex/Resources/Strings")
  }

  func testCataloguesParseAndAgree() throws {
    let english = StringCatalog.load(language: "en", directory: stringsDirectory)
    let chinese = StringCatalog.load(language: "zh-Hans", directory: stringsDirectory)
    XCTAssertGreaterThan(english.count, 50)
    XCTAssertGreaterThan(chinese.count, 50)
    // Chinese has no singular plural form; every other key must exist in both catalogues.
    let englishKeys = Set(english.keys.filter { !$0.hasSuffix("#one") })
    XCTAssertEqual(englishKeys.subtracting(chinese.keys).sorted(), [], "missing in zh-Hans.strings")
    XCTAssertEqual(Set(chinese.keys).subtracting(english.keys).sorted(), [], "missing in en.strings")
    for (key, value) in chinese {
      guard let source = english[key] else { continue }
      XCTAssertEqual(
        StringCatalog.placeholders(value), StringCatalog.placeholders(source), "placeholders differ for \(key)")
      XCTAssertFalse(value.isEmpty, key)
    }
    // Official copy uses typographic punctuation; never "..." for an ellipsis.
    for (key, value) in english { XCTAssertFalse(value.contains("..."), key) }
  }

  func testLookupFallsBackAndFormats() {
    let catalog = StringCatalog(
      language: "zh-Hans",
      table: ["a": "你好 %1$@", "n#other": "显示全部 %1$d 个"],
      fallback: ["b": "Only English", "n#one": "Show all %1$d", "n#other": "Show all %1$d"])
    XCTAssertEqual(catalog.string("a", ["Claudex"]), "你好 Claudex")
    XCTAssertEqual(catalog.string("b"), "Only English")
    XCTAssertEqual(catalog.string("missing_key"), "missing_key")
    XCTAssertEqual(catalog.plural("n", count: 1), "显示全部 1 个")
    let english = StringCatalog(language: "en", table: ["n#one": "one %1$d", "n#other": "many %1$d"])
    XCTAssertEqual(english.plural("n", count: 1), "one 1")
    XCTAssertEqual(english.plural("n", count: 7), "many 7")
  }

  func testRecencyBucketsFollowTheOfficialRules() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
    func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 12) -> Date {
      calendar.date(from: DateComponents(year: y, month: m, day: d, hour: h))!
    }
    let now = date(2026, 10, 20, 9)
    XCTAssertEqual(RecencyBucket.of(date(2026, 10, 20, 1), now: now, calendar: calendar), .today)
    XCTAssertEqual(RecencyBucket.of(date(2026, 10, 21), now: now, calendar: calendar), .today)
    XCTAssertEqual(RecencyBucket.of(date(2026, 10, 19, 23), now: now, calendar: calendar), .yesterday)
    XCTAssertEqual(RecencyBucket.of(date(2026, 10, 14), now: now, calendar: calendar), .thisWeek)
    XCTAssertEqual(RecencyBucket.of(date(2026, 10, 13), now: now, calendar: calendar), .lastWeek)
    XCTAssertEqual(RecencyBucket.of(date(2026, 10, 2), now: now, calendar: calendar), .thisMonth)
    XCTAssertEqual(RecencyBucket.of(date(2026, 9, 1), now: now, calendar: calendar), .lastMonth)
    XCTAssertEqual(RecencyBucket.of(date(2026, 2, 1), now: now, calendar: calendar), .thisYear)
    XCTAssertEqual(RecencyBucket.of(date(2025, 12, 31), now: now, calendar: calendar), .older)
    let grouped = RecencyBucket.group(
      [date(2025, 1, 1), date(2026, 10, 20), date(2026, 10, 19), date(2026, 10, 20, 2)], now: now,
      calendar: calendar, date: { $0 })
    XCTAssertEqual(grouped.map(\.bucket), [.today, .yesterday, .older])
    XCTAssertEqual(grouped.first?.items.count, 2)
  }
}
