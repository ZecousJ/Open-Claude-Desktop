import SwiftUI

/// The official switch: 52 × 32 pill track, white thumb (16 off, 24 on, 28 pressed), blue `accentBlue` track when on;
/// `switchTrackOff` + 2pt outline off. Applied app-wide at the root, so every `Toggle` uses it.
struct ClaudeToggleStyle: ToggleStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 12) {
      configuration.label.frame(maxWidth: .infinity, alignment: .leading)
      ClaudeSwitch(isOn: configuration.$isOn)
    }
  }
}

struct ClaudeSwitch: View {
  @Binding var isOn: Bool
  @Environment(\.isEnabled) private var enabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @GestureState private var pressed = false
  var body: some View {
    let thumb: CGFloat = pressed ? 28 : (isOn ? 24 : 16)
    ZStack(alignment: isOn ? .trailing : .leading) {
      Capsule().fill(isOn ? Palette.accentBlue : Palette.switchTrackOff)
        .overlay(Capsule().strokeBorder(isOn ? .clear : Palette.border300, lineWidth: 2))
      Circle().fill(Color.white).frame(width: thumb, height: thumb)
        .shadow(color: .black.opacity(0.08), radius: 1, y: 1)
        .padding(.horizontal, isOn ? 4 : (pressed ? 2 : 8))
    }
    .frame(width: 52, height: 32)
    .opacity(enabled ? 1 : 0.38)
    .frame(minWidth: 52, minHeight: 44)
    .contentShape(Rectangle())
    .gesture(
      DragGesture(minimumDistance: 0)
        .updating($pressed) { _, state, _ in state = true }
        .onEnded { _ in if enabled { isOn.toggle() } }
    )
    .animation(reduceMotion ? nil : Motion.spring, value: isOn)
    .animation(reduceMotion ? nil : Motion.spring, value: pressed)
    .accessibilityElement()
    .accessibilityAddTraits(.isButton)
    .accessibilityValue(isOn ? L("state_on") : L("state_off"))
    .accessibilityAction { if enabled { isOn.toggle() } }
  }
}

extension ToggleStyle where Self == ClaudeToggleStyle {
  static var claude: ClaudeToggleStyle { ClaudeToggleStyle() }
}

/// The official checkbox: 18pt, 5pt corners, blue fill when checked.
struct ClaudeCheckbox: View {
  @Binding var isOn: Bool
  var indeterminate = false
  @ScaledMetric(relativeTo: .body) private var side: CGFloat = 18
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    Button { isOn.toggle() } label: {
      ZStack {
        RoundedRectangle(cornerRadius: 5 * side / 18, style: .continuous)
          .fill(isOn ? Palette.accentBlue : .clear)
        RoundedRectangle(cornerRadius: 5 * side / 18, style: .continuous)
          .strokeBorder(isOn ? Palette.accentBlue : Palette.textTertiary, lineWidth: 1)
        if isOn {
          AppGlyphView(indeterminate ? .minus : .check, size: 16 * side / 18).foregroundStyle(Palette.checkGlyph)
            .transition(.scale(scale: 0.6).combined(with: .opacity))
        }
      }
      .frame(width: side, height: side).frame(width: 44, height: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .animation(reduceMotion ? nil : Motion.easeOut, value: isOn)
    .accessibilityAddTraits(isOn ? .isSelected : [])
  }
}

/// Selectable chip. `.option` = model/option chip (14pt corners, 15pt strong label); `.compact` = 8pt corners. Both
/// draw a 0.5pt `border300` outline.
struct ClaudeChip: View {
  enum Kind { case option, compact, filter }
  let title: String
  var icon: AppGlyph?
  var selected = false
  var kind: Kind = .filter
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if let icon { AppGlyphView(icon, size: 20) }
        Text(title).typeStyle(kind == .option ? .bodyStrong : .body).lineLimit(1)
      }
      .foregroundStyle(selected ? Palette.text100 : Palette.text300)
      .padding(.horizontal, kind == .compact ? 12 : 10).padding(.vertical, kind == .compact ? 12 : 8)
      .frame(minHeight: 36)
      .background(selected ? Palette.bg300 : Palette.bg100, in: shape)
      .overlay(shape.stroke(selected ? Palette.border100 : Palette.border300, lineWidth: 0.5))
      .contentShape(shape)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
  private var shape: RoundedRectangle {
    RoundedRectangle(
      cornerRadius: kind == .option ? Radius.r14 : kind == .compact ? Radius.r8 : 18, style: .continuous)
  }
}

/// "New" badge: pill, `text100` @10 % fill, `accentMain100` 13pt strong text.
struct NewBadge: View {
  var body: some View {
    Text(L("nav_drawer_badge_new")).typeStyle(.captionStrong).foregroundStyle(Palette.accentMain100)
      .padding(.horizontal, 8).padding(.vertical, 2)
      .background(Palette.text100.opacity(0.10), in: Capsule())
  }
}

/// Menus are the native iOS menu (system-level control). Items use the official text and icon:
///
///     Menu { MenuItem(L("chat_rename"), icon: .edit) { … } } label: { … }
///
/// A selected item shows the official trailing check.
struct MenuItem: View {
  let title: String
  var icon: AppGlyph?
  var selected = false
  var destructive = false
  let action: () -> Void
  init(_ title: String, icon: AppGlyph? = nil, selected: Bool = false, destructive: Bool = false, action: @escaping () -> Void) {
    self.title = title
    self.icon = icon
    self.selected = selected
    self.destructive = destructive
    self.action = action
  }
  var body: some View {
    Button(role: destructive ? .destructive : nil, action: action) {
      if selected {
        Label(title, systemImage: AppGlyph.check.symbol)
      } else if let icon {
        Label(title, systemImage: icon.symbol)
      } else {
        Text(title)
      }
    }
  }
}
