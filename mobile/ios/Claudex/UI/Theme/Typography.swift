import SwiftUI
import CoreText
import UIKit

/// Official type scale (design-system.md §2). Sizes are points at the default content size and
/// grow with Dynamic Type, like the official `sp` values grow with the Android font scale.
///
/// The new-chat greeting and composer use the font files from Claude Android 1.261111.19.
enum TypeStyle: CaseIterable {
  // UI scale (`je6`)
  /// `je6.v` Serif 28/400 — large serif heading.
  case serifLarge
  /// `je6.w` Serif 22/400 — home greeting.
  case greeting
  case composerInput
  /// `je6.x` Serif 28/500 — screen titles, onboarding and sign-in titles.
  case screenTitle
  /// `je6.y` Serif 34/550 — hero.
  case hero
  /// `je6.z` Serif 17/550 — small serif title (M3 headlineSmall / titleLarge).
  case serifTitle
  /// `je6.A` Sans 20/500 — dialog title.
  case dialogTitle
  /// `je6.B` Sans 17/400.
  case bodyLarge
  /// `je6.C` Sans 17/550 — Medium/Large button label.
  case bodyLargeStrong
  /// `je6.D` Sans 17/400, 1.6 line height.
  case bodyLargeLoose
  /// `je6.E` Sans 15/400 — default body: list rows, sheet actions, menus, dialog body.
  case body
  /// `je6.F` Sans 15/550 — Small button label, chips, section headers.
  case bodyStrong
  /// `je6.G` Sans 15/500, 1.6 line height.
  case bodyMediumLoose
  /// `je6.H` Sans 13/400 — captions, snackbar message.
  case caption
  /// `je6.I` Sans 13/550 — caption emphasis, snackbar title, "New" badge.
  case captionStrong
  /// `je6.J` Sans 13/400, 1.6 line height.
  case captionLoose
  /// `je6.K` Sans 11/400 — micro labels.
  case micro
  /// `je6.L` Sans 11/550 — badges.
  case badge
  // Reading scale (`wt`): serif prose, mono code
  case readingH1, readingH2, readingH3
  /// `wt.d` 17/400, 1.5 — message paragraph; onboarding subtitle.
  case reading
  case readingStrong
  case readingCompact
  case readingCompactStrong
  /// `wt.h` Mono 15/400.
  case code
  /// `wt.i` Mono 13/400 — code blocks and inline code.
  case codeSmall

  enum Family { case sans, serif, mono }

  struct Spec {
    let family: Family
    let size: CGFloat
    /// CSS-style weight (400, 500, 550, 600, 700).
    let weight: Int
    /// Line height as a multiple of the size.
    let lineHeight: CGFloat
  }

  var spec: Spec {
    switch self {
    case .serifLarge: Spec(family: .serif, size: 28, weight: 400, lineHeight: 1.3)
    case .greeting: Spec(family: .serif, size: 22, weight: 400, lineHeight: 1.3)
    case .screenTitle: Spec(family: .serif, size: 28, weight: 500, lineHeight: 1.3)
    case .hero: Spec(family: .serif, size: 34, weight: 550, lineHeight: 1.3)
    case .serifTitle: Spec(family: .serif, size: 17, weight: 550, lineHeight: 1.3)
    case .dialogTitle: Spec(family: .sans, size: 20, weight: 500, lineHeight: 1.4)
    case .composerInput, .bodyLarge: Spec(family: .sans, size: 17, weight: 400, lineHeight: 1.4)
    case .bodyLargeStrong: Spec(family: .sans, size: 17, weight: 550, lineHeight: 1.4)
    case .bodyLargeLoose: Spec(family: .sans, size: 17, weight: 400, lineHeight: 1.6)
    case .body: Spec(family: .sans, size: 15, weight: 400, lineHeight: 1.4)
    case .bodyStrong: Spec(family: .sans, size: 15, weight: 550, lineHeight: 1.4)
    case .bodyMediumLoose: Spec(family: .sans, size: 15, weight: 500, lineHeight: 1.6)
    case .caption: Spec(family: .sans, size: 13, weight: 400, lineHeight: 1.4)
    case .captionStrong: Spec(family: .sans, size: 13, weight: 550, lineHeight: 1.4)
    case .captionLoose: Spec(family: .sans, size: 13, weight: 400, lineHeight: 1.6)
    case .micro: Spec(family: .sans, size: 11, weight: 400, lineHeight: 1.5)
    case .badge: Spec(family: .sans, size: 11, weight: 550, lineHeight: 1.5)
    case .readingH1: Spec(family: .serif, size: 28, weight: 550, lineHeight: 1.3)
    case .readingH2: Spec(family: .serif, size: 24, weight: 550, lineHeight: 1.3)
    case .readingH3: Spec(family: .serif, size: 20, weight: 550, lineHeight: 1.3)
    case .reading: Spec(family: .serif, size: 17, weight: 400, lineHeight: 1.5)
    case .readingStrong: Spec(family: .serif, size: 17, weight: 550, lineHeight: 1.5)
    case .readingCompact: Spec(family: .serif, size: 15, weight: 400, lineHeight: 1.6)
    case .readingCompactStrong: Spec(family: .serif, size: 15, weight: 550, lineHeight: 1.6)
    case .code: Spec(family: .mono, size: 15, weight: 400, lineHeight: 1.5)
    case .codeSmall: Spec(family: .mono, size: 13, weight: 400, lineHeight: 1.5)
    }
  }

  /// The font at a given point size (already scaled), with the official weight.
  static func uiFont(family: Family, size: CGFloat, weight: Int) -> UIFont {
    switch family {
    case .sans:
      return UIFont.systemFont(ofSize: size, weight: FontRegistry.uiWeight(weight))
    case .serif:
      if let font = UIFont(name: FontRegistry.serifName(weight), size: size) {
        // Noto Serif has no Chinese glyphs: Chinese uses the bundled Noto Serif CJK SC subset
        // (GB2312, Resources/Fonts/NotoSerifSC.otf, OFL), then Apple's downloadable Songti.
        let cascade = [UIFontDescriptor(name: "NotoSerifCJKsc-Regular", size: size),
                       UIFontDescriptor(name: CJKSerif.name(weight), size: size)]
        return UIFont(descriptor: font.fontDescriptor.addingAttributes([.cascadeList: cascade]), size: size)
      }
      let base = UIFont.systemFont(ofSize: size, weight: FontRegistry.uiWeight(weight))
      return base.fontDescriptor.withDesign(.serif).map { UIFont(descriptor: $0, size: size) } ?? base
    case .mono:
      if let font = UIFont(name: FontRegistry.monoName(weight), size: size) { return font }
      return UIFont.monospacedSystemFont(ofSize: size, weight: FontRegistry.uiWeight(weight))
    }
  }

  /// The point size for the current Dynamic Type setting.
  func scaledSize(for dynamicType: DynamicTypeSize) -> CGFloat {
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicType))
    return UIFontMetrics(forTextStyle: .body).scaledValue(for: spec.size, compatibleWith: traits)
  }

  func uiFont(size: CGFloat, weight: Int, system: Bool = false) -> UIFont {
    let fallback = Self.uiFont(family: spec.family, size: size, weight: weight)
    let name: String
    switch self {
    case .greeting: name = "AnthropicSerifVariable-TextLight"
    case .composerInput: name = "AnthropicSansVariable-TextLight"
    default: return fallback
    }
    if system { return fallback }
    guard let font = UIFont(name: name, size: size) else { return fallback }
    let cascade = spec.family == .serif
      ? [UIFontDescriptor(name: "NotoSerifCJKsc-Regular", size: size),
         UIFontDescriptor(name: CJKSerif.name(weight), size: size)]
      : [fallback.fontDescriptor]
    let descriptor = font.fontDescriptor.addingAttributes([
      UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): [0x77676874: weight],
      .cascadeList: cascade
    ])
    return UIFont(descriptor: descriptor, size: size)
  }

  func uiFont(for dynamicType: DynamicTypeSize = .large) -> UIFont {
    uiFont(size: scaledSize(for: dynamicType), weight: spec.weight)
  }
}

/// Apple's downloadable Simplified Chinese serif (Songti). iOS ships no CJK serif; the system
/// downloads these on request and keeps them for every app.
enum CJKSerif {
  static func name(_ weight: Int) -> String { weight >= 600 ? "STSongti-SC-Bold" : "STSongti-SC-Regular" }
  static func prefetch() {
    let descriptors = ["STSongti-SC-Regular", "STSongti-SC-Bold"].map {
      CTFontDescriptorCreateWithNameAndSize($0 as CFString, 0)
    } as CFArray
    CTFontDescriptorMatchFontDescriptorsWithProgressHandler(descriptors, nil) { _, _ in true }
  }
}

enum FontRegistry {
  /// Bundled open fonts (Claudex/Resources/Fonts, listed in Info.plist UIAppFonts).
  static func serifName(_ weight: Int) -> String {
    switch weight {
    case ..<450: "NotoSerif"
    case ..<525: "NotoSerif-Medium"
    case ..<650: "NotoSerif-SemiBold"
    default: "NotoSerif-Bold"
    }
  }
  static func monoName(_ weight: Int) -> String {
    switch weight {
    case ..<450: "JetBrainsMono-Regular"
    case ..<525: "JetBrainsMono-Regular_Medium"
    case ..<650: "JetBrainsMono-Regular_SemiBold"
    default: "JetBrainsMono-Regular_Bold"
    }
  }
  /// 550 (the official "x84.s()" weight) sits between medium and semibold.
  static func uiWeight(_ weight: Int) -> UIFont.Weight {
    switch weight {
    case ..<350: .light
    case ..<450: .regular
    case ..<525: .medium
    case ..<575: UIFont.Weight(rawValue: (UIFont.Weight.medium.rawValue + UIFont.Weight.semibold.rawValue) / 2)
    case ..<650: .semibold
    default: .bold
    }
  }
}

/// Applies a type style: font, Dynamic Type scaling and the official line height.
private struct UseSystemFontKey: EnvironmentKey {
  static let defaultValue = false
}
extension EnvironmentValues {
  /// Settings "System" uses the device font for the greeting and the composer.
  var useSystemFont: Bool {
    get { self[UseSystemFontKey.self] }
    set { self[UseSystemFontKey.self] = newValue }
  }
}

struct TypeStyleModifier: ViewModifier {
  let style: TypeStyle
  var weight: Int?
  @Environment(\.dynamicTypeSize) private var dynamicType
  @Environment(\.useSystemFont) private var useSystemFont
  func body(content: Content) -> some View {
    let spec = style.spec
    let size = style.scaledSize(for: dynamicType)
    let font = style.uiFont(size: size, weight: weight ?? spec.weight, system: useSystemFont)
    let extra = max(0, size * spec.lineHeight - font.lineHeight)
    content.font(Font(font)).lineSpacing(extra)
  }
}

extension View {
  /// `Text("…").typeStyle(.body)`; pass `weight` to override (e.g. the welcome title's 300).
  func typeStyle(_ style: TypeStyle, weight: Int? = nil) -> some View {
    modifier(TypeStyleModifier(style: style, weight: weight))
  }
}

extension Font {
  /// The style's font at the default content size (for places that cannot take a modifier,
  /// such as `AttributedString` runs). Prefer `.typeStyle(_:)`, which also scales.
  static func claude(_ style: TypeStyle) -> Font { Font(style.uiFont()) }
}
