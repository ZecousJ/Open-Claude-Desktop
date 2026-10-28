import SwiftUI

/// The official Claude button: a pill with Resting / Active (pressed) / Disabled states, five sizes and seven
/// variants.
///
/// Button(L("generic_button_continue")) { … }.claudeButton(.primary, size: .large, fullWidth: true) Button { … }
/// label: { Label("新对话", systemImage: "plus") }.claudeButton(.secondary, size: .small) Button { … } label: {
/// AppGlyphView(.x) }.claudeButton(.borderless, iconOnly: true)
enum ClaudeButtonVariant {
  case primary, brand, destructive, secondary, tinted, borderless, noticeCta
}

enum ClaudeButtonSize {
  case small, medium, mediumLarge, large, cardAnswer
  /// Visual height.
  var height: CGFloat {
    switch self {
    case .small: 36
    case .medium: 40
    case .mediumLarge, .cardAnswer: 44
    case .large: 48
    }
  }
  /// Minimum touch target (raised to 44, the iOS minimum, for the small sizes).
  var touchTarget: CGFloat { self == .small || self == .medium ? 44 : 48 }
  var iconSize: CGFloat { self == .small ? 20 : 24 }
  var label: TypeStyle { self == .small || self == .cardAnswer ? .bodyStrong : .bodyLargeStrong }
}

struct ClaudeButtonStyle: ButtonStyle {
  var variant: ClaudeButtonVariant = .primary
  var size: ClaudeButtonSize = .medium
  var fullWidth = false
  var iconOnly = false
  @Environment(\.isEnabled) private var enabled
  @Environment(\.colorScheme) private var scheme
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

  func makeBody(configuration: Configuration) -> some View {
    let pressed = configuration.isPressed
    let height = size.height * scale
    configuration.label
      .typeStyle(size.label)
      .lineLimit(1)
      .labelStyle(ClaudeButtonLabelStyle(iconSize: size.iconSize))
      .foregroundStyle(content(pressed: pressed))
      .padding(.horizontal, iconOnly ? 0 : 12)
      .frame(minWidth: iconOnly ? height : nil, maxWidth: fullWidth ? Spacing.buttonMaxWidth : nil)
      .frame(width: iconOnly ? height : nil, height: height)
      .background(container(pressed: pressed), in: Capsule())
      .overlay {
        if let border { Capsule().strokeBorder(border, lineWidth: 1) }
      }
      .frame(minHeight: size.touchTarget)
      .contentShape(Rectangle())
      .animation(Motion.easeOut, value: pressed)
      .animation(Motion.easeOut, value: enabled)
  }

  private func container(pressed: Bool) -> Color {
    switch variant {
    case .primary: !enabled ? Palette.disabledFill : pressed ? Palette.primaryFillPressed : Palette.primaryFill
    case .brand: !enabled ? Palette.disabledFill : pressed ? Palette.brandFillPressed : Palette.brandFill
    case .destructive:
      !enabled ? Palette.disabledFill : pressed ? Palette.destructiveFillPressed : Palette.destructiveFill
    case .secondary, .tinted: enabled && pressed ? Palette.bg300 : .clear
    case .borderless: enabled && pressed ? Palette.borderlessPressed : .clear
    case .noticeCta:
      enabled && pressed ? (scheme == .dark ? Palette.quoteBar : Palette.bg300) : Palette.noticeFill
    }
  }
  private var border: Color? {
    switch variant {
    case .secondary, .tinted: Palette.border300
    case .noticeCta: Palette.noticeBorder
    default: nil
    }
  }
  private func content(pressed: Bool) -> Color {
    switch variant {
    case .primary: enabled ? Palette.primaryContent : Palette.oncolor200
    case .brand: enabled ? Palette.onBrand : Palette.oncolor200
    case .destructive: enabled ? Palette.oncolor100 : Palette.oncolor200
    case .secondary, .noticeCta: enabled ? Palette.text100 : Palette.disabledContent
    case .tinted: enabled ? Palette.accentSecondary100 : Palette.accentSecondary900
    case .borderless: enabled ? Palette.text100 : Palette.text100.opacity(0.38)
    }
  }
}

/// Icon then label with the official 4pt gap.
struct ClaudeButtonLabelStyle: LabelStyle {
  var iconSize: CGFloat = 24
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 4) {
      configuration.icon.font(.system(size: iconSize * 0.72)).frame(width: iconSize, height: iconSize)
      configuration.title
    }
  }
}

extension View {
  func claudeButton(
    _ variant: ClaudeButtonVariant = .primary, size: ClaudeButtonSize = .medium, fullWidth: Bool = false,
    iconOnly: Bool = false
  ) -> some View {
    buttonStyle(ClaudeButtonStyle(variant: variant, size: size, fullWidth: fullWidth, iconOnly: iconOnly))
  }
}

/// A 44pt round icon button (M3 IconButton, 48dp touch → iOS 44pt), tinted with `text100`.
struct ClaudeIconButton: View {
  let icon: AppGlyph
  let label: String
  var tint: Color = Palette.text100
  var size: CGFloat = 24
  let action: () -> Void
  init(_ icon: AppGlyph, label: String, tint: Color = Palette.text100, size: CGFloat = 24, action: @escaping () -> Void) {
    self.icon = icon
    self.label = label
    self.tint = tint
    self.size = size
    self.action = action
  }
  var body: some View {
    Button(action: action) {
      AppGlyphView(icon, size: size).frame(width: 44, height: 44).contentShape(Circle())
    }.buttonStyle(IconPressStyle()).foregroundStyle(tint).accessibilityLabel(label)
  }
}

/// Pressed feedback for icon buttons: the borderless 5 % fill in a circle.
struct IconPressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.background(
      configuration.isPressed ? Palette.borderlessPressed : .clear, in: Circle())
  }
}

/// Text-only link button used for "Change email address".
struct ClaudeLinkButton: View {
  let title: String
  var style: TypeStyle = .captionStrong
  let action: () -> Void
  var body: some View {
    Button(action: action) { Text(title).typeStyle(style) }
      .buttonStyle(.plain).foregroundStyle(Palette.accentSecondary100).frame(minHeight: 44)
  }
}
