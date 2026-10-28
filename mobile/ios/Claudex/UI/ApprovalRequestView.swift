import SwiftUI

/// The in-session approval card: 24pt corners, 16/12 padding; "Allow Claudex to run `…`?" in 15pt text-100, the
/// reason and "On <folder>" in 13pt, the raw input in a bg-200 @30 % block with "Show full input" / "Show less", then
/// full-width "Allow once" (Primary), "Always allow for this session" (Secondary, where the administrator allows
/// session grants) and "Deny" (Secondary). Extra permissions are answered the same way. A connector tool's approval
/// is the official bottom sheet (`ConnectorToolApprovalSheet`) that opens by itself, with a "Waiting for you" row to
/// open it again; a tool's form (`ElicitationFormFields`) is filled in the card and sent with Submit; a task's own
/// questions use the question card. A failed send reads as the official line.
struct ApprovalRequestView: View {
  @EnvironmentObject private var store: AppStore
  let approval: JSONValue
  let conversation: Conversation
  /// A Code conversation on one of the account's computers (DeviceViews).
  var onDevice = false
  /// How the answer is sent when it does not go to the cloud runner (a computer's relay).
  var answerHandler: ((JSONValue) async throws -> Void)? = nil
  @State private var busy = false
  @State private var failed = false
  @State private var expanded = false
  @State private var sheetOpen = false
  @State private var formValues: [String: ElicitationForm.Value] = [:]
  @State private var formProblem: ElicitationForm.Problem?
  private var method: String { approval["method"].string ?? "" }
  private var kind: ApprovalKind { ApprovalPolicy.kind(method) }
  private var params: JSONValue { approval["params"] }
  private var phoneAnswers: Bool { ApprovalPolicy.answerable(method: method, params: params, extended: !onDevice) }
  private var connectorTool: ConnectorToolApproval? { ConnectorToolApproval(method: method, params: params) }
  /// A tool's form: its fields, in the order the engine sent.
  private var isForm: Bool { kind == .elicitation && connectorTool == nil && params["mode"].string != "url" }
  private var isPage: Bool { kind == .elicitation && params["mode"].string == "url" }
  private var formFields: [ElicitationForm.Field] {
    isForm ? ElicitationForm.fields(schema: params["requestedSchema"], order: params["claudexFieldOrder"].array?.compactMap(\.string)) : []
  }
  private var sessionOffered: Bool { ApprovalPolicy.sessionOffered(method: method, policy: store.toolPolicy) }
  private var changeItem: TranscriptItem? { conversation.turns.reversed().flatMap(\.items).first { $0.id == params["itemId"].string } }
  private var changes: [JSONValue] { changeItem?.changes ?? [] }
  private var command: String {
    if let command = params["command"].string { return command }
    return params["command"].array?.compactMap(\.string).joined(separator: " ") ?? ""
  }
  private var rows: [ApprovalPolicy.PermissionRow] { kind == .permissions ? ApprovalPolicy.permissionRows(params["permissions"]) : [] }
  private var rowLines: [String] {
    rows.map { row in
      let target: String
      switch row.special {
      case .root: target = L("claudex_permission_path_root")
      case .minimal: target = L("claudex_permission_path_system")
      case .tmpdir: target = L("claudex_permission_path_temp")
      case .projectRoots: target = L("claudex_permission_path_project")
      case nil: target = row.value
      }
      let full = row.special != nil && !row.value.isEmpty ? target + "/" + row.value : target
      switch row.kind {
      case .network: return L("claudex_permission_network")
      case .read: return L("claudex_permission_read", full)
      case .write: return L("claudex_permission_write", full)
      case .block: return L("claudex_permission_block", full)
      }
    }
  }
  /// The input block: the command, the files an edit touches, or the permissions asked for.
  private var raw: String {
    switch kind {
    case .command: return command
    case .fileChange:
      let blocks = changes.map { (($0["path"].string ?? "") + "\n" + ($0["diff"].string ?? "")).trimmingCharacters(in: .whitespacesAndNewlines) }
      return blocks.isEmpty ? (params["changes"].array ?? []).compactMap { $0["path"].string }.joined(separator: "\n") : blocks.joined(separator: "\n\n")
    case .permissions: return rowLines.joined(separator: "\n")
    case .question, .elicitation: return ""
    case .other:
      let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      return (try? encoder.encode(params)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
  }
  private var header: String {
    switch kind {
    case .command:
      return ApprovalPolicy.headerContent(command).map { L("ccr_tool_approval_header", L("ccr_tool_action_run"), $0) }
        ?? L("ccr_tool_approval_header_no_content", L("ccr_tool_action_run"))
    case .fileChange: return L("ccr_tool_approval_header_no_content", L("ccr_tool_action_edit"))
    case .permissions:
      switch ApprovalPolicy.permissionTitle(rows) {
      case .network: return L("claudex_permission_title_network")
      case .files: return L("claudex_permission_title_files")
      case .generic: return L("claudex_permission_title_generic")
      }
    case .elicitation:
      // A form or a page speaks in the tool's own words; without any, the official generic line.
      if let message = params["message"].string?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty { return message }
      return L("tool_approval_sentence_generic")
    default: return L("tool_approval_sentence_generic")
    }
  }
  /// A short command is already the header; the block repeats it only when it is long or not a command.
  private var showsRaw: Bool { !raw.isEmpty && (kind != .command || ApprovalPolicy.headerContent(command) == nil) }

  var body: some View {
    Group {
      if let tool = connectorTool {
        waitingRow(tool)
          .task(id: approval["id"]) { if phoneAnswers { sheetOpen = true } }
          .sheet(isPresented: $sheetOpen) {
            ConnectorToolApprovalSheet(tool: tool, busy: busy, failed: failed) { answer in Task { await self.answer(answer) } }
              .claudeSheetChrome([.medium, .large])
          }
      } else {
        card
      }
    }
    // The cards are listed by position, so the next request in a slot starts clean.
    .onChange(of: approval["id"]) { _, _ in
      formValues = [:]; formProblem = nil; failed = false; expanded = false; sheetOpen = false
    }
  }

  /// The row that opens the connector tool's sheet again once it was dismissed (the official "Waiting for you").
  private func waitingRow(_ tool: ConnectorToolApproval) -> some View {
    Button { sheetOpen = true } label: {
      HStack(spacing: 12) {
        AppGlyphView(.connector, size: 20).foregroundStyle(Palette.text300)
        VStack(alignment: .leading, spacing: 0) {
          Text(ConnectorToolApprovalSheet.summary(tool)).typeStyle(.body).foregroundStyle(Palette.text100).lineLimit(2)
            .multilineTextAlignment(.leading)
          Text(L("chat_step_waiting_for_you_mark")).typeStyle(.caption).foregroundStyle(Palette.text300)
        }.frame(maxWidth: .infinity, alignment: .leading)
        AppGlyphView(.caretRight, size: 16).foregroundStyle(Palette.text500)
      }
      .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 56)
      .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r24, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Radius.r24, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
      .contentShape(RoundedRectangle(cornerRadius: Radius.r24, style: .continuous))
    }.buttonStyle(.plain).accessibilityIdentifier("approval-open-sheet")
  }

  private var card: some View {
    VStack(alignment: .leading, spacing: 2) {
      if kind != .question { Text(header).typeStyle(.body).foregroundStyle(Palette.text100).fixedSize(horizontal: false, vertical: true) }
      if let reason = params["reason"].string, !reason.isEmpty {
        Text(reason).typeStyle(.caption).foregroundStyle(Palette.text300)
      }
      if isPage, let url = params["url"].string, !url.isEmpty {
        Text(url).typeStyle(.caption).foregroundStyle(Palette.text300).lineLimit(3).truncationMode(.middle)
      }
      if let cwd = params["cwd"].string, !cwd.isEmpty {
        Text(L("ccr_folder_consent_device", cwd)).typeStyle(.caption).foregroundStyle(Palette.text300)
      }
      if showsRaw { rawBlock }
      if isForm && phoneAnswers && !formFields.isEmpty {
        ElicitationFormFields(fields: formFields, values: $formValues, problem: formProblem) { formProblem = nil }
          .disabled(busy).padding(.top, 8)
      }
      if kind == .question {
        QuestionCard(questions: ApprovalPolicy.questions(params), busy: busy) { response in await send(response) }
      }
      if failed { InlineNotice(text: L("agent_chat_error_tool_approval_failed"), tone: .error).padding(.top, 8) }
      footer.padding(.top, 10)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 16).padding(.vertical, 12)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r24, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r24, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
  }

  private var rawBlock: some View {
    VStack(alignment: .leading, spacing: 0) {
      ScrollView(.horizontal, showsIndicators: false) {
        Text(raw).typeStyle(.codeSmall).foregroundStyle(Palette.text100).textSelection(.enabled)
          .lineLimit(expanded ? nil : 6).fixedSize(horizontal: true, vertical: false)
          .padding(12)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.bg200.opacity(0.3), in: RoundedRectangle(cornerRadius: Radius.r8, style: .continuous))
      if raw.split(separator: "\n", omittingEmptySubsequences: false).count > 6 {
        Button { withAnimation(Motion.easeOut) { expanded.toggle() } } label: {
          Text(expanded ? L("ccr_tool_approval_raw_args_show_less") : L("ccr_tool_approval_raw_args_show_full"))
            .typeStyle(.caption).foregroundStyle(Palette.text300)
            .padding(.horizontal, 8).frame(minHeight: 40)
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
      }
    }.padding(.top, 8)
  }

  @ViewBuilder private var footer: some View {
    if phoneAnswers && (isForm || isPage) {
      VStack(spacing: 8) {
        // Submit (or Open page) is the default (Primary), Decline the Secondary under it.
        Button { Task { await submitForm() } } label: {
          if busy { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) }
          else { Text(L(isPage ? "claudex_form_open_page" : "ask_user_input_submit")) }
        }
        .claudeButton(.primary, size: .mediumLarge, fullWidth: true)
        .accessibilityIdentifier("approval-submit")
        Button(L("tool_approval_button_decline")) { Task { await answer(.deny) } }
          .claudeButton(.secondary, size: .mediumLarge, fullWidth: true)
          .accessibilityIdentifier("approval-decline")
      }.disabled(busy)
    } else if phoneAnswers {
      VStack(spacing: 8) {
        // Allow once is the default (Primary); the session grant (where allowed) and Deny are Secondary under it.
        Button { Task { await answer(.once) } } label: {
          if busy { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) } else { Text(L("ccr_tool_approval_allow_once")) }
        }
        .claudeButton(.primary, size: .mediumLarge, fullWidth: true)
        .accessibilityIdentifier("approval-allow-once")
        if sessionOffered {
          Button(L("ccr_tool_approval_always_allow_for_session")) { Task { await answer(.session) } }
            .claudeButton(.secondary, size: .mediumLarge, fullWidth: true)
            .accessibilityIdentifier("approval-allow-session")
        }
        Button(L("ccr_tool_approval_deny")) { Task { await answer(.deny) } }
          .claudeButton(.secondary, size: .mediumLarge, fullWidth: true)
          .accessibilityIdentifier("approval-decline")
      }.disabled(busy)
    } else if kind != .question {
      VStack(alignment: .leading, spacing: 8) {
        Text(onDevice ? L("ccr_folder_consent_review_on_computer") : L("claudex_approval_needs_web"))
          .typeStyle(.caption).foregroundStyle(Palette.text300)
        if !onDevice, let url = store.remote?.rpc.baseURL {
          Link(L("claudex_approval_open_web"), destination: url).claudeButton(.secondary, size: .mediumLarge, fullWidth: true)
        }
      }
    }
  }

  private func answer(_ answer: ApprovalAnswer) async {
    await respond(ApprovalPolicy.response(method: method, params: params, answer: answer))
  }
  /// Sends a response: through the computer's relay on a device, else to the cloud runner.
  private func respond(_ response: JSONValue) async {
    guard phoneAnswers, !busy else { return }
    if let answerHandler {
      busy = true; failed = false; defer { busy = false }
      do { try await answerHandler(response) } catch { failed = true }
      return
    }
    await send(response)
  }
  /// Submit sends the form's content, or opens the page first and then accepts (http and https only).
  private func submitForm() async {
    guard phoneAnswers, !busy else { return }
    if isPage {
      guard let page = ElicitationForm.openablePage(params["url"].string) else { return }
      busy = true; defer { busy = false }
      guard await UIApplication.shared.open(page) else { failed = true; return }
      busy = false
      await respond(.object(["action": .string("accept"), "content": .null, "_meta": .null]))
      return
    }
    switch ElicitationForm.content(formFields, values: formValues) {
    case .failure(let problem): formProblem = problem
    case .success(let content):
      formProblem = nil
      await respond(.object(["action": .string("accept"), "content": content, "_meta": .null]))
    }
  }
  /// Sends an answer to the cloud runner; a failure is the official fixed line, never the raw error.
  private func send(_ response: JSONValue) async {
    guard let remote = store.remote, !busy else { return }
    busy = true; failed = false; defer { busy = false }
    do {
      let _: JSONValue = try await remote.rpc.call("approve", args: [approval["id"], response], as: JSONValue.self)
      await store.refresh()
    } catch {
      failed = true
      store.validateSessionError(error)
    }
  }
}

/// The questions a task asks: "n of N" at the top left and a 32pt close (Dismiss) at the top right, the question, the
/// answers as 48pt rows with a radio (12pt corners, accent @10 % when chosen), "Type your own answer…" as the last
/// row where allowed, and one Next / Submit button. Swiping sideways moves between pages. Dismiss answers nothing.
/// Codex questions take one answer each, so there are no multi-select or ranked pages (the service never sends them).
private struct QuestionCard: View {
  let questions: [ApprovalPolicy.Question]
  let busy: Bool
  let submit: (JSONValue) async -> Void
  @State private var page = 0
  @State private var answers: [String: String] = [:]
  private var index: Int { min(max(page, 0), max(questions.count - 1, 0)) }
  private var last: Bool { index >= questions.count - 1 }

  var body: some View {
    if questions.isEmpty { EmptyView() } else {
      let question = questions[index]
      let current = (answers[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 0) {
          if questions.count > 1 {
            Text(L("ask_user_input_question_indicator", index + 1, questions.count)).typeStyle(.caption).foregroundStyle(Palette.text500)
              .padding(.vertical, 6)
          }
          Spacer(minLength: 0)
          Button { Task { await submit(ApprovalPolicy.questionResponse(questions, answers: answers, dismissed: true)) } } label: {
            AppGlyphView(.x, size: 20).foregroundStyle(Palette.text500)
              .frame(width: 32, height: 32).contentShape(Rectangle())
          }.buttonStyle(.plain).disabled(busy).accessibilityLabel(L("ask_user_input_dismiss"))
        }
        Text(question.question).typeStyle(.body).foregroundStyle(Palette.text100).padding(.vertical, 4)
          .fixedSize(horizontal: false, vertical: true)
        VStack(spacing: 8) {
            ForEach(question.options, id: \.label) { option in
              row(chosen: answers[question.id] == option.label, action: { answers[question.id] = option.label }) {
                VStack(alignment: .leading, spacing: 0) {
                  Text(option.label).typeStyle(.body).foregroundStyle(Palette.text100)
                  if let detail = option.detail { Text(detail).typeStyle(.caption).foregroundStyle(Palette.text500) }
                }
              }
            }
            if question.allowsOther {
              let custom = answers[question.id].flatMap { value in question.options.contains { $0.label == value } ? nil : value } ?? ""
              row(chosen: !custom.trimmingCharacters(in: .whitespaces).isEmpty, action: {}) {
                let binding = Binding(get: { custom }, set: { answers[question.id] = $0 })
                Group {
                  if question.isSecret { SecureField(text: binding) { placeholder } }
                  else { TextField(text: binding, axis: .vertical) { placeholder }.lineLimit(1...4) }
                }.typeStyle(.body).foregroundStyle(Palette.text100).tint(Palette.accentMain100)
              }
            }
        }.padding(.top, 4)
        Button {
          if last { Task { await submit(ApprovalPolicy.questionResponse(questions, answers: answers)) } } else { withAnimation(Motion.easeOut) { page = index + 1 } }
        } label: {
          if busy && last { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) } else { Text(L(last ? "ask_user_input_submit" : "ask_user_input_next")) }
        }
        .claudeButton(.primary, size: .mediumLarge, fullWidth: true)
        .disabled(busy || current.isEmpty)
        .padding(.top, 10)
      }
      .gesture(DragGesture(minimumDistance: 24).onEnded { value in
        if value.translation.width < -80, !current.isEmpty, !last { page = index + 1 }
        else if value.translation.width > 80, index > 0 { page = index - 1 }
      })
    }
  }
  private var placeholder: Text { Text(L("ask_user_input_custom_answer")).foregroundStyle(Palette.text500) }

  /// One answer row: ≥ 48pt, 12pt corners, 8/12 padding, a radio and a 16pt gap.
  private func row<Content: View>(chosen: Bool, action: @escaping () -> Void, @ViewBuilder content: () -> Content) -> some View {
    HStack(spacing: 16) {
      Circle().strokeBorder(chosen ? Palette.accentBlue : Palette.textTertiary, lineWidth: 1)
        .background(Circle().fill(chosen ? Palette.accentBlue : .clear))
        .overlay { if chosen { Circle().fill(Palette.oncolor100).frame(width: 8, height: 8) } }
        .frame(width: 20, height: 20)
      content().frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 48)
    .background(chosen ? Palette.accentMain100.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
    .contentShape(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .onTapGesture(perform: action)
    .accessibilityAddTraits(chosen ? [.isSelected] : [])
  }
}
