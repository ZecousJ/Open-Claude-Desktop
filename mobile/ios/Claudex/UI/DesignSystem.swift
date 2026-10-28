import SwiftUI

// Compatibility layer. Screens written before the official redo (2026-10-12) use `Brand` and the
// helpers below; they now draw with the official tokens (Theme/Palette.swift, Typography.swift)
// and components (Components/), so every existing screen picks up the new theme. New code should
// use `Palette`, `.typeStyle(_:)` and the `Claude*` components directly.

enum Brand {
  /// Claude clay — the only decorative accent.
  static let accent = Palette.accentBrand
  static let ink = Palette.text100
  /// Page background (`bg100`).
  static let canvas = Palette.bg100
  /// Raised surface (`bg000`).
  static let surface = Palette.bg000
  /// 5 % fill.
  static let subtle = Palette.fillSubtle
  /// Hairline (`border300`).
  static let line = Palette.border300
  static func editorial(_ size: CGFloat) -> Font {
    Font(TypeStyle.uiFont(family: .serif, size: size, weight: 400))
  }
}
/// Serif display type that scales with Dynamic Type.
struct EditorialStyle: ViewModifier {
  @ScaledMetric(relativeTo: .title) private var pointSize: CGFloat = 29
  init(_ size: CGFloat) { _pointSize = ScaledMetric(wrappedValue: size, relativeTo: .title) }
  func body(content: Content) -> some View {
    content.font(Font(TypeStyle.uiFont(family: .serif, size: pointSize, weight: 400)))
  }
}
struct Surface: ViewModifier {
  func body(content: Content) -> some View {
    content.padding(16)
      .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: Radius.r16, style: .continuous).strokeBorder(Palette.borderDefault, lineWidth: 1))
  }
}
extension View {
  func editorialFont(_ size: CGFloat) -> some View { modifier(EditorialStyle(size)) }
  func cardSurface() -> some View { modifier(Surface()) }
  /// Small controls only. Text, documents and settings always have opaque surfaces.
  @ViewBuilder func floatingGlass() -> some View {
    if #available(iOS 26.0, *) {
      self.glassEffect(.regular, in: .rect(cornerRadius: 24))
    } else {
      self.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
    }
  }
  /// The official Primary button, Large.
  func primaryAction() -> some View { claudeButton(.primary, size: .large) }
  /// A field on the official text-field fill (12pt shape).
  func quietField() -> some View {
    typeStyle(.body).padding(16)
      .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
  }
  /// The top bar's navigation slot: the official menu button that opens the drawer.
  func sidebarToolbar() -> some View {
    toolbar { ToolbarItem(placement: .topBarLeading) { SidebarButton() } }
      .toolbarBackground(Palette.bg100, for: .navigationBar)
  }
}
/// The top bar's MENU slot (`menu` icon, "Open menu").
struct SidebarButton: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    Button {
      withAnimation(reduceMotion ? nil : Motion.spring) { store.sidebarPresented = true }
    } label: {
      AppGlyphView(.menu).frame(width: 44, height: 44).contentShape(Rectangle())
    }.foregroundStyle(Palette.text100)
      .accessibilityLabel(L("generic_button_open_menu")).accessibilityIdentifier("open-sidebar")
  }
}
/// Screen title in the official serif (28/500) with an optional secondary line.
struct ScreenHeading: View {
  let title: String
  var subtitle: String = ""
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).typeStyle(.screenTitle).foregroundStyle(Palette.text100)
      if !subtitle.isEmpty { Text(subtitle).typeStyle(.body).foregroundStyle(Palette.text500) }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}
/// Legacy row API (SF Symbol name) drawn as the official list row.
struct GroupRow: View {
  let title: String
  var detail: String = ""
  var icon: String = ""
  var chevron = true
  var body: some View {
    HStack(spacing: 12) {
      if !icon.isEmpty {
        Image(systemName: icon).font(.system(size: 19, weight: .regular)).frame(width: 24, height: 24)
          .foregroundStyle(Palette.textSecondary)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(title).typeStyle(.body).foregroundStyle(Palette.textPrimary)
        if !detail.isEmpty { Text(detail).typeStyle(.caption).foregroundStyle(Palette.text500) }
      }
      Spacer(minLength: 8)
      if chevron { AppGlyphView(.caretRight, size: 20).foregroundStyle(Palette.textTertiary) }
    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .padding(.vertical, 6).contentShape(Rectangle())
  }
}
/// Empty state: muted icon, short title and the official 15pt `text500` message.
struct EmptyPanel: View {
  let title: String
  let message: String
  var icon = "tray"
  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: icon).font(.system(size: 28, weight: .regular)).foregroundStyle(Palette.textTertiary)
        .accessibilityHidden(true)
      Text(title).typeStyle(.bodyLargeStrong).foregroundStyle(Palette.text100)
      Text(message).typeStyle(.body).foregroundStyle(Palette.text500).multilineTextAlignment(.center)
    }.frame(maxWidth: .infinity).padding(.vertical, 36).padding(.horizontal, 24)
  }
}
/// Neutral notice card (`bg300`, 12pt corners) — the official sign-in notice style.
struct InlineNotice: View {
  let text: String
  var tone: Tone = .neutral
  enum Tone { case neutral, error }
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      AppGlyphView(tone == .error ? .warningCircle : .infoCircle, size: 20)
      Text(text).typeStyle(.body).fixedSize(horizontal: false, vertical: true)
    }
    .foregroundStyle(tone == .error ? Palette.danger000 : Palette.text300)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .background(
      tone == .error ? Palette.danger900 : Palette.bg300,
      in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
  }
}
