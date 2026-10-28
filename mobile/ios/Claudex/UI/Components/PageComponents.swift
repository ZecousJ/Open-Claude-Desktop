import SwiftUI

// Building blocks for the list and settings pages. Settings rows are iOS-style inset groups drawn the official way:
// each row is its own `bg000` tile with 2pt corners, rows are 2pt apart (the page shows through), and the group's
// outer corners are 16pt. No hairlines between rows.

// MARK: Page scaffold

/// A pushed page: `bg100` background, the top-bar title in the official style. `serif` = settings sub-screens;
/// otherwise the list title.
struct PageTitle: ViewModifier {
  let title: String
  var serif = true
  var subtitle: String?
  func body(content: Content) -> some View {
    content
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(Palette.bg100, for: .navigationBar)
      .toolbar {
        ToolbarItem(placement: .principal) {
          VStack(spacing: 0) {
            Text(title).typeStyle(serif ? .serifTitle : .bodyLargeStrong).foregroundStyle(Palette.text100)
              .lineLimit(1)
            if let subtitle {
              Text(subtitle).typeStyle(.body).foregroundStyle(Palette.text100).lineLimit(1)
                .transition(.opacity)
            }
          }.accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
        }
      }
  }
}

extension View {
  func pageTitle(_ title: String, serif: Bool = true, subtitle: String? = nil) -> some View {
    modifier(PageTitle(title: title, serif: serif, subtitle: subtitle))
  }
}

/// The settings sub-screen body: a scrolling column with 12pt above, between and below groups.
struct SettingsPage<Content: View>: View {
  let title: String
  @ViewBuilder var content: () -> Content
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) { content() }
        .padding(.vertical, 12)
        .frame(maxWidth: Spacing.buttonMaxWidth)
        .frame(maxWidth: .infinity)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(title)
  }
}

// MARK: Groups and rows

/// The settings group with its optional section header.
struct SettingsGroup<Content: View>: View {
  var header: String?
  @ViewBuilder var content: () -> Content
  init(_ header: String? = nil, @ViewBuilder content: @escaping () -> Content) {
    self.header = header
    self.content = content
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let header {
        Text(header).typeStyle(.body).foregroundStyle(Palette.text300)
          .padding(.horizontal, 24).padding(.bottom, 8)
          .accessibilityAddTraits(.isHeader)
      }
      VStack(spacing: 2) { content() }
        .clipShape(RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
        .padding(.horizontal, 12)
    }
  }
}

/// The navigation row: `bg000` tile, 12/8/16/8 padding, min 56pt, 24pt icon, 10pt gap, 17pt title (2 lines), 15pt
/// `text500` subtitle (1 line). No chevron.
struct SettingsRow<Trailing: View>: View {
  var icon: AppGlyph?
  let title: String
  var subtitle: String?
  /// Text and icon colour (Log out: `danger000`; Delete: `danger100`).
  var tint: Color = Palette.text100
  var badge: String?
  var subtitleLines = 1
  @ViewBuilder var trailing: () -> Trailing
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    HStack(spacing: 10) {
      if let icon { AppGlyphView(icon).foregroundStyle(tint) }
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 8) {
          Text(title).typeStyle(.bodyLarge).foregroundStyle(tint).lineLimit(2)
          if let badge { ExperimentalBadge(text: badge) }
        }
        if let subtitle, !subtitle.isEmpty {
          Text(subtitle).typeStyle(.body).foregroundStyle(Palette.text500).lineLimit(subtitleLines)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
      trailing()
    }
    .opacity(enabled ? 1 : 0.38)
    .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 8)
    .frame(minHeight: 56)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r2, style: .continuous))
    .contentShape(Rectangle())
  }
}

extension SettingsRow where Trailing == EmptyView {
  init(
    icon: AppGlyph? = nil, title: String, subtitle: String? = nil, tint: Color = Palette.text100,
    badge: String? = nil, subtitleLines: Int = 1
  ) {
    self.icon = icon
    self.title = title
    self.subtitle = subtitle
    self.tint = tint
    self.badge = badge
    self.subtitleLines = subtitleLines
    self.trailing = { EmptyView() }
  }
}

/// Pressed settings rows show the 5 % fill over the tile.
struct SettingsRowPressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.overlay(configuration.isPressed ? Palette.fillSubtle : .clear)
  }
}

/// A row that pushes `destination`.
struct SettingsLink<Destination: View>: View {
  var icon: AppGlyph?
  let title: String
  var subtitle: String?
  var badge: String?
  var identifier: String?
  @ViewBuilder var destination: () -> Destination
  var body: some View {
    NavigationLink(destination: destination) {
      SettingsRow(icon: icon, title: title, subtitle: subtitle, badge: badge)
    }
    .buttonStyle(SettingsRowPressStyle())
    .accessibilityIdentifier(identifier ?? "")
  }
}

/// A row that runs `action`.
struct SettingsButton: View {
  var icon: AppGlyph?
  let title: String
  var subtitle: String?
  var tint: Color = Palette.text100
  var identifier: String?
  let action: () -> Void
  var body: some View {
    Button(action: action) { SettingsRow(icon: icon, title: title, subtitle: subtitle, tint: tint) }
      .buttonStyle(SettingsRowPressStyle())
      .accessibilityIdentifier(identifier ?? "")
  }
}

/// The switch row: the whole row toggles; helper text below the title.
struct SettingsToggleRow: View {
  var icon: AppGlyph?
  let title: String
  var helper: String?
  @Binding var isOn: Bool
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    HStack(spacing: 10) {
      if let icon { AppGlyphView(icon).foregroundStyle(Palette.text100) }
      VStack(alignment: .leading, spacing: 2) {
        Text(title).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
        if let helper, !helper.isEmpty {
          Text(helper).typeStyle(.body).foregroundStyle(Palette.text500).fixedSize(horizontal: false, vertical: true)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
      ClaudeSwitch(isOn: $isOn).accessibilityHidden(true)
    }
    .opacity(enabled ? 1 : 0.38)
    .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 8)
    .frame(minHeight: 56)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r2, style: .continuous))
    .contentShape(Rectangle())
    .onTapGesture { if enabled { isOn.toggle() } }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
    .accessibilityValue(isOn ? L("state_on") : L("state_off"))
    .accessibilityAction { if enabled { isOn.toggle() } }
  }
}

/// One picker option.
struct PickerOption<Value: Hashable>: Identifiable {
  let value: Value
  let title: String
  var icon: AppGlyph?
  var description: String?
  var id: Value { value }
}

/// The option row with picker: looks like a navigation row with the current value as the subtitle; tap opens the
/// centred picker dialog.
struct SettingsPickerRow<Value: Hashable>: View {
  var icon: AppGlyph?
  let title: String
  let options: [PickerOption<Value>]
  @Binding var selection: Value
  @State private var open = false
  var body: some View {
    Button { open = true } label: {
      SettingsRow(icon: icon, title: title, subtitle: options.first { $0.value == selection }?.title)
    }
    .buttonStyle(SettingsRowPressStyle())
    .claudeDialog(isPresented: $open) {
      PickerDialogCard(title: title, options: options, selection: $selection) { open = false }
    }
  }
}

/// The picker dialog: 300pt wide, `bg100`, 16pt corners; title 17/550 at 20pt; options at
/// 20/8 with min 56pt; the selected option in blue with a trailing check.
struct PickerDialogCard<Value: Hashable>: View {
  let title: String
  let options: [PickerOption<Value>]
  @Binding var selection: Value
  let close: () -> Void
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title).typeStyle(.bodyLargeStrong).foregroundStyle(Palette.text100).lineLimit(1)
        .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 8)
        .accessibilityAddTraits(.isHeader)
      ScrollView {
        VStack(spacing: 0) {
          ForEach(options) { option in
            let selected = option.value == selection
            Button {
              selection = option.value
              close()
            } label: {
              HStack(spacing: 12) {
                if let icon = option.icon { AppGlyphView(icon) }
                VStack(alignment: .leading, spacing: 0) {
                  Text(option.title).typeStyle(.bodyLarge)
                  if let description = option.description {
                    Text(description).typeStyle(.body).foregroundStyle(Palette.text500)
                  }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if selected { AppGlyphView(.check, size: 20) }
              }
              .foregroundStyle(selected ? Palette.accentSecondary000 : Palette.text100)
              .padding(.horizontal, 20).padding(.vertical, 8).frame(minHeight: 56).contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
            .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
          }
        }.padding(.bottom, 8)
      }.fixedSize(horizontal: false, vertical: true)
    }
    .frame(width: 300).frame(minHeight: 100, maxHeight: 400)
    .background(Palette.bg100, in: RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
    .dialogShadow(dark: scheme == .dark)
  }
}

/// "EXPERIMENTAL"-style badge: `danger900` fill, `danger000` text, 11pt strong, 4pt corners. Claudex uses it for its
/// own rows' small tags.
struct ExperimentalBadge: View {
  let text: String
  var body: some View {
    Text(text).typeStyle(.badge).foregroundStyle(Palette.danger000)
      .padding(.horizontal, 6).padding(.vertical, 2)
      .background(Palette.danger900, in: RoundedRectangle(cornerRadius: Radius.r4, style: .continuous))
  }
}

// MARK: Empty, loading and error states

/// The official empty state: centred, max 352pt wide, 92pt icon in `text500`, 12pt gap, 17pt centred text, optional
/// subtitle.
struct OfficialEmptyState: View {
  var icon: AppGlyph
  let text: String
  var subtitle: String?
  var iconSize: CGFloat = 92
  var body: some View {
    VStack(spacing: 12) {
      AppGlyphView(icon, size: iconSize)
      Text(text).typeStyle(.bodyLarge).multilineTextAlignment(.center)
      if let subtitle {
        Text(subtitle).typeStyle(.body).multilineTextAlignment(.center)
      }
    }
    .foregroundStyle(Palette.text500)
    .frame(maxWidth: 352)
    .padding(16)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }
}

/// The official error state: warning icon, text and Retry (usage / notifications pages).
struct OfficialErrorState: View {
  let text: String
  var retry: (() -> Void)?
  var body: some View {
    VStack(spacing: 16) {
      OfficialEmptyState(icon: .warningCircle, text: text, iconSize: 48)
      if let retry {
        Button(L("generic_retry"), action: retry).claudeButton(.secondary, size: .small)
      }
    }.frame(maxWidth: .infinity)
  }
}

/// A small centred spinner with 32pt padding.
struct ListLoading: View {
  var body: some View {
    ClaudeSpinner(size: .small).padding(32).frame(maxWidth: .infinity)
  }
}

// MARK: Lists

/// The inline search field at the top of a list: 40pt, 12pt corners, 12/6 padding, `bg000`-like container with a 20 %
/// outline, `textTertiary` placeholder and icon.
struct ListSearchField: View {
  let placeholder: String
  @Binding var text: String
  var body: some View {
    HStack(spacing: 8) {
      AppGlyphView(.search, size: 20).foregroundStyle(Palette.textTertiary)
      TextField(text: $text) { Text(placeholder).foregroundStyle(Palette.textTertiary) }
        .typeStyle(.body).foregroundStyle(Palette.textPrimary).tint(Palette.accentMain100)
        .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
        .accessibilityIdentifier("list-search-field")
      if !text.isEmpty {
        Button { text = "" } label: { AppGlyphView(.xCircleFilled, size: 20) }
          .buttonStyle(.plain).foregroundStyle(Palette.textTertiary)
          .accessibilityLabel(L("generic_search_clear"))
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: 40)
    .background(Palette.searchFieldFill, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.searchFieldOutline, lineWidth: 1))
    .padding(12)
  }
}

extension Palette {
  /// Search field container.
  static let searchFieldFill = Color(light: 0xFFFFFF, dark: 0x1A1A19)
  /// Search field outline.
  static let searchFieldOutline = Color(light: 0x0B0B0B, lightAlpha: 0.2, dark: 0xFFFFFF, darkAlpha: 0.2)
}

/// Relative time for list subtitles: under a minute "Just now", otherwise the system's relative phrase in the UI
/// language ("5 分钟前").
enum RelativeTime {
  static func string(_ date: Date, now: Date = Date(), capitalized: Bool = true) -> String {
    if abs(now.timeIntervalSince(date)) < 60 {
      let text = L("date_format_just_now")
      return capitalized ? text.prefix(1).uppercased() + text.dropFirst() : text
    }
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = Locale(identifier: L10n.catalog.language)
    formatter.unitsStyle = .full
    return formatter.localizedString(for: date, relativeTo: now)
  }
  static func string(ms: Double, now: Date = Date(), capitalized: Bool = true) -> String {
    string(Date(timeIntervalSince1970: ms / 1000), now: now, capitalized: capitalized)
  }
}

/// The chat list row: 12pt outer margin, 10pt clip, min 56pt, title 17pt, subtitle "time · project" 15pt `text500`;
/// leading status mark (Working spinner / New dot / Waiting); a pin glyph after the title when pinned; a leading
/// checkbox in selection mode.
struct ChatListRow: View {
  let conversation: Conversation
  var projectName: String?
  var selecting = false
  var selected = false
  var subtitleOverride: String?
  var body: some View {
    HStack(spacing: 0) {
      if selecting {
        ClaudeCheckbox(isOn: .constant(selected)).allowsHitTesting(false).frame(width: 24, height: 24)
          .padding(.trailing, 12)
          .transition(.move(edge: .leading).combined(with: .opacity))
      }
      statusMark
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 6) {
          Text(conversation.title.isEmpty ? L("generic_untitled") : conversation.title)
            .typeStyle(.bodyLarge).foregroundStyle(Palette.text100).lineLimit(1)
          if conversation.pinned {
            AppGlyphView(.pinFilled, size: 16).foregroundStyle(Palette.text500)
              .accessibilityLabel(L("chats_filter_starred"))
          }
        }
        Text(subtitle).typeStyle(.body).foregroundStyle(Palette.text500).lineLimit(1)
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.leading, 12).padding(.trailing, 12).padding(.vertical, 8)
    .frame(minHeight: 56)
    .background(selected ? Palette.drawerSelected : .clear)
    .clipShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
    .contentShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
  }
  private var subtitle: String {
    if let subtitleOverride { return subtitleOverride }
    let time = RelativeTime.string(conversation.date)
    if let projectName, !projectName.isEmpty { return L("chat_subtitle_time_and_project", time, projectName) }
    return time
  }
  @ViewBuilder private var statusMark: some View {
    if conversation.isRunning {
      ClaudeSpinner(size: .icon, color: Palette.textSecondary).padding(.leading, 4).padding(.trailing, 8)
        .accessibilityLabel(L("cds_list_row_status_working"))
    } else if conversation.unread && !conversation.incognito {
      Circle().fill(Palette.accentMain100).frame(width: 8, height: 8).frame(width: 16, height: 16)
        .padding(.leading, 4).padding(.trailing, 8)
        .accessibilityLabel(L("cds_list_row_status_new"))
    }
  }
}

/// Usage-meter row (Usage page, service status): label, caption and an 8pt bar with a 4pt radius, as the knowledge
/// capacity bar.
struct UsageMeter: View {
  let title: String
  var caption: String?
  let fraction: Double
  var trailing: String?
  var fill: Color = Palette.accentSecondary100
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text(title).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
        Spacer(minLength: 8)
        if let trailing { Text(trailing).typeStyle(.body).foregroundStyle(Palette.text300) }
      }
      CapacityBar(fraction: fraction, fill: fill)
      if let caption { Text(caption).typeStyle(.body).foregroundStyle(Palette.text500) }
    }
    .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r2, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

/// The 8pt capacity bar: `bg400` track, 4pt radius, fill to `fraction`.
struct CapacityBar: View {
  let fraction: Double
  var fill: Color = Palette.accentSecondary100
  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .leading) {
        RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Palette.bg400)
        RoundedRectangle(cornerRadius: 4, style: .continuous).fill(fill)
          .frame(width: geometry.size.width * max(0, min(1, fraction)))
      }
    }.frame(height: 8)
  }
}

// MARK: Dialogs with content

/// The official dialog with custom content between the message and the buttons: max 400pt, 12pt corners, 24pt
/// padding, 20/500 title, 15pt body, 8pt button gap.
struct FormDialogCard<Content: View, Actions: View>: View {
  let title: String
  var message: String?
  @ViewBuilder var content: () -> Content
  @ViewBuilder var actions: () -> Actions
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title).typeStyle(.dialogTitle).foregroundStyle(Palette.textPrimary).accessibilityAddTraits(.isHeader)
      if let message {
        Text(message).typeStyle(.body).foregroundStyle(Palette.textSecondary).padding(.top, 4)
      }
      VStack(alignment: .leading, spacing: 8) { content() }.padding(.top, 12)
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        actions()
      }.padding(.top, 16)
    }
    .padding(24)
    .frame(maxWidth: 400, alignment: .leading)
    .background(Palette.dialogSurface, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.borderDefault, lineWidth: 1))
    .dialogShadow(dark: scheme == .dark)
    .padding(16)
  }
}

/// A multi-line field for dialogs: `bg300`, 12pt corners, 3–10 lines.
struct DialogTextArea: View {
  let placeholder: String
  @Binding var text: String
  var lines: ClosedRange<Int> = 3...10
  var body: some View {
    TextField(text: $text, axis: .vertical) { Text(placeholder).foregroundStyle(Palette.text500) }
      .lineLimit(lines).typeStyle(.body).foregroundStyle(Palette.text100).tint(Palette.accentMain100)
      .padding(12)
      .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
  }
}
