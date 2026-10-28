import SwiftUI

/// Section header: 15pt strong, `text500`, one line (drawer "Pinned"/"Recents", list groups).
struct SectionHeader: View {
  let title: String
  var body: some View {
    Text(title).typeStyle(.bodyStrong).foregroundStyle(Palette.text500).lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, Spacing.l).padding(.vertical, Spacing.s)
      .accessibilityAddTraits(.isHeader)
  }
}

/// Hairline divider in `border300` with the drawer/list insets (16 h, 8 v).
struct ClaudeDivider: View {
  var horizontal: CGFloat = 16
  var vertical: CGFloat = 8
  var body: some View {
    Rectangle().fill(Palette.border300).frame(height: 1 / UIScreen.main.scale)
      .padding(.horizontal, horizontal).padding(.vertical, vertical)
  }
}

/// Card row: 16pt corners, 1pt `borderDefault`, min 62pt, 16 × 12 padding, title 15pt `textPrimary`; optional status
/// and trailing slot.
struct CardRow<Trailing: View>: View {
  let title: String
  var subtitle: String?
  var status: String?
  @ViewBuilder var trailing: () -> Trailing
  var body: some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 8) {
          Text(title).typeStyle(.body).foregroundStyle(Palette.textPrimary).lineLimit(1)
          if let status { Text(status).typeStyle(.caption).foregroundStyle(Palette.textSecondary).lineLimit(1) }
        }
        if let subtitle { Text(subtitle).typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(2) }
      }.frame(maxWidth: .infinity, alignment: .leading)
      trailing()
    }
    .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 62)
    .background(Palette.bg000.opacity(0.0001))
    .clipShape(RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r16, style: .continuous).strokeBorder(Palette.borderDefault, lineWidth: 1))
    .contentShape(RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
  }
}

extension CardRow where Trailing == EmptyView {
  init(title: String, subtitle: String? = nil, status: String? = nil) {
    self.title = title
    self.subtitle = subtitle
    self.status = status
    self.trailing = { EmptyView() }
  }
}

/// Settings-style row: 24pt leading icon, title, optional subtitle, trailing chevron or custom slot. Use inside
/// `GroupCard` for the grouped settings look.
struct ListRow<Trailing: View>: View {
  var icon: AppGlyph?
  let title: String
  var subtitle: String?
  var destructive = false
  @ViewBuilder var trailing: () -> Trailing
  var body: some View {
    HStack(spacing: 12) {
      if let icon {
        AppGlyphView(icon).foregroundStyle(destructive ? Palette.dangerText : Palette.textSecondary)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(title).typeStyle(.body).foregroundStyle(destructive ? Palette.dangerText : Palette.textPrimary)
        if let subtitle, !subtitle.isEmpty {
          Text(subtitle).typeStyle(.caption).foregroundStyle(Palette.text500)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
      trailing()
    }
    .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 52)
    .contentShape(Rectangle())
  }
}

extension ListRow where Trailing == AnyView {
  /// A navigation row with the trailing caret.
  init(icon: AppGlyph? = nil, title: String, subtitle: String? = nil, chevron: Bool = true, destructive: Bool = false) {
    self.icon = icon
    self.title = title
    self.subtitle = subtitle
    self.destructive = destructive
    self.trailing = {
      AnyView(
        Group {
          if chevron { AppGlyphView(.caretRight, size: 20, small: false).foregroundStyle(Palette.textTertiary) }
        })
    }
  }
}

/// A rounded group of rows on the page background (16pt corners, `bg000`, hairline between rows
/// is added by the caller with `ClaudeDivider(horizontal: 16, vertical: 0)`).
struct GroupCard<Content: View>: View {
  @ViewBuilder var content: () -> Content
  var body: some View {
    VStack(spacing: 0) { content() }
      .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Radius.r16, style: .continuous).strokeBorder(Palette.borderDefault, lineWidth: 1))
  }
}

/// Sheet option row: 20 × 12 padding, 12pt gap, icon `textSecondary`, label 15pt `textPrimary`.
struct SheetActionRow: View {
  let icon: AppGlyph?
  let title: String
  var destructive = false
  let action: () -> Void
  init(_ title: String, icon: AppGlyph? = nil, destructive: Bool = false, action: @escaping () -> Void) {
    self.title = title
    self.icon = icon
    self.destructive = destructive
    self.action = action
  }
  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        if let icon {
          AppGlyphView(icon).foregroundStyle(destructive ? Palette.dangerText : Palette.textSecondary)
        }
        Text(title).typeStyle(.body).foregroundStyle(destructive ? Palette.dangerText : Palette.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(.horizontal, 20).padding(.vertical, 12).frame(minHeight: 48).contentShape(Rectangle())
    }.buttonStyle(RowPressStyle())
  }
}

/// Pressed rows show the 5 % fill.
struct RowPressStyle: ButtonStyle {
  var radius: CGFloat = 0
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.background(
      configuration.isPressed ? Palette.fillSubtle : .clear,
      in: RoundedRectangle(cornerRadius: radius, style: .continuous))
  }
}
