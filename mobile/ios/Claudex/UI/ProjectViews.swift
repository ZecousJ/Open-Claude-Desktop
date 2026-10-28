import SwiftUI
import UniformTypeIdentifiers

// Projects: the Projects list, the project screen with its knowledge and custom-instructions cards, the Project
// Knowledge screen and its Add Content sheet. Claudex projects have no pinning, archiving, visibility or sharing, so
// those menu items and filters are left out (nothing pretends to work).

/// The Projects list: inline search, rows, the extended "New project" button.
struct WorkView: View {
  @EnvironmentObject private var store: AppStore
  @State private var query = ""
  @State private var creating = false
  @State private var editing: Project?
  @State private var deleting: Project?
  private var projects: [Project] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return (store.snapshot?.projects ?? []).filter {
      needle.isEmpty || $0.name.localizedCaseInsensitiveContains(needle)
        || $0.description.localizedCaseInsensitiveContains(needle)
    }.sorted { $0.createdAt > $1.createdAt }
  }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ListSearchField(placeholder: L("project_list_search_placeholder"), text: $query)
        if projects.isEmpty {
          if !query.isEmpty {
            OfficialEmptyState(icon: .searchCircle, text: L("empty_state_search_title", query)).padding(.top, 48)
          } else if store.account != nil {
            OfficialEmptyState(icon: .projects, text: L("empty_state_project_title")).padding(.top, 96)
          } else if store.isLoading {
            ListLoading()
          }
        }
        ForEach(projects) { project in
          NavigationLink { ProjectDetailView(project: project) } label: { ProjectRow(project: project) }
            .buttonStyle(RowPressStyle(radius: Radius.r10))
            .padding(.horizontal, 12)
            .contextMenu {
              MenuItem(L("project_edit_details"), icon: .note) { editing = project }
              MenuItem(L("project_delete"), icon: .trash, destructive: true) { deleting = project }
                .disabled(store.deletingProjects.contains(project.id))
            }
            .accessibilityHint(L("project_list_item_click_label"))
            .accessibilityIdentifier("project-row-" + project.id)
          Color.clear.frame(height: 8)
        }
      }.padding(.bottom, 96)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Palette.bg100.ignoresSafeArea())
    .refreshable { await store.refresh() }
    .pageTitle(L("project_list_screen_title_simple"), serif: false)
    .sidebarToolbar()
    .overlay(alignment: .bottomTrailing) {
      Button {
        if store.account == nil { store.presentLogin = true } else { creating = true }
      } label: {
        Label(L("project_list_new_project"), systemImage: AppGlyph.add.symbol)
          .labelStyle(ClaudeButtonLabelStyle(iconSize: 20))
      }
      .claudeButton(.primary, size: .large)
      .shadow(color: .black.opacity(0.12), radius: 6, y: 3)
      .padding(16)
      .accessibilityIdentifier("new-project")
    }
    .sheet(isPresented: $creating) { ProjectEditorView(project: nil).claudeSheetChrome([.large]) }
    .sheet(item: $editing) { ProjectEditorView(project: $0).claudeSheetChrome([.large]) }
    .projectDeleteAlert($deleting)
  }
}

/// Project row: 12/8 padding, 12pt spacing, 17pt title, description (or "Private") as the subtitle, relative time
/// trailing ("just now" in lower case here).
struct ProjectRow: View {
  let project: Project
  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 0) {
        Text(project.name.isEmpty ? L("generic_project") : project.name).typeStyle(.bodyLarge)
          .foregroundStyle(Palette.text100).lineLimit(1)
        let detail = project.description.trimmingCharacters(in: .whitespacesAndNewlines)
        Text(detail.isEmpty ? L("project_badge_private") : detail).typeStyle(.body)
          .foregroundStyle(Palette.text500).lineLimit(1)
      }.frame(maxWidth: .infinity, alignment: .leading)
      if project.createdAt > 0 {
        Text(RelativeTime.string(ms: project.createdAt, capitalized: false)).typeStyle(.body)
          .foregroundStyle(Palette.text500).lineLimit(1)
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 8)
    .frame(minHeight: 56)
    .contentShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
  }
}

private extension View {
  /// The official project delete dialog: "Delete project" / "Are you sure you want to delete “name”?" / Delete
  /// (destructive).
  func projectDeleteAlert(_ deleting: Binding<Project?>, onDeleted: @escaping () -> Void = {}) -> some View {
    modifier(ProjectDeleteAlert(deleting: deleting, onDeleted: onDeleted))
  }
}

private struct ProjectDeleteAlert: ViewModifier {
  @EnvironmentObject private var store: AppStore
  @Binding var deleting: Project?
  let onDeleted: () -> Void
  func body(content: Content) -> some View {
    content.alert(
      L("project_delete_dialog_title"),
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    ) {
      Button(L("generic_button_cancel"), role: .cancel) { deleting = nil }
      Button(L("project_delete"), role: .destructive) {
        if let id = deleting?.id { Task { if await store.deleteProject(id) { onDeleted() } } }
        deleting = nil
      }
    } message: {
      Text(L("project_delete_dialog_subtitle", deleting?.name ?? ""))
    }
  }
}

/// Create a project / Edit details: the official create form ("What are you working on?",
/// "What are you trying to achieve?") with a full-width primary button.
struct ProjectEditorView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  let project: Project?
  @State private var name = ""
  @State private var detail = ""
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: project == nil ? L("project_create_screen_title") : L("project_edit_details"))
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          Text(L("project_create_screen_project_title_input_label")).typeStyle(.body).foregroundStyle(Palette.text300)
          ClaudeTextField(L("project_create_screen_project_title_input_placeholder"), text: $name, shape: .rounded, identifier: "project-name")
          Text(L("project_create_screen_project_description_label")).typeStyle(.body).foregroundStyle(Palette.text300)
            .padding(.top, 16)
          TextField(text: $detail, axis: .vertical) {
            Text(L("project_create_screen_project_description_placeholder")).foregroundStyle(Palette.text500)
          }
          .lineLimit(3...8).typeStyle(.body).foregroundStyle(Palette.text100).tint(Palette.accentMain100)
          .padding(16).background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
          if let error { InlineNotice(text: error, tone: .error).padding(.top, 8) }
        }.padding(.horizontal, Spacing.sheetGutter).padding(.vertical, 12)
      }
      Button {
        Task { await save() }
      } label: {
        if busy { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) } else {
          Text(project == nil ? L("project_create_submit_button_text") : L("generic_save"))
        }
      }
      .claudeButton(.primary, size: .large, fullWidth: true)
      .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      .padding(.horizontal, Spacing.sheetGutter).padding(.vertical, 16)
    }
    .background(Palette.bg100)
    .onAppear {
      name = project?.name ?? ""
      detail = project?.description ?? ""
    }
    .interactiveDismissDisabled(busy)
  }
  private func save() async {
    guard let remote = store.remote else { return }
    busy = true
    defer { busy = false }
    do {
      var fields =
        try project.map { try JSONValue.encode($0).object ?? [:] } ?? [
          "id": .string(UUID().uuidString),
          "createdAt": .number(Date().timeIntervalSince1970 * 1000),
          "instructions": .string(""),
        ]
      fields["name"] = .string(name.trimmingCharacters(in: .whitespacesAndNewlines))
      fields["description"] = .string(detail)
      let _: Project = try await remote.rpc.call("saveProject", args: [.object(fields)], as: Project.self)
      await store.refresh()
      dismiss()
    } catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}

/// Saves a project's custom instructions (the rest of the project unchanged).
@MainActor private func saveInstructions(_ project: Project, _ text: String, store: AppStore) async throws {
  guard let remote = store.remote else { throw ServiceError.signedOut }
  var fields = try JSONValue.encode(project).object ?? [:]
  fields["instructions"] = .string(text)
  let _: Project = try await remote.rpc.call("saveProject", args: [.object(fields)], as: Project.self)
  await store.refresh()
}

/// The project screen (`project/details/h`): header (description, Private badge), the Project
/// knowledge and Custom instructions cards, then the project's chats; the composer below starts
/// a chat in the project.
struct ProjectDetailView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  let project: Project
  @State private var editing = false
  @State private var deleting: Project?
  @State private var instructions = false
  @State private var expanded = false
  @State private var knowledge: JSONValue = .null
  private var current: Project { store.snapshot?.projects.first { $0.id == project.id } ?? project }
  private var chats: [Conversation] {
    store.conversations.filter { $0.projectId == current.id && !$0.archived }.sorted { $0.updatedAt > $1.updatedAt }
  }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        header.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
        HStack(alignment: .top, spacing: 12) {
          NavigationLink { ProjectKnowledgeView(project: current) } label: {
            ProjectCard(
              title: L("project_details_knowledge_title"),
              detail: fileCount.map { L10n.plural("project_details_knowledge_file_count", count: $0) },
              empty: L("project_details_knowledge_empty_label"))
          }.buttonStyle(.plain).accessibilityIdentifier("project-knowledge-card")
          Button { instructions = true } label: {
            ProjectCard(
              title: L("project_details_custom_instructions_item_title"),
              detail: current.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : current.instructions,
              empty: L("project_details_custom_instructions_item_empty_label"), lines: 3)
          }
          .buttonStyle(.plain)
          .accessibilityHint(
            current.instructions.isEmpty
              ? L("project_details_custom_instructions_item_click_label_add")
              : L("project_details_custom_instructions_item_click_label"))
        }.padding(.horizontal, 16).padding(.bottom, 16)
        if chats.isEmpty {
          OfficialEmptyState(icon: .chats, text: L("project_details_chats_empty_state")).padding(.top, 24)
        } else {
          ForEach(chats) { conversation in
            NavigationLink { ChatView(conversationID: conversation.id) } label: {
              ChatListRow(conversation: conversation)
            }
            .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
            .simultaneousGesture(TapGesture().onEnded { store.activate(conversation) })
          }
        }
      }.padding(.bottom, 24)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(current.name.isEmpty ? L("generic_project") : current.name, serif: false)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          MenuItem(L("project_edit_details"), icon: .note) { editing = true }
          MenuItem(L("project_delete"), icon: .trash, destructive: true) { deleting = current }
            .disabled(store.deletingProjects.contains(project.id))
        } label: {
          AppGlyphView(.dotsVertical).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .foregroundStyle(Palette.text100)
        .accessibilityLabel(L("generic_button_more_options"))
      }
    }
    .safeAreaInset(edge: .bottom) {
      ComposerView(placeholder: L("chat_input_hint_in_project", current.name)).padding(.horizontal, 12)
        .padding(.bottom, 8).background(Palette.bg100)
    }
    .onAppear {
      store.activeConversationID = nil
      store.preparedProjectID = current.id
      store.mode = .chat
    }
    .onDisappear { if store.preparedProjectID == current.id { store.preparedProjectID = nil } }
    .task { await loadKnowledge() }
    .sheet(isPresented: $editing) { ProjectEditorView(project: current).claudeSheetChrome([.large]) }
    .claudeDialog(isPresented: $instructions) {
      CustomInstructionsDialog(project: current) { instructions = false }
    }
    .projectDeleteAlert($deleting) { dismiss() }
  }
  private var fileCount: Int? {
    guard let files = knowledge["files"].array, !files.isEmpty else { return nil }
    return files.count
  }
  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      let detail = current.description.trimmingCharacters(in: .whitespacesAndNewlines)
      if !detail.isEmpty {
        Text(detail).typeStyle(.body).foregroundStyle(Palette.text300).lineLimit(expanded ? nil : 3)
          .onTapGesture { withAnimation(Motion.easeOut) { expanded.toggle() } }
      }
      HStack(spacing: 8) {
        HStack(spacing: 4) {
          AppGlyphView(.lock, size: 16)
          Text(L("project_badge_private")).typeStyle(.caption)
        }
        .foregroundStyle(Palette.text500)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Palette.bg300, in: Capsule())
      }.padding(.top, 4)
    }
  }
  private func loadKnowledge() async {
    guard let remote = store.remote else { return }
    knowledge = (try? await remote.rpc.call("listProjectKnowledge", args: [.string(project.id)], as: JSONValue.self)) ?? .null
  }
}

/// Knowledge / instructions card: `bg300`, 12pt corners, 12pt padding, min 80pt; title 13/550; body 13pt, or the clay
/// "Add …" label when empty.
private struct ProjectCard: View {
  let title: String
  let detail: String?
  let empty: String
  var lines = 1
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title).typeStyle(.captionStrong).foregroundStyle(Palette.text300).lineLimit(1)
      Spacer(minLength: 12)
      if let detail {
        Text(detail).typeStyle(.caption).foregroundStyle(Palette.text300).lineLimit(lines)
          .multilineTextAlignment(.leading)
      } else {
        Text(empty).typeStyle(.captionStrong).foregroundStyle(Palette.clay)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, minHeight: 80, alignment: .topLeading)
    .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .contentShape(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
  }
}

/// "Set custom instructions": description with the project name, a multi-line field, Cancel and Save.
private struct CustomInstructionsDialog: View {
  @EnvironmentObject private var store: AppStore
  let project: Project
  let close: () -> Void
  @State private var text = ""
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    FormDialogCard(
      title: L("project_details_custom_instructions_dialog_title"),
      message: L("project_details_custom_instructions_dialog_description", project.name)
    ) {
      DialogTextArea(placeholder: L("project_details_custom_instructions_dialog_placeholder"), text: $text)
      if let error { Text(error).typeStyle(.caption).foregroundStyle(Palette.dangerText) }
    } actions: {
      Button(L("generic_button_cancel"), action: close).claudeButton(.secondary, size: .small).disabled(busy)
      Button(L("generic_save")) { Task { await save() } }.claudeButton(.primary, size: .small).disabled(busy)
    }
    .onAppear { text = project.instructions }
  }
  private func save() async {
    busy = true
    defer { busy = false }
    do {
      try await saveInstructions(project, text, store: store)
      close()
    } catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}
