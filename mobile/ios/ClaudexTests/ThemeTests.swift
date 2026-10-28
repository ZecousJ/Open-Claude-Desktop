#if !SWIFT_PACKAGE
import SwiftUI
import UIKit
import XCTest
@testable import Claudex

/// App-only checks for the official theme: icons, bundled fonts, catalogue in the bundle.
@MainActor
final class ThemeTests: XCTestCase {
  func testEveryAppGlyphHasAnSFSymbol() {
    let missing = AppGlyph.allCases.filter { UIImage(systemName: $0.symbol) == nil }.map(\.rawValue)
    XCTAssertEqual(missing, [])
  }

  func testBundledOpenFontsAreRegistered() {
    for weight in [400, 500, 550, 700] {
      XCTAssertNotNil(UIFont(name: FontRegistry.serifName(weight), size: 17), "serif \(weight)")
      XCTAssertNotNil(UIFont(name: FontRegistry.monoName(weight), size: 13), "mono \(weight)")
    }
  }

  func testAppBundleShipsBothCataloguesAndDefaultsToChinese() {
    let directory = Bundle.main.bundleURL.appendingPathComponent("Strings")
    XCTAssertFalse(StringCatalog.load(language: "en", directory: directory).isEmpty)
    XCTAssertFalse(StringCatalog.load(language: "zh-Hans", directory: directory).isEmpty)
    if UserDefaults.standard.string(forKey: L10n.languageKey) == nil {
      XCTAssertEqual(L("nav_drawer_item_chats"), "对话")
      XCTAssertEqual(L10n.plural("nav_drawer_pinned_show_all", count: 7), "显示全部 7 个")
      XCTAssertEqual(L("user_avatar_settings_content_description", "Ada"), "Ada，设置")
    }
  }

  func testTokensResolveForBothAppearances() {
    let light = UITraitCollection(userInterfaceStyle: .light)
    let dark = UITraitCollection(userInterfaceStyle: .dark)
    func hex(_ color: Color, _ traits: UITraitCollection) -> String {
      var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
      UIColor(color).resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
      return String(format: "%02X%02X%02X", Int(round(r * 255)), Int(round(g * 255)), Int(round(b * 255)))
    }
    XCTAssertEqual(hex(Palette.bg100, light), "F9F9F7")
    XCTAssertEqual(hex(Palette.bg100, dark), "151515")
    XCTAssertEqual(hex(Palette.text100, light), "131313")
    XCTAssertEqual(hex(Palette.text100, dark), "F9F9F7")
    XCTAssertEqual(hex(Palette.accentMain100, light), "C6613F")
    XCTAssertEqual(hex(Palette.accentMain100, dark), "D97757")
    XCTAssertEqual(hex(Palette.bg200, dark), "111111")
  }

  func testAvatarInitials() {
    XCTAssertEqual(ClaudeAvatar.initials("Ada Lovelace"), "AL")
    XCTAssertEqual(ClaudeAvatar.initials("ada@example.com"), "AE")
    XCTAssertEqual(ClaudeAvatar.initials("张三"), "张")
    XCTAssertEqual(ClaudeAvatar.initials(""), "?")
  }
}
#endif
