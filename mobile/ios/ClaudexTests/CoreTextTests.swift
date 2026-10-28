import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

/// The app installs its string catalogue as the Core's resolver at launch; the tests do the same with the
/// Simplified Chinese catalogue read from `Resources/Strings`, so what they compare is what a person reads.
enum CoreTextForTests {
  static var stringsDirectory: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Claudex/Resources/Strings")
  }
  static func install(language: String = "zh-Hans") {
    let english = StringCatalog.load(language: "en", directory: stringsDirectory)
    let table = language == "en" ? english : StringCatalog.load(language: language, directory: stringsDirectory)
    let catalog = StringCatalog(language: language, table: table, fallback: english)
    CoreText.install { key, arguments in catalog.string(key, arguments) }
  }
}

final class CoreTextTests: XCTestCase {
  override func setUp() { CoreTextForTests.install() }
  override func tearDown() { CoreTextForTests.install() }

  func testEveryKeyIsInBothCatalogues() {
    let english = StringCatalog.load(language: "en", directory: CoreTextForTests.stringsDirectory)
    let chinese = StringCatalog.load(language: "zh-Hans", directory: CoreTextForTests.stringsDirectory)
    for key in CoreText.Key.allCases {
      XCTAssertNotNil(english[key.rawValue], "missing in en.strings: \(key.rawValue)")
      XCTAssertNotNil(chinese[key.rawValue], "missing in zh-Hans.strings: \(key.rawValue)")
    }
    XCTAssertEqual(Set(CoreText.Key.allCases.map(\.rawValue)).count, CoreText.Key.allCases.count)
  }

  func testPlaceholdersMatchBetweenLanguages() {
    let english = StringCatalog.load(language: "en", directory: CoreTextForTests.stringsDirectory)
    let chinese = StringCatalog.load(language: "zh-Hans", directory: CoreTextForTests.stringsDirectory)
    func placeholders(_ text: String) -> [String] {
      (try? NSRegularExpression(pattern: #"%\d+\$[@d]"#))?.matches(in: text, range: NSRange(text.startIndex..., in: text))
        .compactMap { Range($0.range, in: text).map { String(text[$0]) } }.sorted() ?? []
    }
    for key in CoreText.Key.allCases {
      XCTAssertEqual(placeholders(english[key.rawValue] ?? ""), placeholders(chinese[key.rawValue] ?? ""), key.rawValue)
    }
  }

  func testCoreHoldsNoHardCodedChinese() throws {
    let core = CoreTextForTests.stringsDirectory.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Core")
    let files = try FileManager.default.contentsOfDirectory(at: core, includingPropertiesForKeys: nil).filter { $0.pathExtension == "swift" }
    XCTAssertGreaterThan(files.count, 20)
    var offenders: [String] = []
    for file in files {
      let source = try String(contentsOf: file, encoding: .utf8)
      for (number, line) in source.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("//") || trimmed.hasPrefix("*") || trimmed.hasPrefix("/*") { continue }
        // Code before a trailing comment only.
        let code = line.components(separatedBy: " // ").first ?? String(line)
        if code.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { offenders.append("\(file.lastPathComponent):\(number + 1)") }
      }
    }
    XCTAssertEqual(offenders, [], "Chinese in the Core belongs in Resources/Strings, reached through CoreText")
  }

  func testWithoutAResolverAKeyAnswersItself() {
    CoreText.install(nil)
    XCTAssertEqual(CoreText.string(.keyGone), "claudex_core_key_gone")
    CoreTextForTests.install(language: "en")
    XCTAssertEqual(CoreText.string(.photoName, 3, "png"), "Photo 3.png")
    CoreTextForTests.install()
    XCTAssertEqual(CoreText.string(.photoName, 3, "png"), "照片 3.png")
    XCTAssertEqual(CoreText.string(.snippetName, "py"), "代码片段.py")
  }
}
