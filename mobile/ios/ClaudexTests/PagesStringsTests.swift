import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

/// The list, settings, Code and scheduled-task pages look their copy up by official resource
/// name; every key they use must be in both catalogues (portable: `swift test` and Xcode).
final class PagesStringsTests: XCTestCase {
  private var root: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Claudex")
  }
  private let pages = [
    "UI/AllChatsView.swift", "UI/ProjectViews.swift", "UI/ProjectKnowledgeView.swift", "UI/WorkViews.swift",
    "UI/DeviceViews.swift", "UI/CloudPermissionView.swift", "UI/RepositoryPickerView.swift", "UI/SettingsViews.swift",
    "UI/MemoryViews.swift", "UI/APIGroupsView.swift", "UI/AccountToolsViews.swift", "UI/ScheduleViews.swift",
    "UI/CoworkStarterView.swift", "UI/ServiceStatusView.swift", "UI/LibrarySettingsViews.swift", "UI/ConversationProjectPicker.swift",
    "UI/Components/PageComponents.swift",
  ]

  func testEveryPageKeyIsInBothCatalogues() throws {
    let strings = root.appendingPathComponent("Resources/Strings")
    let english = StringCatalog.load(language: "en", directory: strings)
    let chinese = StringCatalog.load(language: "zh-Hans", directory: strings)
    let pattern = try NSRegularExpression(pattern: #"L(?:10n\.plural)?\("([a-z0-9_]+)""#)
    var used = Set<String>()
    for page in pages {
      let source = try String(contentsOf: root.appendingPathComponent(page), encoding: .utf8)
      for match in pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
        if let range = Range(match.range(at: 1), in: source) { let key = String(source[range]); if !key.hasSuffix("_") { used.insert(key) } }
      }
    }
    XCTAssertGreaterThan(used.count, 300)
    for key in used.sorted() {
      XCTAssertTrue(english[key] != nil || english[key + "#other"] != nil, "missing in en.strings: \(key)")
      XCTAssertTrue(chinese[key] != nil || chinese[key + "#other"] != nil, "missing in zh-Hans.strings: \(key)")
    }
  }

  /// Keys built at run time (work types, order and key states) exist for every value the
  /// service sends.
  func testComposedKeysExist() {
    let strings = root.appendingPathComponent("Resources/Strings")
    let chinese = StringCatalog.load(language: "zh-Hans", directory: strings)
    let work = ["engineering", "design", "product", "data", "research", "marketing", "sales", "operations", "finance", "legal", "education", "writing", "other"]
    for value in work { XCTAssertNotNil(chinese["claudex_work_type_" + value], value) }
    for value in ["pending", "paid", "recharging", "completed", "expired", "cancelled", "failed", "refunded"] {
      XCTAssertNotNil(chinese["claudex_order_status_" + value], value)
    }
    for value in ["active", "inactive", "expired", "exhausted"] { XCTAssertNotNil(chinese["claudex_api_key_status_" + value], value) }
  }

  /// Product rules: no plumbing status text in the pages' Chinese copy.
  func testNoPlumbingStatusText() {
    let strings = root.appendingPathComponent("Resources/Strings")
    let chinese = StringCatalog.load(language: "zh-Hans", directory: strings)
    for (key, value) in chinese where key.hasPrefix("claudex_") {
      for banned in ["正在连接", "重新连接中", "正在同步", "正在刷新", "加载完整内容"] {
        XCTAssertFalse(value.contains(banned), "\(key): \(value)")
      }
    }
  }
}
