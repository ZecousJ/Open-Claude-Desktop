import SwiftUI

/// The official text field: `bg300` fill, 15pt body, `text500` placeholder, 16pt padding. `shape` is a pill by
/// default; sign-in uses the 12pt shape.
struct ClaudeTextField<Trailing: View>: View {
  let placeholder: String
  @Binding var text: String
  var secure = false
  var shape: FieldShape = .pill
  /// Accessibility identifier placed on the text field itself (UI tests query it).
  var identifier: String?
  var focus: FocusState<Bool>.Binding?
  @ViewBuilder var trailing: () -> Trailing

  enum FieldShape { case pill, rounded }

  var body: some View {
    HStack(spacing: 8) {
      Group {
        if secure {
          SecureField(text: $text) { placeholderText }
        } else {
          TextField(text: $text, axis: .horizontal) { placeholderText }
        }
      }
      .typeStyle(.body).foregroundStyle(Palette.text100).tint(Palette.accentMain100)
      .frame(maxWidth: .infinity, minHeight: 22)
      .modifier(FieldIdentity(identifier: identifier, focus: focus))
      trailing()
    }
    .padding(.leading, 16).padding(.trailing, Trailing.self == EmptyView.self ? 16 : 8)
    .padding(.vertical, Trailing.self == EmptyView.self ? 16 : 8)
    .frame(minHeight: 54)
    .background(Palette.bg300, in: fieldShape)
  }
  private var placeholderText: Text { Text(placeholder).foregroundStyle(Palette.text500) }
  private var fieldShape: AnyShape {
    shape == .pill ? AnyShape(Capsule()) : AnyShape(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
  }
}

/// A settings row whose trailing end is a single-line field (the schedule's minute, time and cron expression):
/// the row's title, then the field right aligned in the Claude type, caret and placeholder colours. The
/// system's stepper and its blue caret are not Claude controls (Android's `SettingsTextField` in a tile).
struct SettingsFieldRow: View {
  let title: String
  let placeholder: String
  var keyboard: UIKeyboardType = .default
  var width: CGFloat = 120
  @Binding var text: String
  var identifier: String?
  var body: some View {
    SettingsRow(title: title) {
      TextField(text: $text) { Text(placeholder).foregroundStyle(Palette.text500) }
        .typeStyle(.bodyLarge).foregroundStyle(Palette.text100).tint(Palette.accentMain100)
        .multilineTextAlignment(.trailing).keyboardType(keyboard)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .frame(maxWidth: width).accessibilityIdentifier(identifier ?? "")
    }
  }
}

extension ClaudeTextField where Trailing == EmptyView {
  init(
    _ placeholder: String, text: Binding<String>, secure: Bool = false, shape: FieldShape = .pill,
    identifier: String? = nil, focus: FocusState<Bool>.Binding? = nil
  ) {
    self.placeholder = placeholder
    self._text = text
    self.secure = secure
    self.shape = shape
    self.identifier = identifier
    self.focus = focus
    self.trailing = { EmptyView() }
  }
}

private struct FieldIdentity: ViewModifier {
  let identifier: String?
  let focus: FocusState<Bool>.Binding?
  func body(content: Content) -> some View {
    let identified = content.accessibilityIdentifier(identifier ?? "")
    if let focus { identified.focused(focus) } else { identified }
  }
}

/// The search field: pill, `surfaceSunken` fill, 10 % hairline, muted icon.
struct SearchField: View {
  let prompt: String
  @Binding var text: String
  var focus: FocusState<Bool>.Binding?
  var body: some View {
    HStack(spacing: 8) {
      AppGlyphView(.search, size: 20).foregroundStyle(Palette.textTertiary)
      TextField(text: $text) { Text(prompt).foregroundStyle(Palette.textTertiary) }
        .typeStyle(.body).foregroundStyle(Palette.textPrimary).tint(Palette.accentMain100)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .submitLabel(.search)
        .modifier(FieldIdentity(identifier: "search-field", focus: focus))
      if !text.isEmpty {
        Button { text = "" } label: {
          AppGlyphView(.xCircleFilled, size: 20)
        }.buttonStyle(.plain).foregroundStyle(Palette.textTertiary)
          .accessibilityLabel(L("generic_search_clear"))
      }
    }
    .padding(.horizontal, 14).frame(minHeight: 44)
    .background(Palette.surfaceSunken, in: Capsule())
    .overlay(Capsule().strokeBorder(Palette.borderDefault, lineWidth: 1))
  }
}
