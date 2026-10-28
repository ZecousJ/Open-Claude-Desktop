import SwiftUI

/// The official Chats screen: filter dropdown (All / Pinned / Archived), the inline search field, rows grouped by
/// recency with no visible headers (4pt after each group), long-press menu, multi-select with Move and Delete, pull
/// to refresh.
struct AllChatsView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  enum Filter: String, CaseIterable, Identifiable {
    case all, pinned, archived
    var id: String { rawValue }
    var title: String {
      switch self {
      case .all: L("chats_filter_all")
      case .pinned: L("chats_filter_starred")
      case .archived: L("chats_filter_archived")
      }
    }
    var menuIcon: AppGlyph {
      switch self {
      case .all: .chats
      case .pinned: .pinFilled
      case .archived: .archive
      }
    }
    var emptyIcon: AppGlyph {
      switch self {
      case .all: .chats
      case .pinned: .pin
      case .archived: .archive
      }
    }
    var emptyText: String {
      switch self {
      case .all: L("empty_state_chat_title")
      case .pinned: L("empty_state_chat_starred_title")
      case .archived: L("empty_state_chat_archived_title")
      }
    }
  }
  @State private var filter: Filter = .all
  @State private var query = ""
  @State private var selecting = false
  @State private var selection: Set<String> = []
  @State private var renaming: Conversation?
  @State private var titleDraft = ""
  @State private var deleting: Conversation?
  @State private var deletingSelection = false
  @State private var deletingBusy = false
  @State private var moving: Conversation?
  @State private var movingSelection = false

  private var projects: [String: String] {
    Dictionary((store.snapshot?.projects ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
  }
  private var needle: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var listed: [Conversation] {
    store.conversations.filter { conversation in
      let inFilter: Bool
      switch filter {
      case .all: inFilter = !conversation.archived
      case .pinned: inFilter = conversation.pinned && !conversation.archived
      case .archived: inFilter = conversation.archived
      }
      guard inFilter else { return false }
      guard !needle.isEmpty else { return true }
      return conversation.title.localizedCaseInsensitiveContains(needle)
        || conversation.turns.contains {
          $0.prompt.localizedCaseInsensitiveContains(needle)
            || $0.items.contains { $0.text?.localizedCaseInsensitiveContains(needle) == true }
        }
    }.sorted { $0.updatedAt > $1.updatedAt }
  }
  private var selectedConversations: [Conversation] { store.conversations.filter { selection.contains($0.id) } }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ListSearchField(placeholder: L("generic_search"), text: $query)
        if listed.isEmpty {
          if !needle.isEmpty {
            OfficialEmptyState(icon: .searchCircle, text: L("empty_state_search_title", needle))
              .padding(.top, 48)
          } else if store.account != nil || filter != .all {
            OfficialEmptyState(icon: filter.emptyIcon, text: filter.emptyText).padding(.top, 48)
          } else if store.isLoading {
            ListLoading()
          }
        }
        ForEach(RecencyBucket.group(listed, date: \.date), id: \.bucket) { group in
          ForEach(group.items) { row($0) }
          Color.clear.frame(height: 4)
        }
      }
      .padding(.bottom, 24)
      .animation(reduceMotion ? nil : Motion.easeOut, value: selecting)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Palette.bg100.ignoresSafeArea())
    .refreshable { await store.refresh() }
    .pageTitle(
      L("chat_list_screen_title"), serif: false,
      subtitle: selecting ? L("chat_list_selected_count", selection.count) : nil
    )
    .navigationBarBackButtonHidden(selecting)
    .toolbar { toolbar }
    .alert(
      L("chat_menu_rename_dialog_title"),
      isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    ) {
      TextField(L("generic_name_label"), text: $titleDraft)
      Button(L("generic_button_cancel"), role: .cancel) { renaming = nil }
      Button(L("chat_menu_rename")) {
        if let conversation = renaming, let patch = try? NativeConversationDetails.rename(titleDraft) {
          Task { await store.update(conversation, patch: patch) }
        }
        renaming = nil
      }.disabled((try? NativeConversationDetails.rename(titleDraft)) == nil)
    }
    .alert(
      L("chat_menu_delete_conversation_dialog_title"),
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    ) {
      Button(L("generic_button_cancel"), role: .cancel) { deleting = nil }
      Button(L("chat_menu_delete"), role: .destructive) {
        if let id = deleting?.id { Task { await store.deleteConversation(id) } }
        deleting = nil
      }
    } message: {
      Text(L("delete_dialog_default_subtitle"))
    }
    .alert(L10n.plural("chat_list_delete_selected_title", count: selection.count), isPresented: $deletingSelection) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("chat_menu_delete"), role: .destructive) { Task { await deleteSelection() } }
    } message: {
      Text(L("delete_dialog_default_subtitle"))
    }
    .sheet(item: $moving) { conversation in
      ConversationProjectPicker(conversationID: conversation.id).id(store.accountGeneration)
    }
    .sheet(isPresented: $movingSelection) {
      ProjectPickerSheet(current: nil, allowsRemoval: selectedConversations.contains { $0.projectId != nil }) { project in
        Task { await moveSelection(to: project) }
      }
    }
  }

  // MARK: Rows

  private func row(_ conversation: Conversation) -> some View {
    let isSelected = selection.contains(conversation.id)
    return Button {
      if selecting {
        toggle(conversation)
      } else {
        store.activate(conversation)
        store.chatPath.append(.conversation(conversation.id))
      }
    } label: {
      ChatListRow(
        conversation: conversation, projectName: conversation.projectId.flatMap { projects[$0] },
        selecting: selecting, selected: isSelected)
    }
    .buttonStyle(RowPressStyle(radius: Radius.r10))
    .padding(.horizontal, 12)
    .contextMenu { if !selecting { menu(conversation) } }
    .accessibilityAddTraits(selecting && isSelected ? .isSelected : [])
    .accessibilityIdentifier("chat-row-" + conversation.id)
  }

  @ViewBuilder private func menu(_ conversation: Conversation) -> some View {
    MenuItem(L("chat_rename"), icon: .edit) {
      titleDraft = conversation.title
      renaming = conversation
    }
    MenuItem(conversation.pinned ? L("chat_unstar") : L("chat_star"), icon: conversation.pinned ? .pinSlash : .pin) {
      Task { await store.update(conversation, patch: .object(["pinned": .bool(!conversation.pinned)])) }
    }
    if store.account != nil {
      MenuItem(conversation.projectId == nil ? L("chat_add_project") : L("chat_change_project"), icon: .projects) {
        moving = conversation
      }.disabled(conversation.isRunning)
      if conversation.projectId != nil {
        MenuItem(L("chat_remove_from_project"), icon: .projectsX) {
          Task { await move([conversation], to: nil) }
        }.disabled(conversation.isRunning)
      }
    }
    MenuItem(conversation.archived ? L("session_menu_unarchive") : L("session_menu_archive"), icon: .archive) {
      Task { await store.update(conversation, patch: .object(["archived": .bool(!conversation.archived)])) }
    }.disabled(conversation.isRunning)
    MenuItem(L("chat_delete"), icon: .trash, destructive: true) { deleting = conversation }
      .disabled(conversation.isRunning || store.conversationActions.contains(conversation.id))
  }

  // MARK: Top bar

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    if selecting {
      ToolbarItem(placement: .topBarLeading) {
        ClaudeIconButton(.x, label: L("generic_button_close")) { endSelection() }
          .accessibilityIdentifier("chats-end-selection")
      }
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button { movingSelection = true } label: {
          HStack(spacing: 4) {
            AppGlyphView(.projects, size: 20)
            Text(L("chat_list_move_selected")).typeStyle(.bodyStrong)
          }.foregroundStyle(canMove ? Palette.text100 : Palette.text500)
        }.disabled(!canMove).accessibilityIdentifier("chats-move")
        ClaudeIconButton(.trash, label: L("chat_menu_delete"), tint: canDelete ? Palette.danger100 : Palette.text500) {
          deletingSelection = true
        }.disabled(!canDelete).accessibilityIdentifier("chats-delete")
      }
    } else {
      ToolbarItemGroup(placement: .topBarTrailing) {
        if store.snapshot?.host?["capabilities"]["scheduledTasks"].bool == true {
          ClaudeIconButton(.clock, label: L("chat_list_scheduled_tasks_a11y")) {
            store.chatPath = []
            store.section = .schedules
          }
        }
        Menu {
          ForEach(Filter.allCases) { option in
            MenuItem(option.title, icon: option.menuIcon, selected: filter == option) { filter = option }
          }
        } label: {
          HStack(spacing: 2) {
            AppGlyphView(filter.emptyIcon, size: 20)
            AppGlyphView(.caretDown, size: 16)
          }.foregroundStyle(Palette.text100).frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(filter == .all ? L("chat_list_filter_chats_a11y") : L("chat_list_filter_change_a11y"))
        .accessibilityValue(filter.title)
        .accessibilityIdentifier("chats-filter")
        if store.account != nil {
          ClaudeIconButton(.checklist, label: L("chat_list_select_multiple")) { selecting = true }
            .accessibilityIdentifier("chats-select")
        }
      }
    }
  }

  private var canMove: Bool {
    !selection.isEmpty && store.snapshot?.projects.isEmpty == false && !selectedConversations.contains(where: \.isRunning)
  }
  private var canDelete: Bool { !selection.isEmpty && !deletingBusy && !selectedConversations.contains(where: \.isRunning) }

  private func toggle(_ conversation: Conversation) {
    if selection.contains(conversation.id) { selection.remove(conversation.id) } else { selection.insert(conversation.id) }
  }
  private func endSelection() {
    selecting = false
    selection = []
  }

  // MARK: Actions

  private func deleteSelection() async {
    deletingBusy = true
    defer { deletingBusy = false }
    for id in selection { await store.deleteConversation(id) }
    endSelection()
  }

  private func moveSelection(to project: Project?) async {
    await move(selectedConversations, to: project)
    endSelection()
  }

  private func move(_ conversations: [Conversation], to project: Project?) async {
    let available = Set((store.snapshot?.projects ?? []).map(\.id))
    var moved = 0
    for conversation in conversations where !conversation.isRunning {
      guard let patch = try? NativeConversationDetails.move(to: project?.id, availableIDs: available) else { continue }
      await store.update(conversation, patch: patch)
      if store.conversations.first(where: { $0.id == conversation.id })?.projectId == project?.id { moved += 1 }
    }
    guard moved > 0 else { return }
    if let project {
      Snackbars.shared.toast(L("chat_moved_to_project_toast", project.name))
    } else {
      Snackbars.shared.toast(L("chat_removed_from_project_toast"))
    }
  }
}

/// The project picker sheet (`AllChatsListBottomSheetDestination.SelectProject`): a search
/// field "Search projects" over the account's projects; picking one calls `pick`.
struct ProjectPickerSheet: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  let current: String?
  var allowsRemoval = false
  let pick: (Project?) -> Void
  @State private var query = ""
  private var projects: [Project] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return (store.snapshot?.projects ?? []).filter { needle.isEmpty || $0.name.localizedCaseInsensitiveContains(needle) }
  }
  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: current == nil ? L("chat_add_project") : L("chat_change_project"))
      ListSearchField(placeholder: L("project_picker_search_placeholder"), text: $query)
      ScrollView {
        LazyVStack(spacing: 0) {
          if allowsRemoval {
            SheetActionRow(L("chat_remove_from_project"), icon: .projectsX) {
              pick(nil)
              dismiss()
            }
          }
          ForEach(projects) { project in
            Button {
              pick(project)
              dismiss()
            } label: {
              HStack(spacing: 12) {
                AppGlyphView(.projects).foregroundStyle(Palette.textSecondary)
                Text(project.name).typeStyle(.body).foregroundStyle(Palette.textPrimary).lineLimit(1)
                  .frame(maxWidth: .infinity, alignment: .leading)
                if project.id == current { AppGlyphView(.check, size: 20).foregroundStyle(Palette.text100) }
              }
              .padding(.horizontal, 20).padding(.vertical, 12).frame(minHeight: 48).contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
            .disabled(project.id == current)
          }
          if projects.isEmpty {
            OfficialEmptyState(
              icon: query.isEmpty ? .projects : .searchCircle,
              text: query.isEmpty ? L("empty_state_project_title") : L("empty_state_search_title", query),
              iconSize: 48
            ).padding(.top, 24)
          }
        }.padding(.bottom, 16)
      }
    }
    .claudeSheetChrome([.medium, .large])
  }
}
