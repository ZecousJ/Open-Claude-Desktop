import SwiftUI

// Code (strings-feature-map.md §3.14, code-voice-tools.md §4) and Cowork (§3.15).

/// The Code screen: the Devices row (the account's computers, remote desktop Code), then the
/// account's cloud Code sessions with the official filters; "New session" starts one on a
/// GitHub repository.
/// The session filters' words and menu glyphs (Android `bnx.l` / `bnx.k`: filter, spinner, warningFilled, prOpen,
/// check, archive); which sessions each one holds is the Core's `SessionList`.
extension SessionFilter {
  var title: String {
    switch self {
    case .all: L("session_filter_all")
    case .working: L("session_filter_working")
    case .needsInput: L("session_filter_needs_input")
    case .readyForReview: L("session_filter_ready_for_review")
    case .completed: L("session_filter_completed")
    case .archived: L("session_filter_archived")
    }
  }
  var icon: Anthropicon {
    switch self {
    case .all: .filter
    case .working: .spinner
    case .needsInput: .warningFilled
    case .readyForReview: .prOpen
    case .completed: .check
    case .archived: .archive
    }
  }
}

struct CodeWorkspaceView: View {
  @EnvironmentObject private var store: AppStore
  @State private var filter: SessionFilter = .all
  @State private var group: SessionGroup = .none
  @State private var newSession = false
  @State private var search = ""
  @State private var selecting = false
  @State private var selection: Set<String> = []
  @State private var deletingSelection = false
  @State private var deletingBusy = false
  @State private var movingSelection = false
  @State private var actedID: String?
  @State private var renaming = false
  @State private var titleDraft = ""
  @State private var changingModel = false
  @State private var moving = false
  @State private var sharing = false
  @State private var reviewing = false
  @State private var deleteConfirm = false
  /// Sessions that wait for an answer (an approval is open).
  private var waiting: Set<String> {
    Set((store.snapshot?.approvals ?? []).compactMap { $0["conversationId"].string })
  }
  private var needle: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var sessions: [Conversation] {
    let waiting = waiting, review = store.reviewReady
    return store.conversations.filter { conversation in
      guard conversation.mode == .code else { return false }
      if !needle.isEmpty, !conversation.matchesSessionSearch(needle) { return false }
      return SessionList.matches(filter, conversation, waiting: waiting, review: review)
    }.sorted { $0.updatedAt > $1.updatedAt }
  }
  /// The sessions whose pull request is asked about again when it changes (a new request, a turn that finished).
  private var askedAbout: [String] { SessionReviewPolicy.candidates(store.conversations).map { $0.id + $0.ref.key } }
  private var allArchived: Bool {
    let code = store.conversations.filter { $0.mode == .code }
    return !code.isEmpty && code.allSatisfy(\.archived)
  }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        DeviceSection(devices: store.devices).padding(.bottom, 8)
        ListSearchField(placeholder: L("session_list_search_placeholder"), text: $search)
          .accessibilityLabel(L("session_list_search_a11y"))
        Text(L("session_list_sessions_header")).typeStyle(.body).foregroundStyle(Palette.text300)
          .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
        if sessions.isEmpty {
          emptyState.padding(.top, 32)
        }
        ForEach(SessionList.sections(sessions, group: group, waiting: waiting, review: store.reviewReady)) { section in
          if group != .none {
            Text(section.literal ?? L(section.titleKey ?? "session_group_idle")).typeStyle(.body).foregroundStyle(Palette.text300)
              .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
          }
          ForEach(section.rows) { conversation in
            sessionRow(conversation)
          }
        }
      }.padding(.bottom, 24)
    }
    .refreshable {
      await store.devices.loadDevices()
      await store.refresh()
      await store.loadReview(force: true)
    }
    .task(id: askedAbout) { await store.loadReview() }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("code_screen_title"), serif: false, subtitle: selecting ? L("chat_list_selected_count", selection.count) : nil)
    .toolbar {
      if selecting {
        ToolbarItem(placement: .topBarLeading) {
          ClaudeIconButton(.x, label: L("generic_button_close")) { endSelection() }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button { movingSelection = true } label: {
            HStack(spacing: 4) { AnthropiconView(.projects, size: 20); Text(L("chat_list_move_selected")).typeStyle(.bodyStrong) }
              .foregroundStyle(canMove ? Palette.text100 : Palette.text500)
          }.disabled(!canMove)
          ClaudeIconButton(.trash, label: L("chat_menu_delete"), tint: canDelete ? Palette.danger100 : Palette.text500) { deletingSelection = true }
            .disabled(!canDelete)
        }
      } else {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          ForEach(SessionFilter.allCases) { option in
            MenuItem(option.title, icon: option.icon, selected: filter == option) { filter = option }
          }
          Divider()
          Menu(L("session_group_by")) {
            ForEach(SessionGroup.allCases) { option in
              MenuItem(L(option.stringKey), selected: group == option) { group = option }
            }
          }
        } label: {
          HStack(spacing: 2) {
            AnthropiconView(.filter, size: 20)
            AnthropiconView(.caretDown, size: 16)
          }.foregroundStyle(Palette.text100).frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(filter == .all ? L("session_list_filter_sessions_a11y") : L("session_list_filter_change_a11y"))
        .accessibilityValue(filter.title)
      }
      // New session lives in the top bar and in the empty state, as on Android: the official list has no pinned button.
      ToolbarItem(placement: .topBarTrailing) {
        ClaudeIconButton(.chatAdd, label: L("new_session")) { newSession = true }
          .disabled(store.account == nil)
          .accessibilityIdentifier("start-repository-conversation")
      }
      }
    }
    .navigationDestination(isPresented: $newSession) { RepositoryConversationView() }
    .alert(L10n.plural("chat_list_delete_selected_title", count: selection.count), isPresented: $deletingSelection) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("chat_menu_delete"), role: .destructive) { Task { await deleteSelection() } }
    } message: { Text(L("delete_dialog_default_subtitle")) }
    .sheet(isPresented: $movingSelection) {
      ProjectPickerSheet(current: nil, allowsRemoval: selectedConversations.contains { $0.projectId != nil }) { project in
        Task { await moveSelection(to: project) }
      }
    }
    .modifier(SessionRowActions(store: store, actedID: $actedID, renaming: $renaming, titleDraft: $titleDraft, changingModel: $changingModel, moving: $moving, sharing: $sharing, reviewing: $reviewing, deleteConfirm: $deleteConfirm))
    .onAppear {
      store.activeConversationID = nil
      store.mode = .code
    }
  }
  private var selectedConversations: [Conversation] { sessions.filter { selection.contains($0.id) } }
  private var canMove: Bool { !selection.isEmpty && store.snapshot?.projects.isEmpty == false && !selectedConversations.contains(where: \.isRunning) }
  private var canDelete: Bool { !selection.isEmpty && !deletingBusy && !selectedConversations.contains(where: \.isRunning) }
  private func endSelection() { selecting = false; selection = [] }
  private func toggle(_ conversation: Conversation) {
    if selection.contains(conversation.id) { selection.remove(conversation.id) } else { selection.insert(conversation.id) }
  }
  @ViewBuilder private func sessionRow(_ conversation: Conversation) -> some View {
    let row = ChatListRow(conversation: conversation, selecting: selecting, selected: selection.contains(conversation.id))
    if selecting {
      Button { toggle(conversation) } label: { row }
        .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
        .accessibilityAddTraits(selection.contains(conversation.id) ? .isSelected : [])
    } else {
      NavigationLink { ChatView(conversationID: conversation.id) } label: { row }
        .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
        .simultaneousGesture(TapGesture().onEnded { store.activate(conversation) })
        .contextMenu {
          MenuItem(L("chat_list_select_multiple"), icon: .checklist) { selecting = true; selection = [conversation.id] }
          ChatMenuItems(conversation: conversation,
            rename: { actedID = conversation.id; titleDraft = conversation.title; renaming = true },
            changeModel: { actedID = conversation.id; changingModel = true },
            move: { actedID = conversation.id; moving = true },
            share: { actedID = conversation.id; sharing = true },
            review: { actedID = conversation.id; reviewing = true },
            delete: { actedID = conversation.id; deleteConfirm = true })
        }
        .accessibilityLabel(L("nav_drawer_code_session_row_description", conversation.title.isEmpty ? L("generic_untitled") : conversation.title))
    }
  }
  private func deleteSelection() async {
    deletingBusy = true
    defer { deletingBusy = false }
    for id in selection { await store.deleteConversation(id) }
    endSelection()
  }
  private func moveSelection(to project: Project?) async {
    let available = Set((store.snapshot?.projects ?? []).map(\.id))
    var moved = 0
    for conversation in selectedConversations where !conversation.isRunning {
      guard let patch = try? NativeConversationDetails.move(to: project?.id, availableIDs: available) else { continue }
      await store.update(conversation, patch: patch)
      if store.conversations.first(where: { $0.id == conversation.id })?.projectId == project?.id { moved += 1 }
    }
    endSelection()
    guard moved > 0 else { return }
    if let project { Snackbars.shared.toast(L("chat_moved_to_project_toast", project.name)) }
    else { Snackbars.shared.toast(L("chat_removed_from_project_toast")) }
  }

  @ViewBuilder private var emptyState: some View {
    if !needle.isEmpty {
      OfficialEmptyState(icon: .searchCircle, text: L("empty_state_search_title", needle))
    } else {
      filterEmptyState
    }
  }
  @ViewBuilder private var filterEmptyState: some View {
    switch filter {
    case .all where allArchived:
      OfficialEmptyState(icon: .archive, text: L("code_empty_all_sessions_archived_title"), subtitle: L("code_empty_all_sessions_archived_subtitle"))
    case .all:
      VStack(spacing: 16) {
        OfficialEmptyState(icon: .code, text: L("code_empty_start_first_session_title"), subtitle: L("code_empty_start_first_session_subtitle"))
        Button { newSession = true } label: {
          Label(L("new_session"), systemImage: Anthropicon.add.symbol).labelStyle(ClaudeButtonLabelStyle(iconSize: 20))
        }
        .claudeButton(.primary, size: .medium).disabled(store.account == nil)
      }
    default:
      OfficialEmptyState(icon: filter.icon, text: L("session_list_filter_empty"))
    }
  }
}

/// A new cloud Code session on a GitHub repository: repository, base branch and permission mode
/// rows (each opens its official sheet), then the composer once a repository is chosen.
struct RepositoryConversationView: View {
  @EnvironmentObject private var store: AppStore
  @State private var repositories = false
  @State private var permissions = false
  /// The Code starter (`uzr`): a chosen suggestion or "Something else…" swaps the composer for Start Session.
  @State private var starterChoice: String?
  private var repositoryName: String? {
    store.preparedRepository.map { $0.url.split(separator: "/").suffix(2).joined(separator: "/").replacingOccurrences(of: ".git", with: "") }
  }
  /// `code_starter_connect_own_repo`: in Claudex an environment is a repository, so the link opens the repository picker.
  private var ownRepositoryLink: some View {
    Button { repositories = true } label: {
      Text(L("code_starter_connect_own_repo")).typeStyle(.caption).foregroundStyle(Palette.text500).padding(.vertical, 14)
    }.buttonStyle(.plain).accessibilityIdentifier("code-starter-own-repo")
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        if store.availableModes.contains(.code) {
          CodeStarterView(name: store.account?.name, choice: $starterChoice, draft: $store.composerText, busy: store.isSending)
            .padding(.bottom, 12)
        }
        SettingsGroup {
          SettingsButton(
            icon: .github, title: L("code_project_repos_title"),
            subtitle: repositoryName ?? L("claudex_code_choose_repository"), identifier: "code-repository"
          ) { repositories = true }
          SettingsButton(
            icon: .branch, title: L("ccr_choose_base_branch"),
            subtitle: store.preparedRepository?.ref ?? L("claudex_code_branch_after_repository")
          ) { repositories = true }
          .disabled(store.preparedRepository == nil)
          SettingsButton(
            icon: PermissionModeSheet.icon(store.codePermissionForm.selected), title: L("chat_options_permission"),
            subtitle: store.codePermissionForm.selected.map(PermissionModeSheet.title) ?? L("generic_none")
          ) { permissions = true }
          .disabled(store.codePermissionForm.availability == .unavailable)
        }
        if !store.availableModes.contains(.code) {
          InlineNotice(text: L("code_unavailable_title")).padding(.horizontal, 12)
        }
      }.padding(.vertical, 12)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("new_session"), serif: false)
    .safeAreaInset(edge: .bottom) {
      // A repository is required (owner, 2026-10-07: no "不使用仓库").
      Group {
        if starterChoice != nil {
          // Start Session sends the chosen prompt; without a repository it asks for one first.
          VStack(spacing: 0) {
            Button {
              if store.preparedRepository == nil { repositories = true } else { store.send() }
            } label: {
              if store.isSending { ClaudeSpinner(size: .xSmall, color: Palette.oncolor100) } else { Text(L("code_starter_start_session")) }
            }
            .claudeButton(.primary, size: .large, fullWidth: true)
            .disabled(!CodeStarter.canStart(draft: store.composerText, choice: starterChoice) || store.isSending)
            .accessibilityIdentifier("code-starter-start")
            ownRepositoryLink
          }
        } else if store.preparedRepository == nil {
          VStack(spacing: 0) {
            Button(L("claudex_code_choose_repository")) { repositories = true }
              .claudeButton(.primary, size: .large, fullWidth: true)
            ownRepositoryLink
          }
        } else {
          ComposerView(placeholder: L("ccr_input_placeholder_chat_style_new_session"), mode: .code)
        }
      }.padding(.horizontal, 12).padding(.vertical, 8).background(Palette.bg100)
    }
    .sheet(isPresented: $repositories) { RepositoryPickerView() }
    .sheet(isPresented: $permissions) { PermissionModeSheet() }
    .onAppear {
      store.activeConversationID = nil
      store.mode = .code
      if !store.composerText.isEmpty && store.attachments.isEmpty && starterChoice == nil {
        starterChoice = CodeStarter.suggestions.first { $0.prompt == store.composerText }?.id ?? CodeStarter.other
      }
      if store.preparedRepository == nil { repositories = true }
    }
  }
}

/// Cowork (`CoworkRemote`): the account's Cowork tasks with the same filter menu as Code (the official list model is
/// one for sessions and tasks); the composer starts a new one. Empty states follow `kix.b`: no tasks is the title
/// alone, all archived points at the Archived filter, a filter with no match is "No tasks found." and the hand-off line.
struct CoworkView: View {
  @EnvironmentObject private var store: AppStore
  @State private var filter: SessionFilter = .all
  @State private var group: SessionGroup = .none
  @State private var actedID: String?
  @State private var renaming = false
  @State private var titleDraft = ""
  @State private var changingModel = false
  @State private var moving = false
  @State private var sharing = false
  @State private var reviewing = false
  @State private var deleteConfirm = false
  @State private var selecting = false
  @State private var selection: Set<String> = []
  @State private var deletingSelection = false
  @State private var deletingBusy = false
  @State private var movingSelection = false
  /// The first-use page stands in for the list until "Get started" is tapped once (the official `cowork_starter_seen`).
  @AppStorage("cowork_starter_seen") private var starterSeen = false
  private var waiting: Set<String> {
    Set((store.snapshot?.approvals ?? []).compactMap { $0["conversationId"].string })
  }
  private var tasks: [Conversation] {
    let waiting = waiting
    return store.conversations.filter { conversation in
      conversation.mode == .cowork && SessionList.matches(filter, conversation, waiting: waiting, review: [])
    }.sorted { $0.updatedAt > $1.updatedAt }
  }
  private var allArchived: Bool {
    let cowork = store.conversations.filter { $0.mode == .cowork }
    return !cowork.isEmpty && cowork.allSatisfy(\.archived)
  }
  var body: some View {
    if starterSeen { list } else { CoworkStarterView { starterSeen = true } }
  }
  private var list: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if tasks.isEmpty {
          if filter != .all {
            OfficialEmptyState(icon: .tasks, text: L("cowork_empty_no_tasks_found_title"), subtitle: L("cowork_empty_no_tasks_subtitle")).padding(.top, 96)
          } else if allArchived {
            OfficialEmptyState(
              icon: .archive, text: L("cowork_empty_all_tasks_archived_title"), subtitle: L("cowork_empty_all_tasks_archived_subtitle")
            ).padding(.top, 96)
          } else {
            OfficialEmptyState(icon: .tasks, text: L("cowork_empty_what_can_claude_tackle_title")).padding(.top, 96)
          }
        }
        ForEach(SessionList.sections(tasks, group: group, waiting: waiting, review: [])) { section in
          if group != .none {
            Text(section.literal ?? L(section.titleKey ?? "session_group_idle")).typeStyle(.body).foregroundStyle(Palette.text300)
              .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
          }
          ForEach(section.rows) { conversation in
            taskRow(conversation)
          }
        }
      }.padding(.vertical, 8)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .refreshable { await store.refresh() }
    .pageTitle(L("dramatic_shrimp_screen_title"), serif: false, subtitle: selecting ? L("chat_list_selected_count", selection.count) : nil)
    .toolbar {
      if selecting {
        ToolbarItem(placement: .topBarLeading) {
          ClaudeIconButton(.x, label: L("generic_button_close")) { endSelection() }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button { movingSelection = true } label: {
            HStack(spacing: 4) { AnthropiconView(.projects, size: 20); Text(L("chat_list_move_selected")).typeStyle(.bodyStrong) }
              .foregroundStyle(canMove ? Palette.text100 : Palette.text500)
          }.disabled(!canMove)
          ClaudeIconButton(.trash, label: L("chat_menu_delete"), tint: canDelete ? Palette.danger100 : Palette.text500) { deletingSelection = true }
            .disabled(!canDelete)
        }
      } else {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          ForEach(SessionList.coworkFilters) { option in
            MenuItem(option.title, icon: option.icon, selected: filter == option) { filter = option }
          }
          Divider()
          Menu(L("session_group_by")) {
            ForEach(SessionGroup.allCases) { option in
              MenuItem(L(option.stringKey), selected: group == option) { group = option }
            }
          }
        } label: {
          HStack(spacing: 2) {
            AnthropiconView(.filter, size: 20)
            AnthropiconView(.caretDown, size: 16)
          }.foregroundStyle(Palette.text100).frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(L("chat_list_filter_chats_a11y")).accessibilityValue(filter.title)
      }
      }
    }
    .safeAreaInset(edge: .bottom) {
      if !selecting {
      ComposerView(placeholder: L("cowork_empty_no_tasks_subtitle"), mode: .cowork)
        .padding(.horizontal, 12).padding(.bottom, 8).background(Palette.bg100)
      }
    }
    .modifier(SessionRowActions(store: store, actedID: $actedID, renaming: $renaming, titleDraft: $titleDraft, changingModel: $changingModel, moving: $moving, sharing: $sharing, reviewing: $reviewing, deleteConfirm: $deleteConfirm))
    .alert(L10n.plural("chat_list_delete_selected_title", count: selection.count), isPresented: $deletingSelection) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("chat_menu_delete"), role: .destructive) { Task { await deleteSelection() } }
    } message: { Text(L("delete_dialog_default_subtitle")) }
    .sheet(isPresented: $movingSelection) {
      ProjectPickerSheet(current: nil, allowsRemoval: tasks.filter { selection.contains($0.id) }.contains { $0.projectId != nil }) { project in
        Task { await moveSelection(to: project) }
      }
    }
    .onAppear {
      store.activeConversationID = nil
      store.mode = .cowork
    }
  }

  private var chosen: [Conversation] { tasks.filter { selection.contains($0.id) } }
  private var canMove: Bool { !selection.isEmpty && store.snapshot?.projects.isEmpty == false && !chosen.contains(where: \.isRunning) }
  private var canDelete: Bool { !selection.isEmpty && !deletingBusy && !chosen.contains(where: \.isRunning) }
  private func endSelection() { selecting = false; selection = [] }
  @ViewBuilder private func taskRow(_ conversation: Conversation) -> some View {
    let row = ChatListRow(conversation: conversation, selecting: selecting, selected: selection.contains(conversation.id))
    if selecting {
      Button { if selection.contains(conversation.id) { selection.remove(conversation.id) } else { selection.insert(conversation.id) } } label: { row }
        .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
    } else {
      NavigationLink { ChatView(conversationID: conversation.id) } label: { row }
        .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
        .simultaneousGesture(TapGesture().onEnded { store.activate(conversation) })
        .contextMenu {
          MenuItem(L("chat_list_select_multiple"), icon: .checklist) { selecting = true; selection = [conversation.id] }
          ChatMenuItems(conversation: conversation,
            rename: { actedID = conversation.id; titleDraft = conversation.title; renaming = true },
            changeModel: { actedID = conversation.id; changingModel = true },
            move: { actedID = conversation.id; moving = true },
            share: { actedID = conversation.id; sharing = true },
            review: { actedID = conversation.id; reviewing = true },
            delete: { actedID = conversation.id; deleteConfirm = true })
        }
        .accessibilityLabel(L("nav_drawer_cowork_session_row_description", conversation.title.isEmpty ? L("generic_untitled") : conversation.title))
    }
  }
  private func deleteSelection() async {
    deletingBusy = true
    defer { deletingBusy = false }
    for id in selection { await store.deleteConversation(id) }
    endSelection()
  }
  private func moveSelection(to project: Project?) async {
    let available = Set((store.snapshot?.projects ?? []).map(\.id))
    var moved = 0
    for conversation in chosen where !conversation.isRunning {
      guard let patch = try? NativeConversationDetails.move(to: project?.id, availableIDs: available) else { continue }
      await store.update(conversation, patch: patch)
      if store.conversations.first(where: { $0.id == conversation.id })?.projectId == project?.id { moved += 1 }
    }
    endSelection()
    guard moved > 0 else { return }
    if let project { Snackbars.shared.toast(L("chat_moved_to_project_toast", project.name)) }
    else { Snackbars.shared.toast(L("chat_removed_from_project_toast")) }
  }
}

/// A Cowork task's details (`ScheduleTaskDetails` pattern): status, activity timeline, output
/// tokens, the code changes, and open / stop.
struct BackgroundTaskDetailView: View {
  @EnvironmentObject private var store: AppStore
  let conversationID: String
  private var conversation: Conversation? { store.conversations.first { $0.id == conversationID } }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        if let conversation {
          SettingsGroup {
            SettingsRow(icon: .tasks, title: conversation.title.isEmpty ? L("generic_untitled") : conversation.title,
                        subtitle: statusTitle(conversation.turns.last?.status), subtitleLines: 2)
          }
          if let turn = conversation.turns.last {
            let activities = turn.items.filter { !["reasoning", "analysis"].contains($0.type) }
            SettingsGroup(L("claudex_task_activity")) {
              if activities.isEmpty {
                SettingsRow(title: L("claudex_task_no_activity"))
              }
              ForEach(activities, id: \.id) { item in
                let state = item.raw["status"].string
                SettingsRow(
                  icon: state == "completed" ? .checkCircleFilled : state == "inProgress" ? .progressQuarter : .dotsCircle,
                  title: item.summary, subtitle: state.map(statusTitle), subtitleLines: 1)
              }
            }
            if let count = turn.outputTokens {
              SettingsGroup {
                SettingsRow(icon: .chartLine, title: L("claudex_task_output_tokens")) {
                  Text(String(count)).typeStyle(.body).foregroundStyle(Palette.text300)
                }
              }
            }
            if let error = turn.error { InlineNotice(text: error, tone: .error).padding(.horizontal, 12) }
          }
          SettingsGroup {
            SettingsLink(icon: .code, title: L("ccr_diff_title")) { ReviewChangesView(conversation: conversation) }
            SettingsLink(icon: .chat, title: L("open")) { ChatView(conversationID: conversation.id) }
            if conversation.isRunning {
              SettingsButton(icon: .stopCircle, title: L("claudex_task_stop"), tint: Palette.danger100) {
                store.activate(conversation)
                Task { await store.stopGeneration(conversation) }
              }
            }
          }
        } else {
          OfficialEmptyState(icon: .tasks, text: L("chat_not_found_title"), subtitle: L("chat_not_found_message"))
            .padding(.top, 48)
        }
      }.padding(.vertical, 12)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .refreshable { await store.refresh() }
    .pageTitle(L("ccr_schedule_task_details_title"))
  }
}

func statusTitle(_ status: String?) -> String {
  switch status {
  case "inProgress": L("cds_list_row_status_working")
  case "completed": L("claudex_task_status_completed")
  case "failed": L("claudex_task_status_failed")
  case "interrupted": L("cds_list_row_status_failed")
  default: L("claudex_task_status_none")
  }
}

/// The Diff sheet (`DiffView`): the files the cloud task changed and each file's diff.
struct ReviewChangesView: View {
  @EnvironmentObject private var store: AppStore
  let conversation: Conversation
  @State private var working: [JSONValue] = []
  @State private var notice: DiffNotice = .loading
  @State private var selectedFile = 0
  @State private var context = 3
  @State private var counts: [String: Int] = [:]
  @State private var scopeBase: String?
  @State private var scopeSha: String?
  @State private var ends: DiffScopeEnds?
  @State private var commits: [DiffCommit] = []
  @State private var branches: [String]?
  @State private var scopeMenu = false
  @State private var branchMenu = false
  @State private var commitMenu = false
  private var loadKey: String { "\(context)|\(scopeBase ?? "")|\(scopeSha ?? "")" }
  private var turnChanges: [JSONValue] { conversation.turns.flatMap(\.items).flatMap(\.changes) }
  private var changes: [JSONValue] {
    switch notice {
    case .partial, .ready, .stale: return working
    case .editsOnly: return turnChanges
    default: return []
    }
  }
  private var current: JSONValue? {
    changes.indices.contains(selectedFile) ? changes[selectedFile] : changes.first
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        if let ends, notice == .ready || notice == .partial || notice == .empty || notice == .none || notice == .stale {
          Button { scopeMenu = true } label: {
            Text(L("ccr_diff_scope_range", ends.base, ends.head)).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
              .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 24).padding(.vertical, 8)
          }.buttonStyle(.plain)
        }
        if let note = diffNoticeText(notice), changes.isEmpty {
          OfficialEmptyState(icon: .code, text: note).padding(.top, 48)
        } else if !changes.isEmpty {
          if let note = diffNoticeText(notice) {
            VStack(alignment: .leading, spacing: 4) {
              Text(note).typeStyle(.caption).foregroundStyle(Palette.text300)
              if notice == .editsOnly {
                Text(L("ccr_diff_edits_twice")).typeStyle(.caption).foregroundStyle(Palette.text300)
              }
            }.padding(.horizontal, 24)
          }
          SettingsGroup {
            SettingsPickerRow(
              icon: .file, title: L10n.plural("claudex_diff_file_count", count: changes.count),
              options: changes.enumerated().map { PickerOption(value: $0.offset, title: $0.element["path"].string ?? "") },
              selection: $selectedFile)
          }
          if let current {
            let diff = current["diff"].string ?? ""
            let path = current["path"].string ?? ""
            if let count = counts[path], let expand = diffExpand(diff, lineCount: count), context < min(count, 10_000) {
              Button { context = min(count, 10_000) } label: {
                Text(L("ccr_diff_expand_lines", expand.hidden)).typeStyle(.caption).foregroundStyle(Palette.text300)
                  .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 12)
              }
              .buttonStyle(.plain)
              .accessibilityLabel(L(expand.way == .all ? "ccr_diff_expand_all" : expand.way == .up ? "ccr_diff_expand_up" : "ccr_diff_expand_down"))
            }
            DiffCodeView(diff: diff).padding(.horizontal, 12)
          }
        }
      }.padding(.vertical, 12)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("ccr_diff_title"))
    .task(id: loadKey) { await load() }
    .task(id: scopeMenu) { await loadBranches() }
    .refreshable { await load() }
    .sheet(isPresented: $scopeMenu) { diffScopeSheet }
    .sheet(isPresented: $branchMenu) { diffBranchSheet }
    .sheet(isPresented: $commitMenu) { diffCommitSheet }
  }
  private func load() async {
    guard conversation.mode == .code, let remote = store.remote else {
      notice = DiffListing.notice(loaded: true, failed: false, state: "ready", truncated: false, treeDiff: false, turnChanges: !turnChanges.isEmpty)
      ends = nil
      commits = []
      return
    }
    if working.isEmpty && ends == nil { notice = .loading }
    do {
      let askedCommit = scopeSha != nil
      var scope: [String: JSONValue] = ["kind": .string(askedCommit ? "commit" : "branch")]
      if let scopeBase { scope["base"] = .string(scopeBase) }
      if let scopeSha { scope["sha"] = .string(scopeSha) }
      let result = try await remote.rpc.call(
        "workingTreeChanges", args: [.string(conversation.id), .number(Double(context)), .object(scope)], as: JSONValue.self)
      let diff = result["diff"].string ?? ""
      working = diff.components(separatedBy: "diff --git ").filter { !$0.isEmpty }.map { block in
        let body = "diff --git " + block
        return .object([
          "path": .string(diffNewPath(body) ?? block.components(separatedBy: "\n").first ?? ""),
          "diff": .string(body),
        ])
      }
      counts = lineCounts(result["lineCounts"])
      ends = diffScopeEnds(base: result["base"].string, branch: result["branch"].string)
      commits = diffCommits(result["commits"])
      if askedCommit, result["scope"].string != "commit" { scopeSha = nil }
      let settled = DiffListing.notice(loaded: true, failed: false, state: result["state"].string, truncated: result["truncated"].bool == true, treeDiff: !working.isEmpty, turnChanges: !turnChanges.isEmpty)
      notice = diffSettledNotice(settled, narrowed: (!askedCommit && scopeBase != nil) || (askedCommit && scopeSha != nil))
    } catch {
      let hadListing = ends != nil || !working.isEmpty
      if !hadListing {
        counts = [:]
        ends = nil
        commits = []
      }
      notice = diffRefreshFailure(hadListing: hadListing, turnChanges: !turnChanges.isEmpty)
      store.validateSessionError(error)
    }
  }
  private func loadBranches() async {
    guard scopeMenu, let remote = store.remote else { return }
    do {
      let listed = try await remote.rpc.call("gitBranches", args: [.string(conversation.id)], as: JSONValue.self)
      branches = diffCompareBranches(listed.array?.compactMap(\.string) ?? [], checkedOut: ends?.head)
    } catch {
      if !Task.isCancelled { branches = nil }
    }
  }
  private var diffScopeSheet: some View {
    let selected = commits.first { $0.sha == scopeSha }
    return NavigationStack {
      List {
        Button { scopeSha = nil; scopeBase = nil; selectedFile = 0; scopeMenu = false } label: {
          SettingsRow(title: L("ccr_diff_all_changes"), subtitle: ends.map { L("ccr_diff_vs", $0.base) }, trailing: { if scopeSha == nil { AnthropiconView(.check).foregroundStyle(Palette.text500) } })
        }.buttonStyle(.plain)
        if branches != nil {
          Button { scopeMenu = false; branchMenu = true } label: {
            SettingsRow(title: L("ccr_diff_compare"), subtitle: ends?.base)
          }.buttonStyle(.plain)
        }
        if !commits.isEmpty {
          Button { scopeMenu = false; commitMenu = true } label: {
            SettingsRow(title: L("ccr_diff_commits"), subtitle: selected?.shortSha ?? L10n.plural("ccr_diff_commit_count", count: commits.count), trailing: { if selected != nil { AnthropiconView(.check).foregroundStyle(Palette.text500) } })
          }.buttonStyle(.plain)
        }
      }
      .navigationTitle(L("ccr_diff_title"))
      .navigationBarTitleDisplayMode(.inline)
    }
  }
  private var diffBranchSheet: some View {
    NavigationStack {
      List {
        if branches?.isEmpty != false {
          Text(L("ccr_diff_no_branches")).foregroundStyle(Palette.text300)
        } else {
          ForEach(branches ?? [], id: \.self) { name in
            Button { scopeBase = name; scopeSha = nil; selectedFile = 0; branchMenu = false } label: {
              SettingsRow(title: name, trailing: { if name == scopeBase { AnthropiconView(.check).foregroundStyle(Palette.text500) } })
            }.buttonStyle(.plain)
          }
        }
      }
      .navigationTitle(L("ccr_diff_compare"))
      .navigationBarTitleDisplayMode(.inline)
    }
  }
  private var diffCommitSheet: some View {
    NavigationStack {
      List {
        ForEach(commits, id: \.sha) { commit in
          let spoken = commit.subject.map { L("ccr_diff_commit_named", $0) } ?? L("ccr_diff_commit_unnamed", L("ccr_diff_no_message"), commit.shortSha)
          Button {
            if scopeBase == nil { scopeBase = ends?.base }
            scopeSha = commit.sha
            selectedFile = 0
            commitMenu = false
          } label: {
            SettingsRow(title: commit.shortSha, subtitle: commit.subject ?? L("ccr_diff_no_message"), trailing: { if commit.sha == scopeSha { AnthropiconView(.check).foregroundStyle(Palette.text500) } })
          }
          .buttonStyle(.plain)
          .accessibilityLabel(spoken)
        }
      }
      .navigationTitle(L("ccr_diff_commits"))
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

private func diffCommits(_ value: JSONValue) -> [DiffCommit] {
  guard let rows = value.array else { return [] }
  return rows.compactMap { row in
    let sha = row["sha"].string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    var short = row["shortSha"].string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if short.isEmpty { short = String(sha.prefix(7)) }
    guard !sha.isEmpty, !short.isEmpty else { return nil }
    return DiffCommit(sha: sha, shortSha: short, subject: diffCommitSubject(row["subject"].string))
  }
}

private func lineCounts(_ value: JSONValue) -> [String: Int] {
  guard let fields = value.object else { return [:] }
  var counts: [String: Int] = [:]
  for (key, item) in fields {
    if let count = item.integer { counts[key] = count }
    else if let count = item.number { counts[key] = Int(count) }
  }
  return counts
}

private func diffNoticeText(_ notice: DiffNotice) -> String? {
  switch notice {
  case .loading: return L("ccr_diff_loading")
  case .unavailable: return L("ccr_diff_unavailable")
  case .unable: return L("ccr_diff_unable")
  case .stale: return L("ccr_diff_stale")
  case .partial: return L("ccr_diff_partial")
  case .editsOnly: return L("ccr_diff_edits_only")
  case .tooMany: return L("ccr_diff_too_many")
  case .empty: return L("claudex_diff_empty")
  case .none: return L("ccr_diff_none")
  case .ready: return nil
  }
}

/// A unified diff in the code font: line numbers, added lines on the success tint, removed on the
/// danger tint.
struct DiffCodeView: View {
  let diff: String
  private var face: DiffFileFace { diffFileFace(diff) }
  var body: some View {
    let rows = presentDiffLines(diff)
    ScrollView(.horizontal) {
      VStack(alignment: .leading, spacing: 0) {
        if face.binary {
          Text(L("ccr_diff_binary")).typeStyle(.body).foregroundStyle(Palette.text300).padding(16)
        } else if face.hidden && face.renamedFrom == nil {
          Text(L("ccr_diff_hidden")).typeStyle(.body).foregroundStyle(Palette.text300).padding(16)
        } else {
          if let from = face.renamedFrom {
            Text(L("ccr_diff_renamed", from)).typeStyle(.caption).foregroundStyle(Palette.text300).padding(.horizontal, 10).padding(.top, 10)
          }
          if !face.hidden {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, line in
              HStack(alignment: .top, spacing: 12) {
                Text(line.after.map(String.init) ?? line.before.map(String.init) ?? "").foregroundStyle(Palette.text500).frame(width: 30, alignment: .trailing)
                Text(line.text.isEmpty ? " " : line.text).foregroundStyle(Palette.text100).textSelection(.enabled)
                  .frame(maxWidth: .infinity, alignment: .leading)
              }
              .typeStyle(.codeSmall).padding(.vertical, 2).padding(.horizontal, 10)
              .background(line.kind == "+" ? Palette.success900 : line.kind == "-" ? Palette.danger900 : .clear)
            }
          }
        }
      }.padding(.vertical, face.binary || (face.hidden && face.renamedFrom == nil) ? 0 : 10)
    }
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
  }
}

private struct PresentedDiffLine {
  let text: String
  let before: Int?
  let after: Int?
  let kind: Character
}

/// Line numbers follow the hunk headers. Headers and a missing-newline marker are not additions or removals.
private func presentDiffLines(_ diff: String) -> [PresentedDiffLine] {
  let hunk = try? NSRegularExpression(pattern: "^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@.*")
  var before = 0
  var after = 0
  var inHunk = false
  return diff.components(separatedBy: "\n").map { line in
    let range = NSRange(line.startIndex..., in: line)
    if let match = hunk?.firstMatch(in: line, range: range), match.numberOfRanges >= 3,
       let oldRange = Range(match.range(at: 1), in: line), let newRange = Range(match.range(at: 2), in: line),
       let old = Int(line[oldRange]), let new = Int(line[newRange]) {
      inHunk = true
      before = old
      after = new
      return PresentedDiffLine(text: line, before: nil, after: nil, kind: "@")
    }
    if line.hasPrefix("diff --git") { inHunk = false; return PresentedDiffLine(text: line, before: nil, after: nil, kind: "@") }
    if !inHunk || line.hasPrefix("\\ No newline") { return PresentedDiffLine(text: line, before: nil, after: nil, kind: "@") }
    if line.hasPrefix("+") { let row = PresentedDiffLine(text: line, before: nil, after: after, kind: "+"); after += 1; return row }
    if line.hasPrefix("-") { let row = PresentedDiffLine(text: line, before: before, after: nil, kind: "-"); before += 1; return row }
    if line.hasPrefix(" ") { let row = PresentedDiffLine(text: line, before: before, after: after, kind: " "); before += 1; after += 1; return row }
    return PresentedDiffLine(text: line, before: nil, after: nil, kind: "@")
  }
}

/// Rename, model, project, share, review and delete for a row's long-press menu.
private struct SessionRowActions: ViewModifier {
  let store: AppStore
  @Binding var actedID: String?
  @Binding var renaming: Bool
  @Binding var titleDraft: String
  @Binding var changingModel: Bool
  @Binding var moving: Bool
  @Binding var sharing: Bool
  @Binding var reviewing: Bool
  @Binding var deleteConfirm: Bool
  private var acted: Conversation? { store.conversations.first { $0.id == actedID } }

  func body(content: Content) -> some View {
    content
      .alert(acted?.mode == .code ? L("session_menu_delete_dialog_title") : L("chat_menu_delete_conversation_dialog_title"), isPresented: $deleteConfirm) {
        Button(L("generic_button_cancel"), role: .cancel) {}
        Button(L("chat_menu_delete"), role: .destructive) { Task { if let actedID { await store.deleteConversation(actedID) } } }
      } message: { Text(L("delete_dialog_default_subtitle")) }
      .alert(L("chat_menu_rename_dialog_title"), isPresented: $renaming) {
        TextField(L("generic_name_label"), text: $titleDraft)
        Button(L("generic_button_cancel"), role: .cancel) {}
        Button(L("chat_menu_rename")) {
          if let acted {
            do { let patch = try NativeConversationDetails.rename(titleDraft); Task { await store.update(acted, patch: patch) } }
            catch { store.errorMessage = error.localizedDescription }
          }
        }.disabled((try? NativeConversationDetails.rename(titleDraft)) == nil)
      }
      .claudeSheet(isPresented: $changingModel) { ModelSheet(mode: .code, conversation: acted) }
      .sheet(isPresented: $moving) { if let actedID { ConversationProjectPicker(conversationID: actedID).id(store.accountGeneration) } }
      .sheet(isPresented: $sharing) { if let acted { ShareConversationView(conversation: acted) } }
      .navigationDestination(isPresented: $reviewing) { if let acted { ReviewChangesView(conversation: acted) } }
  }
}
