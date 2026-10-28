import SwiftUI

/// The chat connector tool's approval sheet: title "Permission request"; a 48pt connector tile and the sentence
/// "Claude wants to use / <tool> from <connector>" centred; a "Show details" row that opens "Request details" (the
/// call's parameters as a table) with "From <connector> · via a connector" and the third-party disclaimer; then
/// "Review each action carefully before approving." over the choices: Always allow (where Codex offers it and the
/// administrator allows it), Allow once (the default, Primary) and Decline. The reading of the request is
/// `ConnectorToolApproval`; the answers are the ones the web card sends.
struct ConnectorToolApprovalSheet: View {
  let tool: ConnectorToolApproval
  let busy: Bool
  let failed: Bool
  let respond: (ApprovalAnswer) -> Void
  @State private var showDetails: Bool

  init(tool: ConnectorToolApproval, busy: Bool, failed: Bool, detailsOpen: Bool = false, respond: @escaping (ApprovalAnswer) -> Void) {
    self.tool = tool; self.busy = busy; self.failed = failed; self.respond = respond
    _showDetails = State(initialValue: detailsOpen)
  }

  /// The sentence on one line (for the waiting row and VoiceOver): "<tool> from <connector>".
  static func summary(_ tool: ConnectorToolApproval) -> String {
    switch (tool.toolName, tool.connectorName) {
    case let (name?, connector?): return L("tool_approval_sentence_lead") + " " + L("tool_approval_sentence_tool_from_connector_line", name, connector)
    case let (nil, connector?): return L("tool_approval_sentence_lead") + " " + L("tool_approval_sentence_connector_line", connector)
    case let (name?, nil): return L("tool_approval_sentence_lead") + " " + name
    default: return L("tool_approval_sentence_generic")
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: L("mobile_app_use_tool_approval_sheet_title"))
      ScrollView { content }
      footer
    }
  }

  /// The scrolling part: tile, sentence, details toggle and its table, attribution.
  var content: some View {
    VStack(spacing: 16) {
      AppGlyphView(.connector, size: 24).foregroundStyle(Palette.text100)
        .frame(width: 48, height: 48)
        .background(Palette.bg200, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
        .accessibilityHidden(true)
      sentence
      detailsToggle
      if showDetails { details }
      attribution
    }
    .padding(.horizontal, 24).padding(.top, 16).padding(.bottom, 16)
    .frame(maxWidth: .infinity)
  }

  /// "Claude wants to use" over "<tool> from <connector>": the names in text-100 at weight 550, the rest text-300.
  private var sentence: some View {
    VStack(spacing: 0) {
      if tool.toolName == nil && tool.connectorName == nil {
        Text(L("tool_approval_sentence_generic")).typeStyle(.bodyLargeLoose).foregroundStyle(Palette.text100)
      } else {
        Text(L("tool_approval_sentence_lead")).typeStyle(.bodyLargeLoose).foregroundStyle(Palette.text100)
        Text(secondLine).typeStyle(.bodyLargeLoose).foregroundStyle(Palette.text300)
      }
    }.multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
  }

  private var secondLine: AttributedString {
    let line: String
    switch (tool.toolName, tool.connectorName) {
    case let (name?, connector?): line = L("tool_approval_sentence_tool_from_connector_line", name, connector)
    case let (nil, connector?): line = L("tool_approval_sentence_connector_line", connector)
    default: line = tool.toolName ?? ""
    }
    var text = AttributedString(line)
    for name in [tool.toolName, tool.connectorName].compactMap({ $0 }) {
      if let range = text.range(of: name) {
        text[range].foregroundColor = Palette.text100
        text[range].font = Font.system(size: 17, weight: .semibold)
      }
    }
    return text
  }

  private var detailsToggle: some View {
    Button { withAnimation(Motion.easeOut) { showDetails.toggle() } } label: {
      HStack(spacing: 6) {
        Text(L(showDetails ? "tool_approval_hide_details" : "tool_approval_show_details")).typeStyle(.body)
        AppGlyphView(showDetails ? .caretUp : .caretDown, size: 16)
      }
      .foregroundStyle(Palette.text300).padding(.horizontal, 8).frame(minHeight: 48).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityIdentifier("approval-show-details")
  }

  private var details: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(L("tool_approval_details_title")).typeStyle(.bodyStrong).foregroundStyle(Palette.text100)
      if tool.rows.isEmpty {
        Text(L("tool_approval_details_unavailable")).typeStyle(.caption).foregroundStyle(Palette.text300)
      } else {
        VStack(spacing: 0) {
          ForEach(Array(tool.rows.enumerated()), id: \.offset) { index, row in
            if index > 0 { ClaudeDivider(horizontal: 16, vertical: 0) }
            VStack(alignment: .leading, spacing: 2) {
              Text(row.label).typeStyle(.caption).foregroundStyle(Palette.text300)
              Text(row.value.isEmpty ? L("tool_approval_table_empty_value") : row.value)
                .typeStyle(.body).foregroundStyle(Palette.text100).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 10)
          }
        }
        .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
        if tool.rows.contains(where: { $0.value.hasSuffix("…") }) {
          Text(L("tool_approval_details_shown_in_part")).typeStyle(.caption).foregroundStyle(Palette.text300)
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private var attribution: some View {
    VStack(spacing: 4) {
      Text(tool.connectorName.map { L("tool_approval_attribution_named", $0) } ?? L("tool_approval_attribution_unnamed"))
        .typeStyle(.caption).foregroundStyle(Palette.text300)
      Text(L("tool_approval_disclaimer_subtitle")).typeStyle(.caption).foregroundStyle(Palette.text300)
    }.multilineTextAlignment(.center).frame(maxWidth: .infinity)
  }

  private var footer: some View {
    VStack(spacing: 12) {
      if failed { InlineNotice(text: L("agent_chat_error_tool_approval_failed"), tone: .error) }
      Text(L("tool_approval_disclaimer_title")).typeStyle(.caption).foregroundStyle(Palette.text300).multilineTextAlignment(.center)
      buttons
    }
    .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 16)
  }

  /// Always allow, Allow once (Primary), Decline: side by side when they fit, else stacked.
  private var buttons: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 12) { choices(fill: false) }
      VStack(spacing: 8) { choices(fill: true) }
    }.disabled(busy)
  }

  @ViewBuilder private func choices(fill: Bool) -> some View {
    if let scope = tool.alwaysScope {
      Button(L(scope == "always" ? "tool_approval_button_always_allow" : "tool_approval_button_allow_for_session")) { respond(.always) }
        .claudeButton(.secondary, size: .mediumLarge, fullWidth: fill)
        .accessibilityIdentifier("approval-always-allow")
    }
    Button { respond(.once) } label: {
      if busy { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) } else { Text(L("tool_approval_button_allow_once")) }
    }
    .claudeButton(.primary, size: .mediumLarge, fullWidth: fill)
    .accessibilityIdentifier("approval-allow-once")
    Button(L("tool_approval_button_decline")) { respond(.deny) }
      .claudeButton(.secondary, size: .mediumLarge, fullWidth: fill)
      .accessibilityIdentifier("approval-decline")
  }
}
