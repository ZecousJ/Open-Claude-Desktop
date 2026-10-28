import SwiftUI
import UIKit

/// Colour tokens, light and dark.
///
/// Names follow the web front end's CSS names (`bg100`, `text100`, `accentMain100` …); the "Cds" layer is named by
/// its role.
/// Every token is a dynamic colour, so `.preferredColorScheme` and the system setting both apply.
enum Palette {
  // MARK: Core tokens

  /// Claude clay. Used for brand accents and `claudeClay` link spans in copy.
  static let accentBrand = Color(0xD97757)
  static let clay = Color(0xD97757)
  static let accentMain000 = Color(0xC6613F)
  /// M3 primary; default spinner colour; "New" badge text; feature dot.
  static let accentMain100 = Color(light: 0xC6613F, dark: 0xD97757)
  static let accentMain200 = Color(0xD97757)
  static let accentPro000 = Color(light: 0x4A3AA7, dark: 0xBFB9F5)
  static let accentPro100 = Color(light: 0x7161E0, dark: 0x9085E9)
  static let accentPro200 = Color(light: 0x7161E0, dark: 0x8173E3)
  static let accentPro900 = Color(light: 0xDFDBFD, dark: 0x271E60)
  static let accentSecondary000 = Color(light: 0x184F95, dark: 0x9EC5F4)
  /// Tinted button text; "Change email address" link.
  static let accentSecondary100 = Color(light: 0x256ABF, dark: 0x5598E7)
  static let accentSecondary200 = Color(light: 0x256ABF, dark: 0x5598E7)
  static let accentSecondary900 = Color(light: 0xCDE2FB, dark: 0x062B57)

  /// Raised surfaces: cards, error snackbar, inputs (M3 surface).
  static let bg000 = Color(light: 0xFFFFFF, dark: 0x20201F)
  /// Page / window background and bottom-sheet container (M3 background).
  static let bg100 = Color(light: 0xF9F9F7, dark: 0x151515)
  /// Navigation drawer background.
  static let bg200 = Color(light: 0xF3F3F0, dark: 0x111111)
  /// Secondary container; pressed Secondary button; default text-field fill.
  static let bg300 = Color(light: 0xF0EFEC, dark: 0x0D0D0D)
  static let bg400 = Color(light: 0xE7E6E1, dark: 0x0B0B0B)
  static let bg500 = Color(light: 0xE7E6E1, dark: 0x0B0B0B)

  static let border100 = Color(light: 0x1E1E1D, lightAlpha: 0.40, dark: 0xE1E0D9, darkAlpha: 0.40)
  /// Spinner track, snackbar hairline.
  static let border200 = Color(light: 0x1E1E1D, lightAlpha: 0.30, dark: 0xE1E0D9, darkAlpha: 0.30)
  /// Default hairline, sheet grabber, chip border (M3 outline).
  static let border300 = Color(light: 0x1E1E1D, lightAlpha: 0.15, dark: 0xE1E0D9, darkAlpha: 0.15)
  static let border400 = Color(light: 0x1E1E1D, lightAlpha: 0.15, dark: 0xE1E0D9, darkAlpha: 0.15)

  static let danger000 = Color(light: 0x8E2626, dark: 0xF4ABAB)
  static let danger100 = Color(light: 0xD03B3B, dark: 0xE66767)
  static let danger200 = Color(light: 0xD03B3B, dark: 0xE34948)
  static let danger900 = Color(light: 0xFAD6D6, dark: 0x511212)
  static let success000 = Color(light: 0x006300, dark: 0x91D68B)
  static let success100 = Color(light: 0x009300, dark: 0x0CA30C)
  static let success200 = Color(light: 0x009300, dark: 0x0CA30C)
  static let success900 = Color(light: 0xCAEAC7, dark: 0x0F350D)

  static let oncolor100 = Color(0xFFFFFF)
  /// Disabled label on Primary / Brand / Destructive buttons.
  static let oncolor200 = Color(0xF9F9F7, alpha: 0.75)
  static let oncolor300 = Color(0xF9F9F7, alpha: 0.50)

  /// Primary text (M3 onBackground / onSurface).
  static let text100 = Color(light: 0x131313, dark: 0xF9F9F7)
  /// Secondary text; drawer content colour.
  static let text300 = Color(light: 0x383835, dark: 0xC3C2B7)
  /// Tertiary text: placeholders, menu icons, section headers, legal copy.
  static let text500 = Color(light: 0x7B7974, dark: 0x97958D)

  // MARK: Extra core fields

  static let warning = Color(light: 0xA66A00, dark: 0xB77700)
  static let warningBackground = Color(light: 0xF9DCA4, dark: 0x412400)
  static let codeSurface = Color(light: 0xF0EFEC, dark: 0x2C2C2A)
  /// Clickable tile fill.
  static let tileFill = Color(light: 0xF0EFEC, dark: 0xFFFFFF, darkAlpha: 0.08)
  static let tileFillSubtle = Color(light: 0xF0EFEC, dark: 0xFFFFFF, darkAlpha: 0.05)
  static let noticeFill = Color(light: 0xF9F9F7, dark: 0xFFFFFF, darkAlpha: 0.10)
  static let noticeBorder = Color(light: 0x1E1E1D, lightAlpha: 0.15, dark: 0x000000, darkAlpha: 0)
  /// 2pt left bar of quote-like blocks.
  static let quoteBar = Color(light: 0x0B0B0B, lightAlpha: 0.10, dark: 0xFFFFFF, darkAlpha: 0.10)
  static let switchTrackOff = Color(light: 0x0B0B0B, lightAlpha: 0.20, dark: 0xFFFFFF, darkAlpha: 0.10)
  /// Selected drawer row.
  static let drawerSelected = Color(light: 0xF0EFEC, dark: 0xFFFFFF, darkAlpha: 0.20)
  static let pillToastFill = Color(light: 0xF3F3F0, dark: 0xFFFFFF, darkAlpha: 0.10)
  static let pillToastBorder = Color(light: 0x1E1E1D, lightAlpha: 0.30, dark: 0x000000, darkAlpha: 0)
  /// Subtle container fill — second most used surface.
  static let subtleFill = Color(light: 0xFCFCFB, dark: 0xFFFFFF, darkAlpha: 0.10)

  // MARK: Cds tokens

  static let textPrimary = Color(light: 0x0B0B0B, dark: 0xF0EFEC)
  static let textSecondary = Color(light: 0x52514E, dark: 0xC3C2B7)
  static let textTertiary = Color(0x898781)
  static let link = Color(light: 0x184F95, dark: 0x6DA7EC)
  /// 10 % hairline: dialogs, card rows, search field.
  static let borderDefault = Color(light: 0x0B0B0B, lightAlpha: 0.102, dark: 0xFFFFFF, darkAlpha: 0.102)
  static let borderStrong = Color(light: 0x0B0B0B, lightAlpha: 0.349, dark: 0xFFFFFF, darkAlpha: 0.349)
  static let dangerText = Color(light: 0x8E2626, dark: 0xEC7E7E)
  static let successText = Color(light: 0x006300, dark: 0x0CA30C)
  static let warningText = Color(light: 0x734500, dark: 0xDB9300)
  /// 5 % fill: pressed rows, chips.
  static let fillSubtle = Color(light: 0x0B0B0B, lightAlpha: 0.051, dark: 0xFFFFFF, darkAlpha: 0.051)
  static let fill10 = Color(light: 0x0B0B0B, lightAlpha: 0.102, dark: 0xFFFFFF, darkAlpha: 0.102)
  static let fill20 = Color(light: 0x0B0B0B, lightAlpha: 0.200, dark: 0xFFFFFF, darkAlpha: 0.200)
  static let fill40 = Color(light: 0x0B0B0B, lightAlpha: 0.400, dark: 0xFFFFFF, darkAlpha: 0.400)
  static let surfaceSunken = Color(light: 0xF9F9F7, dark: 0x0B0B0B)
  static let surfaceSecondary = Color(light: 0xFCFCFB, dark: 0x151515)
  static let surfaceRaised = Color(light: 0xFFFFFF, dark: 0x1A1A19)
  static let surface = Color(light: 0xFFFFFF, dark: 0x20201F)
  static let dialogSurface = Color(light: 0xFFFFFF, dark: 0x20201F)
  /// Switch "on" track and checkbox fill (same in both themes).
  static let accentBlue = Color(0x2A78D6)
  static let accentBlueTint = Color(0x2A78D6, alpha: 0.102)
  static let successSolid = Color(0x009300)

  // Button fills
  static let primaryFill = Color(light: 0x0B0B0B, dark: 0xFFFFFF)
  static let primaryFillPressed = Color(light: 0x2C2C2A, dark: 0xE1E0D9)
  static let primaryContent = Color(light: 0xFFFFFF, dark: 0x0B0B0B)
  static let brandFill = Color(0xC6613F)
  static let brandFillPressed = Color(0xD97757)
  static let onBrand = Color(0xFFFFFF)
  static let destructiveFill = Color(0xD03B3B)
  static let destructiveFillPressed = Color(0xE34948)
  static let disabledFill = Color(light: 0x9C9A92, dark: 0x5E5D59)
  static let disabledContent = Color(0x87867F)
  static let borderlessPressed = Color(light: 0x0B0B0B, lightAlpha: 0.051, dark: 0xFFFFFF, darkAlpha: 0.075)
  static let checkGlyph = Color(0xFFFFFF)

  /// Dialog window dim: black at 40 % light / 50 % dark.
  static let dialogScrim = Color(light: 0x000000, lightAlpha: 0.40, dark: 0x000000, darkAlpha: 0.50)
  /// Drawer and bottom-sheet scrim: Material black at 32 %.
  static let scrim = Color(0x000000, alpha: 0.32)

  // MARK: Hue tables

  enum Hue: CaseIterable { case gray, red, orange, yellow, green, teal, blue, purple, pink }

  /// Category accent.
  static func category(_ hue: Hue) -> Color {
    switch hue {
    case .gray: Color(light: 0x7B7974, dark: 0x97958D)
    case .red: Color(light: 0xD03B3B, dark: 0xE66767)
    case .orange: Color(light: 0xC25124, dark: 0xEB6834)
    case .yellow: Color(light: 0xA66A00, dark: 0xC98500)
    case .green: Color(light: 0x009300, dark: 0x35B231)
    case .teal: Color(light: 0x138E65, dark: 0x1BAF7A)
    case .blue: Color(light: 0x2A78D6, dark: 0x5598E7)
    case .purple: Color(light: 0x7161E0, dark: 0x9085E9)
    case .pink: Color(light: 0xC04873, dark: 0xE46191)
    }
  }
  /// Category "text-on-tint" strength.
  static func categoryText(_ hue: Hue) -> Color {
    switch hue {
    case .gray: Color(light: 0x52514E, dark: 0x898781)
    case .red: Color(light: 0x8E2626, dark: 0xE34948)
    case .orange: Color(light: 0x863311, dark: 0xD95926)
    case .yellow: Color(light: 0x734500, dark: 0xB77700)
    case .green: Color(light: 0x006300, dark: 0x0CA30C)
    case .teal: Color(light: 0x065F49, dark: 0x199E70)
    case .blue: Color(light: 0x184F95, dark: 0x3987E5)
    case .purple: Color(light: 0x4A3AA7, dark: 0x8173E3)
    case .pink: Color(light: 0x862A4C, dark: 0xD55181)
    }
  }
  struct FileCardTint {
    let face: Color
    let page: Color
    let pageBorder: Color
    let icon: Color
  }
  /// `CdsFileCardTintColors` (gray has none in the official table; it falls back to blue).
  static func fileCard(_ hue: Hue) -> FileCardTint {
    func tint(_ l: (UInt32, UInt32, UInt32, UInt32), _ d: (UInt32, UInt32, UInt32, UInt32)) -> FileCardTint {
      FileCardTint(
        face: Color(light: l.0, lightAlpha: 0.10, dark: d.0, darkAlpha: 0.15),
        page: Color(light: l.1, dark: d.0), pageBorder: Color(light: l.2, dark: d.1),
        icon: Color(light: l.3, dark: d.2))
    }
    switch hue {
    case .red: return tint((0xFFFBFB, 0xFBEBEB, 0xF4ABAB, 0x8E2626), (0x3C0E0E, 0x641919, 0xEC7E7E, 0))
    case .orange: return tint((0xFEFBFA, 0xF9ECE7, 0xF4AE94, 0x863311), (0x371407, 0x5D230B, 0xEC835A, 0))
    case .yellow: return tint((0xFEFCF8, 0xF9EEDA, 0xFAB219, 0x734500), (0x311A00, 0x512E00, 0xDB9300, 0))
    case .green: return tint((0xFAFDFA, 0xE5F4E4, 0x91D68B, 0x006300), (0x11260F, 0x074506, 0x55BF50, 0))
    case .teal: return tint((0xF9FDFB, 0xE2F4ED, 0x7AD7B4, 0x065F49), (0x022720, 0x034235, 0x3BBD8C, 0))
    case .purple: return tint((0xFCFBFF, 0xEFEDFF, 0xBFB9F5, 0x4A3AA7), (0x1D1649, 0x322777, 0xA096EB, 0))
    case .pink: return tint((0xFEFBFC, 0xFAEBF0, 0xF3A8C3, 0x862A4C), (0x390F1F, 0x5E1C34, 0xE87BA4, 0))
    case .blue, .gray: return tint((0xFAFCFF, 0xE7F1FB, 0x9EC5F4, 0x184F95), (0x032042, 0x0D366B, 0x6DA7EC, 0))
    }
  }
}

extension Color {
  /// An opaque sRGB colour from `0xRRGGBB`.
  init(_ hex: UInt32, alpha: Double = 1) {
    self.init(uiColor: UIColor(hex: hex, alpha: alpha))
  }
  /// A dynamic colour that follows the light / dark interface style.
  init(light: UInt32, lightAlpha: Double = 1, dark: UInt32, darkAlpha: Double = 1) {
    self.init(
      uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
          ? UIColor(hex: dark, alpha: darkAlpha) : UIColor(hex: light, alpha: lightAlpha)
      })
  }
}

extension UIColor {
  convenience init(hex: UInt32, alpha: Double = 1) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
  }
}
