import SwiftUI
import UIKit

// Native pieces of the official chat transcript: the long-press message menu, "Select text", the collapsed steps
// sheet and the system share sheet for a reply. The transcript itself stays in the shared web renderer.

/// A long-press menu request, resolved to a turn of the current conversation.
struct MessageMenuRequest: Identifiable, Equatable {
  let id = UUID()
  let role: TranscriptUIEvent.Role
  let turn: Turn
  /// Touch point in the transcript's coordinate space.
  let point: CGPoint
  let canRetry: Bool
  let canEdit: Bool
  let renderedIndex: Int
  var text: String { role == .user ? turn.prompt : TranscriptTurns.replyText(turn) }
}

/// The official message dropdown: 12pt corners, raised surface, 3pt elevation, rows of 48pt minimum with a 24pt
/// leading icon, a 16pt gap and 15pt text; 112–280pt wide.
struct MessageMenuOverlay: View {
  let request: MessageMenuRequest
  let onCopy: () -> Void
  let onSelect: () -> Void
  let onEdit: (() -> Void)?
  let onRetry: (() -> Void)?
  let onDismiss: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shown = false
  @State private var size: CGSize = .zero

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .topLeading) {
        Color.black.opacity(0.0001).contentShape(Rectangle())
          .onTapGesture(perform: onDismiss)
          .accessibilityLabel(L("generic_button_close"))
          .accessibilityAddTraits(.isButton)
        card
          .background(GeometryReader { proxy in Color.clear.onAppear { size = proxy.size } })
          .offset(position(in: geometry.size))
          .opacity(shown ? 1 : 0)
          .scaleEffect(shown || reduceMotion ? 1 : 0.92, anchor: .topLeading)
      }
    }
    .onAppear { withAnimation(reduceMotion ? nil : Motion.easeOut) { shown = true } }
    .accessibilityAction(.escape, onDismiss)
  }

  private var card: some View {
    VStack(alignment: .leading, spacing: 0) {
      row(L("chat_message_bottom_sheet_menu_copy"), icon: .copy, enabled: !request.text.isEmpty, action: onCopy)
      row(L("chat_message_bottom_sheet_menu_select"), icon: .select, enabled: !request.text.isEmpty, action: onSelect)
      if let onEdit { row(L("chat_message_bottom_sheet_menu_edit"), icon: .edit, action: onEdit) }
      if let onRetry { row(L("chat_message_bottom_sheet_menu_retry"), icon: .arrowClockwise, action: onRetry) }
    }
    .padding(.vertical, 8)
    .frame(minWidth: 112, maxWidth: 280)
    .fixedSize()
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
    .shadow(color: .black.opacity(0.08), radius: 8, y: 4)
    .accessibilityElement(children: .contain)
  }

  private func row(_ title: String, icon: AppGlyph, enabled: Bool = true, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 16) {
        AppGlyphView(icon, size: 24)
        Text(title).typeStyle(.body).lineLimit(1)
        Spacer(minLength: 0)
      }
      .foregroundStyle(Palette.text100)
      .padding(.horizontal, 12)
      .frame(minHeight: 48)
      .contentShape(Rectangle())
    }
    .buttonStyle(MenuRowPressStyle())
    .padding(.horizontal, 4)
    .disabled(!enabled)
    .opacity(enabled ? 1 : 0.38)
  }

  /// Below the finger (official offset x −8), flipped above it near the bottom, kept on screen.
  private func position(in bounds: CGSize) -> CGSize {
    let width = max(size.width, 112), height = max(size.height, 120)
    var x = request.point.x - 8
    var y = request.point.y + 8
    if y + height > bounds.height - 8 { y = request.point.y - height - 8 }
    x = min(max(8, x), max(8, bounds.width - width - 8))
    y = min(max(8, y), max(8, bounds.height - height - 8))
    return CGSize(width: x, height: y)
  }
}

private struct MenuRowPressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.background(
      configuration.isPressed ? Palette.fillSubtle : .clear,
      in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
  }
}

/// "Select text": the message in a selectable text view, so the system selection handles work.
struct SelectTextSheet: View {
  let text: String
  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: L("chat_message_bottom_sheet_menu_select"))
      SelectableText(text: text).padding(.horizontal, Spacing.sheetGutter - 4)
    }
    .claudeSheetChrome([.medium, .large])
  }
}

private struct SelectableText: UIViewRepresentable {
  let text: String
  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.isSelectable = true
    view.backgroundColor = .clear
    view.adjustsFontForContentSizeCategory = true
    view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 24, right: 0)
    view.dataDetectorTypes = []
    return view
  }
  func updateUIView(_ view: UITextView, context: Context) {
    let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: TypeStyle.reading.uiFont())
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = 1.2
    view.attributedText = NSAttributedString(string: text, attributes: [
      .font: font, .foregroundColor: UIColor(Palette.text100), .paragraphStyle: paragraph,
    ])
  }
}

// MARK: Collapsed steps sheet

extension TranscriptStep {
  var icon: AppGlyph {
    switch kind {
    case .thinking: .extendedThinking
    case .command: .commandLinePrompt
    case .search: .globe
    case .fileChange: .file
    case .tool, .other: .tool
    case .image: .image
    }
  }
  /// The row title in the official wording ("Searched the web", "Ran …", "Edited …").
  var title: String {
    switch kind {
    case .thinking: L("chat_thinking_block_finished_label")
    case .command: L("ccr_verb_ran")
    case .search: subject.isEmpty ? L("search_tool_searched_web") : L("search_tool_searched_for_query", subject)
    case .fileChange: subject.isEmpty ? L("ccr_verb_edited") : L("ccr_turn_edits_single_file", (subject as NSString).lastPathComponent)
    case .image: L("claudex_step_image")
    case .tool, .other: subject.isEmpty ? L("chat_tool_used_generic") : subject
    }
  }
  var detail: String? {
    switch kind {
    case .thinking: subject.isEmpty ? nil : subject
    case .command, .image: subject.isEmpty ? nil : subject
    case .fileChange: subject.isEmpty ? nil : subject
    case .search, .tool, .other: nil
    }
  }
  var stateMark: String? {
    switch state {
    case .done: nil
    case .running: L("claudex_step_running")
    case .failed: L("chat_step_failed_mark")
    case .stopped: L("chat_step_stopped_mark")
    }
  }
}

struct CollapsedStepsSheet: View {
  let steps: [TranscriptStep]
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(steps) { step in
            NavigationLink(value: step.id) { StepRow(step: step) }.buttonStyle(MenuRowPressStyle())
          }
        }.padding(.horizontal, 8).padding(.bottom, 24)
      }
      .navigationDestination(for: String.self) { id in
        if let step = steps.first(where: { $0.id == id }) { StepDetailView(step: step) }
      }
      .safeAreaInset(edge: .top, spacing: 0) { SheetHeader(title: L("collapsed_tool_timeline_title")) }
      .toolbar(.hidden, for: .navigationBar)
      .background(Palette.bg000)
    }
    .claudeSheetChrome([.medium, .large], background: Palette.bg000)
  }
}

private struct StepRow: View {
  let step: TranscriptStep
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      AppGlyphView(step.icon, size: 20).foregroundStyle(Palette.text500).padding(.top, 1)
      VStack(alignment: .leading, spacing: 2) {
        Text(step.title).typeStyle(.body).foregroundStyle(Palette.text100).lineLimit(2)
        if let detail = step.detail {
          Text(detail).typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(2)
        }
        if let mark = step.stateMark {
          Text(mark).typeStyle(.caption).foregroundStyle(step.state == .failed ? Palette.dangerText : Palette.text500)
        }
      }
      Spacer(minLength: 0)
      AppGlyphView(.caretRight, size: 16).foregroundStyle(Palette.text500).padding(.top, 2)
    }
    .padding(.horizontal, 12).padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityHint(L("collapsed_tool_show_step_details_action"))
  }
}

private struct StepDetailView: View {
  let step: TranscriptStep
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if step.kind == .thinking {
          Text(step.response.isEmpty ? L("thinking_timeline_reasoning_not_shown") : step.response)
            .typeStyle(.readingCompact).foregroundStyle(Palette.text100).textSelection(.enabled)
        } else {
          if !step.request.isEmpty { block(L("tool_content_heading_request"), step.request) }
          if step.state == .failed && step.response.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
              Text(L("tool_content_failed")).typeStyle(.bodyStrong).foregroundStyle(Palette.dangerText)
              Text(L("tool_content_failed_no_details")).typeStyle(.body).foregroundStyle(Palette.text300)
            }
          } else if !step.response.isEmpty {
            block(L("tool_content_heading_response"), step.response)
          }
        }
        if step.truncated {
          Text(L("tool_content_output_truncated")).typeStyle(.caption).foregroundStyle(Palette.text500)
        }
      }
      .padding(.horizontal, Spacing.sheetGutter).padding(.bottom, 24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      HStack(spacing: 8) {
        Button { dismiss() } label: { AppGlyphView(.arrowLeft).frame(width: 44, height: 44) }
          .buttonStyle(IconPressStyle()).foregroundStyle(Palette.text100)
          .accessibilityLabel(L("generic_back_button_content_description"))
        Text(step.kind == .thinking ? L("chat_thinking_sheet_title") : step.title)
          .typeStyle(.bodyLargeStrong).lineLimit(2).frame(maxWidth: .infinity).multilineTextAlignment(.center)
        Color.clear.frame(width: 44, height: 44)
      }.padding(.horizontal, 16).padding(.vertical, 5)
    }
    .toolbar(.hidden, for: .navigationBar)
    .background(Palette.bg000)
  }
  private func block(_ heading: String, _ text: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(heading).typeStyle(.bodyStrong).foregroundStyle(Palette.text300)
      ScrollView(.horizontal, showsIndicators: false) {
        Text(text).typeStyle(.codeSmall).foregroundStyle(Palette.text100).textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: false)
          .padding(16)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.bg200, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    }
  }
}

// MARK: System share sheet

enum ActivitySheet {
  /// Presents the system share sheet over whatever is on screen.
  @MainActor static func present(_ items: [Any]) {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
      .first(where: { $0.activationState == .foregroundActive }) ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
      var top = scene.windows.first(where: \.isKeyWindow)?.rootViewController
    else { return }
    while let next = top.presentedViewController { top = next }
    let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
    controller.popoverPresentationController?.sourceView = top.view
    controller.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 80, width: 1, height: 1)
    top.present(controller, animated: true)
  }
}
