import SwiftUI

/// Corner radii. Points equal the official dp values.
enum Radius {
  static let r2: CGFloat = 2
  static let r4: CGFloat = 4
  static let r6: CGFloat = 6
  static let r7: CGFloat = 7
  /// Small containers, compact chips, subtle fills.
  static let r8: CGFloat = 8
  static let r9: CGFloat = 9
  /// Drawer rows.
  static let r10: CGFloat = 10
  /// Menu items, dialogs, cards, text fields on sign-in.
  static let r12: CGFloat = 12
  /// Error snackbar, model/option chips.
  static let r14: CGFloat = 14
  /// List / card rows (the most used shape).
  static let r16: CGFloat = 16
  static let r20: CGFloat = 20
  /// Large cards, composer-style containers.
  static let r24: CGFloat = 24
  /// Bottom-sheet top corners.
  static let sheet: CGFloat = 44
  /// Pill toast.
  static let r48: CGFloat = 48
}

/// Spacing scale: 2 · 4 · 6 · 8 · 10 · 12 · 16 · 20 · 24 · 32 · 48.
enum Spacing {
  static let xxs: CGFloat = 2
  static let xs: CGFloat = 4
  static let s6: CGFloat = 6
  static let s: CGFloat = 8
  static let s10: CGFloat = 10
  static let m: CGFloat = 12
  static let l: CGFloat = 16
  static let s20: CGFloat = 20
  static let xl: CGFloat = 24
  static let xxl: CGFloat = 32
  static let xxxl: CGFloat = 48
  /// List screens' horizontal gutter.
  static let listGutter: CGFloat = 16
  /// Bottom-sheet and sign-in horizontal gutter.
  static let sheetGutter: CGFloat = 24
  /// Readable max widths.
  static let buttonMaxWidth: CGFloat = 580
  static let dialogMaxWidth: CGFloat = 520
  static let snackbarMaxWidth: CGFloat = 400
}

/// Motion tokens.
enum Motion {
  /// `cds_motion_duration_base`.
  static let baseDuration: Double = 0.2
  /// `cds_ease_out` cubic-bezier(0.165, 0.84, 0.44, 1), 200 ms.
  static let easeOut = Animation.timingCurve(0.165, 0.84, 0.44, 1, duration: baseDuration)
  static func easeOut(_ duration: Double) -> Animation {
    .timingCurve(0.165, 0.84, 0.44, 1, duration: duration)
  }
  /// cubic-bezier(0.2, 0, 0, 1).
  static func emphasized(_ duration: Double = 0.3) -> Animation {
    .timingCurve(0.2, 0, 0, 1, duration: duration)
  }
  /// Material FastOutSlowIn (0.4, 0, 0.2, 1), 300 ms — sign-in screen transitions.
  static func standard(_ duration: Double = 0.3) -> Animation {
    .timingCurve(0.4, 0, 0.2, 1, duration: duration)
  }
  /// spring(dampingRatio 1, stiffness 400).
  static let spring = Animation.interpolatingSpring(mass: 1, stiffness: 400, damping: 40)
  /// spring(dampingRatio 0.5, stiffness 400) — bouncy pop.
  static let bouncy = Animation.interpolatingSpring(mass: 1, stiffness: 400, damping: 20)
  /// crossfade in (250 ms) / slow crossfade (400 ms).
  static let crossfade = Animation.timingCurve(0.4, 0, 0.2, 1, duration: 0.25)
  static let slowCrossfade = Animation.timingCurve(0.4, 0, 0.2, 1, duration: 0.4)
  /// Home greeting "HeadlineCrossfade" 300 ms.
  static let headlineCrossfade = Animation.timingCurve(0.4, 0, 0.2, 1, duration: 0.3)

  /// Returns nil when Reduce Motion is on, so `withAnimation(Motion.or(reduce, …))` skips it.
  static func unlessReduced(_ reduce: Bool, _ animation: Animation) -> Animation? {
    reduce ? nil : animation
  }
}

/// Drop shadows.
enum Shadow {
  struct Spec {
    let color: Color
    let radius: CGFloat
    let y: CGFloat
  }
  /// 4 blur, 8 %, y 2 — raised controls.
  static let small = Spec(color: .black.opacity(0.08), radius: 2, y: 2)
  /// 8 blur, 10 %, y 2 — floating panels.
  static let medium = Spec(color: .black.opacity(0.10), radius: 4, y: 2)
}

extension View {
  /// SwiftUI's shadow radius is about half the Compose blur, so specs store radius = blur / 2.
  func claudeShadow(_ spec: Shadow.Spec) -> some View {
    shadow(color: spec.color, radius: spec.radius, x: 0, y: spec.y)
  }
  /// The official dialog shadows (A: 8 blur 8 % y4; B: 28 blur −2 spread y12, 8 % light / 24 % dark).
  func dialogShadow(dark: Bool) -> some View {
    shadow(color: .black.opacity(0.08), radius: 4, x: 0, y: 4)
      .shadow(color: .black.opacity(dark ? 0.24 : 0.08), radius: 13, x: 0, y: 12)
  }
}
