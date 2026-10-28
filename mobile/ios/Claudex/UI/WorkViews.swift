import SwiftUI

// Code and Cowork.

/// The Code screen: the Devices row (the account's computers, remote desktop Code), then the account's cloud Code
/// sessions with the official filters; "New session" starts one on a GitHub repository. The session filters' words
/// and menu glyphs; which sessions each one holds is the Core's `SessionList`.
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
  var icon: AppGlyph {
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
  @State private var newSession = false
  @State private var search = ""
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
        ForEach(sessions) { conversation in
          NavigationLink { ChatView(conversationID: conversation.id) } label: {
            ChatListRow(conversation: conversation)
          }
          .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
          .simultaneousGesture(TapGesture().onEnded { store.activate(conversation) })
          .contextMenu {
            NavigationLink { ReviewChangesView(conversation: conversation) } label: {
              Label(L("ccr_diff_title"), systemImage: AppGlyph.code.symbol)
            }
            MenuItem(conversation.archived ? L("session_menu_unarchive") : L("session_menu_archive"), icon: .archive) {
              Task { await store.update(conversation, patch: .object(["archived": .bool(!conversation.archived)])) }
            }.disabled(conversation.isRunning)
          }
          .accessibilityLabel(
            L("nav_drawer_code_session_row_description", conversation.title.isEmpty ? L("generic_untitled") : conversation.title))
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
    .pageTitle(L("code_screen_title"), serif: false)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          ForEach(SessionFilter.allCases) { option in
            MenuItem(option.title, icon: option.icon, selected: filter == option) { filter = option }
          }
        } label: {
          HStack(spacing: 2) {
            AppGlyphView(.filter, size: 20)
            AppGlyphView(.caretDown, size: 16)
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
    .navigationDestination(isPresented: $newSession) { RepositoryConversationView() }
    .onAppear {
      store.activeConversationID = nil
      store.mode = .code
    }
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
          Label(L("new_session"), systemImage: AppGlyph.add.symbol).labelStyle(ClaudeButtonLabelStyle(iconSize: 20))
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
  /// The Code starter: a chosen suggestion or "Something else…" swaps the composer for Start Session.
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
      if store.preparedRepository == nil { repositories = true }
    }
  }
}

/// Cowork (`CoworkRemote`): the account's Cowork tasks with the same filter menu as Code (the official list model is
/// one for sessions and tasks); the composer starts a new one. Empty states follow: no tasks is the title alone, all
/// archived points at the Archived filter, a filter with no match is "No tasks found." and the hand-off line.
struct CoworkView: View {
  @EnvironmentObject private var store: AppStore
  @State private var filter: SessionFilter = .all
  /// The first-use page stands in for the list until "Get started" is tapped once (the official `cowork_starter_seen`).
  @AppStorage("cowork_starter_seen") private var starterSeen = false
  private var tasks: [Conversation] {
    let waiting = Set((store.snapshot?.approvals ?? []).compactMap { $0["conversationId"].string })
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
        ForEach(tasks) { conversation in
          NavigationLink { ChatView(conversationID: conversation.id) } label: { ChatListRow(conversation: conversation) }
            .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
            .simultaneousGesture(TapGesture().onEnded { store.activate(conversation) })
            .contextMenu {
              NavigationLink { BackgroundTaskDetailView(conversationID: conversation.id) } label: {
                Label(L("ccr_schedule_task_details_title"), systemImage: AppGlyph.checklist.symbol)
              }
              MenuItem(L("session_menu_archive"), icon: .archive) {
                Task { await store.update(conversation, patch: .object(["archived": .bool(true)])) }
              }.disabled(conversation.isRunning)
            }
            .accessibilityLabel(
              L("nav_drawer_cowork_session_row_description", conversation.title.isEmpty ? L("generic_untitled") : conversation.title))
        }
      }.padding(.vertical, 8)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .refreshable { await store.refresh() }
    .pageTitle(L("dramatic_shrimp_screen_title"), serif: false)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          ForEach(SessionList.coworkFilters) { option in
            MenuItem(option.title, icon: option.icon, selected: filter == option) { filter = option }
          }
        } label: {
          HStack(spacing: 2) {
            AppGlyphView(.filter, size: 20)
            AppGlyphView(.caretDown, size: 16)
          }.foregroundStyle(Palette.text100).frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(L("chat_list_filter_chats_a11y")).accessibilityValue(filter.title)
      }
    }
    .safeAreaInset(edge: .bottom) {
      ComposerView(placeholder: L("cowork_empty_no_tasks_subtitle"), mode: .cowork)
        .padding(.horizontal, 12).padding(.bottom, 8).background(Palette.bg100)
    }
    .onAppear {
      store.activeConversationID = nil
      store.mode = .cowork
    }
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
                Task { await store.stopGeneration() }
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
  @State private var error: String?
  @State private var loading = false
  @State private var selectedFile = 0
  private var changes: [JSONValue] {
    working.isEmpty ? conversation.turns.flatMap(\.items).flatMap(\.changes) : working
  }
  private var current: JSONValue? {
    changes.indices.contains(selectedFile) ? changes[selectedFile] : changes.first
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        if loading && changes.isEmpty { ListLoading() }
        if let error { InlineNotice(text: error).padding(.horizontal, 12) }
        if changes.isEmpty && !loading {
          OfficialEmptyState(icon: .code, text: L("claudex_diff_empty")).padding(.top, 48)
        } else if !changes.isEmpty {
          SettingsGroup {
            SettingsPickerRow(
              icon: .file, title: L10n.plural("claudex_diff_file_count", count: changes.count),
              options: changes.enumerated().map { PickerOption(value: $0.offset, title: $0.element["path"].string ?? "") },
              selection: $selectedFile)
          }
          if let current { DiffCodeView(diff: current["diff"].string ?? "").padding(.horizontal, 12) }
        }
      }.padding(.vertical, 12)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("ccr_diff_title"))
    .task { await load() }
    .refreshable { await load() }
  }
  private func load() async {
    guard conversation.mode == .code, let remote = store.remote else { return }
    loading = true
    defer { loading = false }
    do {
      let result = try await remote.rpc.call(
        "workingTreeChanges", args: [.string(conversation.id), .number(3)], as: JSONValue.self)
      if result["state"].string != "ready" {
        error = result["state"].string == "not-git" ? L("claudex_diff_not_git") : L("claudex_diff_no_folder")
        return
      }
      let diff = result["diff"].string ?? ""
      working = diff.components(separatedBy: "diff --git ").filter { !$0.isEmpty }.map { block in
        .object([
          "path": .string(block.components(separatedBy: "\n").first ?? ""),
          "diff": .string("diff --git " + block),
        ])
      }
      error = result["truncated"].bool == true ? L("claudex_diff_truncated") : nil
    } catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}

/// A unified diff in the code font: line numbers, added lines on the success tint, removed on the
/// danger tint.
struct DiffCodeView: View {
  let diff: String
  var body: some View {
    ScrollView(.horizontal) {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { index, line in
          HStack(alignment: .top, spacing: 12) {
            Text(String(index + 1)).foregroundStyle(Palette.text500).frame(width: 30, alignment: .trailing)
            Text(line.isEmpty ? " " : line).foregroundStyle(Palette.text100).textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .typeStyle(.codeSmall).padding(.vertical, 2).padding(.horizontal, 10)
          .background(
            line.hasPrefix("+") && !line.hasPrefix("+++")
              ? Palette.success900
              : line.hasPrefix("-") && !line.hasPrefix("---") ? Palette.danger900 : .clear)
        }
      }.padding(.vertical, 10)
    }
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
  }
}
