import PhotosUI
import SwiftUI
import UIKit

// MARK: Grouped option rows (composer.md §4.2)

/// Where a row sits in its group: the group's outer corners are 16pt, inner corners 2pt, rows 2pt apart.
enum OptionRowPosition {
  case single, first, middle, last
  static func at(_ index: Int, of count: Int) -> OptionRowPosition {
    if count <= 1 { return .single }
    if index == 0 { return .first }
    return index == count - 1 ? .last : .middle
  }
  var shape: UnevenRoundedRectangle {
    let outer = Radius.r16, inner = Radius.r2
    let top = self == .single || self == .first ? outer : inner
    let bottom = self == .single || self == .last ? outer : inner
    return UnevenRoundedRectangle(
      topLeadingRadius: top, bottomLeadingRadius: bottom, bottomTrailingRadius: bottom, topTrailingRadius: top,
      style: .continuous)
  }
}

/// One row of a sheet group: min 56pt, padding 12 / 8 / 16 / 8, `bg000`, 17pt title, 15pt
/// `text500` subtitle; an optional leading icon and trailing slot.
struct OptionRow<Trailing: View>: View {
  var icon: Anthropicon?
  let title: String
  var subtitle: String?
  var selected = false
  var position: OptionRowPosition = .single
  @ViewBuilder var trailing: () -> Trailing
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    HStack(spacing: 12) {
      if let icon { AnthropiconView(icon).foregroundStyle(enabled ? Palette.text100 : Palette.text500) }
      VStack(alignment: .leading, spacing: 2) {
        Text(title).typeStyle(selected ? .bodyLargeStrong : .bodyLarge)
          .foregroundStyle(enabled ? Palette.text100 : Palette.text500)
        if let subtitle, !subtitle.isEmpty {
          Text(subtitle).typeStyle(.body).foregroundStyle(Palette.text500).lineLimit(3)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
      trailing()
    }
    .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 8)
    .frame(minHeight: 56)
    .background(Palette.bg000, in: position.shape)
    .contentShape(position.shape)
  }
}

extension OptionRow where Trailing == EmptyView {
  init(icon: Anthropicon? = nil, title: String, subtitle: String? = nil, position: OptionRowPosition = .single) {
    self.icon = icon
    self.title = title
    self.subtitle = subtitle
    self.position = position
    self.trailing = { EmptyView() }
  }
}

/// Trailing value and caret of a navigation row.
struct OptionRowValue: View {
  var value: String?
  var body: some View {
    HStack(spacing: 4) {
      if let value { Text(value).typeStyle(.body).foregroundStyle(Palette.text500).lineLimit(1) }
      AnthropiconView(.caretRight, size: 20).foregroundStyle(Palette.text500)
    }
  }
}

/// A group of option rows, 12pt from the sheet edges.
struct OptionGroup<Content: View>: View {
  @ViewBuilder var content: () -> Content
  var body: some View {
    VStack(spacing: 2) { content() }.padding(.horizontal, 12)
  }
}

/// Pages pushed inside a sheet use the native back button (system-level control) on `bg100`.
private extension View {
  func optionPage(_ title: String) -> some View {
    ScrollView { self.padding(.top, 12).padding(.bottom, 24) }
      .background(Palette.bg100)
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(Palette.bg100, for: .navigationBar)
  }
}

// MARK: Add to chat (composer.md §4)

/// The + sheet: Camera / Photos / Files tiles, then the options that fit Claudex — project (chat),
/// permission (Code) and the service's knowledge bases as connector-style switch rows.
/// Web search and research are deliberately absent on mobile.
struct AttachmentSheet: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  var mode: ChatMode = .chat
  enum Page: Hashable { case project, permission }
  @State private var path: [Page] = []
  @State private var importing = false
  @State private var camera = false
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var movingConversation = false
  private static let limit = AttachmentLimits.maximumCount
  private var remaining: Int { max(0, Self.limit - store.attachments.count) }
  private var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
  private var projectName: String? {
    let id = store.activeConversation?.projectId ?? store.preparedProjectID
    return id.flatMap { id in store.snapshot?.projects.first { $0.id == id }?.name }
  }
  private var showsProject: Bool { mode == .chat && !(store.snapshot?.projects.isEmpty ?? true) }
  private var showsPermission: Bool { mode == .code && store.codePermissionForm.availability != .unavailable }

  var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        SheetHeader(title: L(mode == .code ? "chat_options_add_to_session" : "chat_options_add_to_chat"))
        ScrollView {
          VStack(spacing: 12) {
            tiles.padding(.horizontal, 12)
            if remaining == 0 {
              Text(L("chat_input_attachment_limit_reached_toast", Self.limit)).typeStyle(.caption)
                .foregroundStyle(Palette.text500).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
            }
            if showsProject || showsPermission { optionsGroup }
            if !store.knowledgeBases.isEmpty { knowledgeGroup }
            if mode != .code { connectorGroup }
          }.padding(.top, 12).padding(.bottom, 24)
        }
      }
      .background(Palette.bg100)
      .toolbar(.hidden, for: .navigationBar)
      .navigationDestination(for: Page.self) { page in
        switch page {
        case .project: NewChatProjectPage()
        case .permission: CloudPermissionView().padding(.horizontal, 12).optionPage(L("chat_options_permission"))
        }
      }
    }
    .task { await store.loadKnowledgeBases(); await store.loadConnectorPolicy() }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      switch result {
      case .success(let urls):
        for url in urls.prefix(remaining) { store.addFile(url) }
        dismiss()
      case .failure(let error): store.errorMessage = error.localizedDescription
      }
    }
    .onChange(of: photoItems) { _, items in
      guard !items.isEmpty else { return }
      let scope = store.composerScope, account = store.accountGeneration
      Task {
        for item in items {
          do {
            if let data = try await item.loadTransferable(type: Data.self) {
              guard scope == store.composerScope, account == store.accountGeneration else { return }
              store.addPhoto(data, extension: item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg")
            }
          } catch { store.errorMessage = error.localizedDescription }
        }
        photoItems = []
        dismiss()
      }
    }
    .fullScreenCover(isPresented: $camera) {
      CameraPicker { data in
        camera = false
        if let data { store.addPhoto(data, extension: "jpg"); dismiss() }
      }.ignoresSafeArea()
    }
    .sheet(isPresented: $movingConversation) {
      if let id = store.activeConversationID { ConversationProjectPicker(conversationID: id).id(store.accountGeneration) }
    }
  }

  private var tiles: some View {
    HStack(spacing: 8) {
      Button { camera = true } label: { UploadTile(icon: .camera, title: L("upload_camera_button")) }
        .disabled(!cameraAvailable || remaining == 0).accessibilityIdentifier("pick-camera")
      PhotosPicker(
        selection: $photoItems, maxSelectionCount: max(1, remaining), selectionBehavior: .ordered, matching: .images
      ) { UploadTile(icon: .image, title: L("upload_photos_button")) }
        .disabled(remaining == 0).accessibilityIdentifier("pick-photo")
      Button { importing = true } label: { UploadTile(icon: .fileUpload, title: L("upload_file_button")) }
        .disabled(remaining == 0).accessibilityIdentifier("pick-file")
    }
    .buttonStyle(.plain)
    .fixedSize(horizontal: false, vertical: true)
  }

  private var optionsGroup: some View {
    let rows = (showsProject ? 1 : 0) + (showsPermission ? 1 : 0)
    return OptionGroup {
      if showsProject {
        Button {
          if store.activeConversationID != nil { movingConversation = true } else { path.append(.project) }
        } label: {
          OptionRow(
            icon: .projects, title: L(projectName == nil ? "chat_options_add_to_project" : "chat_options_change_project"),
            position: .at(0, of: rows)
          ) { OptionRowValue(value: projectName ?? L("generic_none")) }
        }.buttonStyle(RowPressStyle(radius: Radius.r16))
          .disabled(store.activeConversation?.isRunning == true)
          .accessibilityIdentifier("options-project")
      }
      if showsPermission {
        Button { path.append(.permission) } label: {
          OptionRow(icon: .lockShield, title: L("chat_options_permission"), position: .at(rows - 1, of: rows)) {
            OptionRowValue(value: store.codePermissionForm.selected.map(CloudPermissionView.title))
          }
        }.buttonStyle(RowPressStyle(radius: Radius.r16)).accessibilityIdentifier("options-permission")
      }
    }
  }

  @ViewBuilder private var connectorGroup: some View {
    let rows = store.connectorRows()
    if !rows.isEmpty {
      Text(L("connectors_setting_title")).typeStyle(.caption).foregroundStyle(Palette.text500)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
      OptionGroup {
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
          let running = store.activeConversation?.isRunning == true
          OptionRow(icon: .tool, title: row.name, subtitle: running ? L("connector_busy") : nil, position: .at(index, of: rows.count)) {
            ClaudeSwitch(isOn: Binding(get: { row.on }, set: { value in Task { await store.toggleConnector(row.name, on: value) } }))
          }
          .disabled(running)
          .accessibilityIdentifier("connector-" + row.name)
        }
      }
    }
  }

  /// Knowledge bases (Claudex, owner 2026-10-07) in the official connector-toggle style: off until
  /// this chat turns one on; a base whose server cannot be reached is disabled as "Unavailable".
  private var knowledgeGroup: some View {
    OptionGroup {
      ForEach(Array(store.knowledgeBases.enumerated()), id: \.element.id) { index, base in
        let on = store.activeKnowledge.contains(base.id)
        let usable = base.available || on
        OptionRow(
          icon: .knowledge, title: base.name,
          subtitle: usable ? base.description : L("claudex_knowledge_unavailable"),
          position: .at(index, of: store.knowledgeBases.count)
        ) {
          ClaudeSwitch(isOn: Binding(get: { on }, set: { _ in Task { await store.toggleKnowledge(base.id) } }))
        }
        .disabled(!usable)
        .accessibilityElement(children: .combine)
        .accessibilityValue(L(on ? "state_on" : "state_off"))
        .accessibilityAction { if usable { Task { await store.toggleKnowledge(base.id) } } }
        .accessibilityIdentifier("knowledge-" + base.id)
      }
    }
  }
}

/// Upload tile (composer.md §4.1): min 104pt, 16pt corners on `bg000`, a 10 % disc around the
/// 24pt icon and a 15pt centred label; disabled in `text500`.
private struct UploadTile: View {
  let icon: Anthropicon
  let title: String
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    let color = enabled ? Palette.text100 : Palette.text500
    VStack(spacing: 8) {
      AnthropiconView(icon).padding(10).background(color.opacity(0.10), in: Circle())
      Text(title).typeStyle(.body).multilineTextAlignment(.center).lineLimit(2)
    }
    .foregroundStyle(color)
    .padding(8)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .frame(minHeight: 104)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
    .contentShape(RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
  }
}

/// Project for the next new chat ("None" or one of the account's projects).
private struct NewChatProjectPage: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    let projects = store.snapshot?.projects ?? []
    let count = projects.count + 1
    OptionGroup {
      row(nil, title: L("generic_none"), index: 0, count: count)
      ForEach(Array(projects.enumerated()), id: \.element.id) { index, project in
        row(project.id, title: project.name, index: index + 1, count: count)
      }
    }.optionPage(L("chat_options_add_to_project"))
  }
  private func row(_ id: String?, title: String, index: Int, count: Int) -> some View {
    let selected = store.preparedProjectID == id
    return Button {
      store.selectComposerProject(id)
      dismiss()
    } label: {
      OptionRow(title: title, selected: selected, position: .at(index, of: count)) {
        AnthropiconView(.check).foregroundStyle(Palette.text100).opacity(selected ? 1 : 0)
      }
    }.buttonStyle(RowPressStyle(radius: Radius.r16))
      .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// The system camera; returns JPEG bytes, or nil when cancelled.
struct CameraPicker: UIViewControllerRepresentable {
  let completion: (Data?) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let completion: (Data?) -> Void
    init(completion: @escaping (Data?) -> Void) { self.completion = completion }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      completion((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9))
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
  }
}

// MARK: Model selector (composer.md §5)

/// "Select model": the model rows, then "Effort ›" and "More models ›" as separate pages.
/// Extended thinking is not offered: the service exposes reasoning only as effort levels.
struct ModelSheet: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  var mode: ChatMode = .chat
  var conversation: Conversation?
  enum Page: Hashable { case effort, more }
  @State private var path: [Page] = []
  private var selectedKey: ModelChoice.Key? { store.selectedModelKey(mode: mode, conversation: conversation) }
  private var model: ModelChoice? { store.selectedModel(mode: mode, conversation: conversation) }
  private var choices: (quick: [ModelChoice], more: [ModelChoice]) { ModelMenuPolicy.choices(store.modelChoices, selected: selectedKey) }
  private var currentEffort: ModelEffort? { model.flatMap { store.selectedEffort($0, mode: mode, conversation: conversation) } }

  var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        SheetHeader(title: L("chat_options_select_model")).accessibilityIdentifier("model-sheet-header")
        ScrollView {
          VStack(spacing: 12) {
            switch store.modelCatalog {
            case .loading:
              ClaudeSpinner().frame(maxWidth: .infinity, minHeight: 56).accessibilityIdentifier("model-catalog-loading")
            case .failed:
              OptionGroup {
                Button { Task { await store.refresh() } } label: {
                  OptionRow(title: L("generic_error_something_went_wrong_try_again"))
                }.buttonStyle(RowPressStyle(radius: Radius.r16))
              }
            case .loaded:
              let choices = choices
              if !choices.quick.isEmpty {
                modelGroup(choices.quick)
              }
              if let currentEffort {
                OptionGroup {
                  Button { path.append(.effort) } label: {
                    OptionRow(title: L("chat_options_effort")) {
                      OptionRowValue(value: effortName(currentEffort))
                    }
                  }.buttonStyle(RowPressStyle(radius: Radius.r16)).accessibilityIdentifier("model-effort-row")
                }
              }
              if !choices.more.isEmpty {
                OptionGroup {
                  Button { path.append(.more) } label: {
                    OptionRow(title: L("chat_options_more_models")) { OptionRowValue() }
                  }.buttonStyle(RowPressStyle(radius: Radius.r16)).accessibilityIdentifier("model-more-row")
                }
              }
            }
          }.padding(.top, 12).padding(.bottom, 24)
        }
      }
      .background(Palette.bg100)
      .toolbar(.hidden, for: .navigationBar)
      .navigationDestination(for: Page.self) { page in
        switch page {
        case .effort: effortGroup.optionPage(L("chat_options_effort"))
        case .more: modelGroup(choices.more).optionPage(L("chat_options_more_models"))
        }
      }
    }
  }

  private func modelGroup(_ models: [ModelChoice]) -> some View {
    OptionGroup {
      ForEach(Array(models.enumerated()), id: \.element.id) { index, choice in
        let selected = choice.key == selectedKey
        Button {
          if let conversation, mode == .code {
            Task {
              if await store.changeConversationModel(conversation, to: choice) { dismiss() }
            }
          } else if store.selectModel(choice, mode: mode, conversation: conversation) {
            dismiss()
          }
        } label: {
          ModelRow(choice: choice, selected: selected, position: .at(index, of: models.count))
        }
        .buttonStyle(RowPressStyle(radius: Radius.r16))
        .disabled(store.isSavingModel)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("model-choice-\(choice.id)")
      }
    }
  }

  private var effortGroup: some View {
    OptionGroup {
      let efforts = model?.efforts ?? []
      ForEach(Array(efforts.enumerated()), id: \.element) { index, effort in
        let selected = effort == currentEffort
        Button {
          Task { if await store.setEffort(effort, mode: mode, conversation: conversation), !path.isEmpty { path.removeLast() } }
        } label: {
          OptionRow(title: effortName(effort), position: .at(index, of: efforts.count)) {
            AnthropiconView(.check).foregroundStyle(Palette.text100).opacity(selected ? 1 : 0)
          }
        }
        .buttonStyle(RowPressStyle(radius: Radius.r16))
        .disabled(store.isSavingModel)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("model-effort-\(effort.rawValue)")
      }
    }
  }
}

/// Model row (composer.md §5.1): 17pt name with its badges, the 13pt `text500` description
/// (2 lines; the account's usage hint after it) and the check, drawn transparent when not selected
/// so every row keeps its space.
private struct ModelRow: View {
  let choice: ModelChoice
  let selected: Bool
  let position: OptionRowPosition
  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(choice.label).typeStyle(.bodyLarge).foregroundStyle(Palette.text100).lineLimit(1)
          ForEach(choice.model.badges.prefix(2), id: \.self) { ModelBadge(text: $0) }
        }
        if !choice.model.description.isEmpty {
          Text(choice.model.description).typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(2)
        }
        if !choice.model.usageHint.isEmpty {
          Text(choice.model.usageHint).typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(2)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
      AnthropiconView(.check).foregroundStyle(Palette.text100).opacity(selected ? 1 : 0)
    }
    .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 8)
    .frame(minHeight: 56)
    .background(Palette.bg000, in: position.shape)
    .contentShape(position.shape)
  }
}

/// Neutral model badge: pill on `bg300`, 11pt strong `text300`, padding 8 / 2.
struct ModelBadge: View {
  let text: String
  var body: some View {
    Text(text).typeStyle(.badge).foregroundStyle(Palette.text300).lineLimit(1)
      .padding(.horizontal, 8).padding(.vertical, 2)
      .background(Palette.bg300, in: Capsule())
  }
}

// MARK: Waiting messages (official `WaitingMessages` sheet)

/// "N messages waiting": the note, then each waiting message with Send now / Undo send (and
/// Delete, Claudex) for the ones not yet handed to Claude.
struct WaitingMessagesSheet: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    let entries = store.queuedMessages
    VStack(spacing: 0) {
      SheetHeader(title: L10n.plural("chat_waiting_messages_sheet_title", count: entries.count))
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          Text(L("chat_waiting_messages_sheet_note")).typeStyle(.body).foregroundStyle(Palette.text300)
            .padding(.horizontal, 24)
          OptionGroup {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
              row(entry, position: .at(index, of: entries.count))
            }
          }
        }.padding(.top, 4).padding(.bottom, 24)
      }
    }
    .background(Palette.bg100)
    .onChange(of: entries.isEmpty) { _, empty in if empty { dismiss() } }
  }

  private func row(_ entry: QueuedComposerMessage, position: OptionRowPosition) -> some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        if !entry.text.isEmpty {
          Text(entry.text).typeStyle(.bodyLarge).foregroundStyle(Palette.text100).lineLimit(6).textSelection(.enabled)
        }
        if !entry.attachments.isEmpty {
          Text(L10n.plural("claudex_attachments_count", count: entry.attachments.count))
            .typeStyle(.caption).foregroundStyle(Palette.text500)
        }
        if let error = entry.error {
          Text(error).typeStyle(.caption).foregroundStyle(Palette.dangerText)
        } else {
          Text(L(entry.state == .steered ? "chat_waiting_messages_sheet_note" : "chat_message_queued_state_description"))
            .typeStyle(.caption).foregroundStyle(Palette.text500)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
      if entry.state == .queued {
        Menu {
          if !entry.startsNextTurn {
            MenuItem(L("chat_waiting_message_menu_send_now"), icon: .arrowUp) { store.sendQueuedNow(entry) }
          }
          MenuItem(L("chat_waiting_message_menu_undo_send"), icon: .arrowCounterClockwise) {
            store.editQueuedMessage(entry)
            dismiss()
          }
          MenuItem(L("generic_button_delete"), icon: .trash, destructive: true) { store.removeQueuedMessage(entry) }
        } label: {
          AnthropiconView(.dotsHorizontal).foregroundStyle(Palette.text300).frame(width: 44, height: 44)
        }
        .disabled(store.composerBusy)
        .accessibilityLabel(L("generic_button_more_options"))
      }
    }
    .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 8)
    .frame(minHeight: 56)
    .background(Palette.bg000, in: position.shape)
    .accessibilityIdentifier("queued-message-" + entry.id.uuidString)
  }
}
