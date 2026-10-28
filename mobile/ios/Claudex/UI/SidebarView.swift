import SwiftUI

/// Top-level destinations. The drawer lists the official ones (Chats, Projects, Code, Artifacts,
/// Scheduled, Cowork); API, service status and personalization are reached from Settings.
enum AppSection: String, CaseIterable, Identifiable {
  case chat, projects, code, library, cowork, schedules, api, status, personalization, settings
  var id: String { rawValue }
  var title: String {
    switch self {
    case .chat: L("nav_drawer_item_chats")
    case .projects: L("nav_drawer_section_header_projects")
    case .code: L("nav_drawer_item_code")
    case .library: L("product_name_artifacts")
    case .cowork: L("nav_drawer_item_dramatic_shrimp")
    case .schedules: L("nav_drawer_item_scheduled")
    case .api: "API"
    case .status: L("claudex_nav_status")
    case .personalization: L("claudex_nav_personalization")
    case .settings: L("title_settings")
    }
  }
  /// Official drawer icon.
  var icon: AppGlyph {
    switch self {
    case .chat: .chats
    case .projects: .projects
    case .code: .code
    case .library: .artifacts
    case .cowork: .tasks
    case .schedules: .clock
    case .api: .key
    case .status: .activity
    case .personalization: .filter
    case .settings: .settings
    }
  }
}

/// The official navigation drawer: logotype that starts a new chat, search, the destinations in official order,
/// Pinned (first five, then "Show all N") and Recents, "All chats", and the account bar with the "New chat" pill.
struct SidebarView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var searching = false
  @State private var query = ""
  @FocusState private var searchFocused: Bool
  @State private var pinnedExpanded = false
  @State private var renaming: Conversation?
  @State private var titleDraft = ""
  @State private var deleting: Conversation?
  @State private var moving: Conversation?

  private var visible: [Conversation] { store.conversations.filter { !$0.archived } }
  private var pinned: [Conversation] { visible.filter(\.pinned) }
  private var recents: [Conversation] { visible.filter { !$0.pinned } }
  private var results: [Conversation] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return [] }
    return store.conversations.filter {
      $0.title.localizedCaseInsensitiveContains(needle)
        || $0.turns.contains {
          $0.prompt.localizedCaseInsensitiveContains(needle)
            || $0.items.contains { $0.text?.localizedCaseInsensitiveContains(needle) == true }
        }
    }
  }
  private var destinations: [AppSection] {
    var items: [AppSection] = [.chat, .projects, .code, .library, .schedules]
    if store.availableModes.contains(.cowork) { items.append(.cowork) }
    return items
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        header
        if searching {
          searchSection
        } else {
          ForEach(destinations) { destinationRow($0) }
          if !visible.isEmpty { ClaudeDivider() }
          if !pinned.isEmpty {
            SectionHeader(title: L("section_header_pinned")).padding(.leading, 8)
            ForEach(pinnedExpanded ? pinned : Array(pinned.prefix(5))) { conversationRow($0) }
            if pinned.count > 5 { showAllToggle }
          }
          if !recents.isEmpty {
            SectionHeader(title: L("section_header_recents")).padding(.leading, 8)
            ForEach(recents) { conversationRow($0) }
          }
          if !visible.isEmpty { allChatsRow }
          if store.account != nil && visible.isEmpty {
            Text(L("empty_state_chat_title")).typeStyle(.body).foregroundStyle(Palette.text500)
              .padding(.horizontal, 24).padding(.vertical, 12)
          }
        }
      }
      .padding(.bottom, 16)
    }
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await store.refresh() }
    .safeAreaInset(edge: .bottom, spacing: 0) { accountBar }
    .foregroundStyle(Palette.text300)
    .background(Palette.bg200)
    .onChange(of: store.sidebarPresented) { _, open in
      if !open {
        searchFocused = false
        searching = false
        query = ""
      }
    }
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
    .sheet(item: $moving) { conversation in
      ConversationProjectPicker(conversationID: conversation.id).id(store.accountGeneration)
    }
  }

  // MARK: Header

  private var header: some View {
    HStack(spacing: 0) {
      Button { store.beginNewChat() } label: {
        // The Claudex flower before the name, as the Android drawer and the official
        // header (mark + logotype) show it.
        HStack(spacing: 8) {
          BrandMark(size: 24)
          Logotype()
        }.padding(12).contentShape(Rectangle())
      }
      .buttonStyle(RowPressStyle(radius: Radius.r10))
      .accessibilityLabel(L("chat_new_chat")).accessibilityIdentifier("sidebar-logo")
      Spacer(minLength: 8)
      ClaudeIconButton(searching ? .x : .search, label: searching ? L("generic_search_close") : L("generic_search")) {
        searching.toggle()
        query = ""
        searchFocused = searching
      }.accessibilityIdentifier("sidebar-search")
    }
    .padding(.horizontal, 12).padding(.vertical, 8)
  }

  @ViewBuilder private var searchSection: some View {
    SearchField(prompt: L("conversation_search"), text: $query, focus: $searchFocused)
      .padding(.horizontal, 16).padding(.bottom, 8)
    if query.trimmingCharacters(in: .whitespaces).isEmpty {
      EmptyView()
    } else if results.isEmpty {
      Text(L("empty_state_search_title", query)).typeStyle(.body).foregroundStyle(Palette.text500)
        .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(24)
    } else {
      ForEach(results) { conversationRow($0) }
    }
  }

  // MARK: Destinations

  private func isSelected(_ section: AppSection) -> Bool {
    if section == .chat { return store.section == .chat && store.chatPath.last == .history }
    return store.section == section
  }

  private func destinationRow(_ section: AppSection) -> some View {
    let selected = isSelected(section)
    return Button { select(section) } label: {
      HStack(spacing: 12) {
        AppGlyphView(section.icon)
        Text(section.title).typeStyle(.body).lineLimit(1)
        Spacer(minLength: 0)
      }
      .foregroundStyle(selected ? Palette.text300 : Palette.text500)
      .padding(.leading, 16).padding(.trailing, 24)
      .frame(minHeight: 56)
      .background(selected ? Palette.drawerSelected : .clear, in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 8)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("sidebar-" + section.rawValue)
  }

  private func select(_ section: AppSection) {
    if section == .chat {
      store.activeConversationID = nil
      store.section = .chat
      store.chatPath = [.history]
      store.sidebarPresented = false
      return
    }
    store.activeConversationID = nil
    store.chatPath = []
    store.section = section
    store.sidebarPresented = false
  }

  // MARK: Conversation rows

  private func isOpen(_ conversation: Conversation) -> Bool {
    store.section == .chat && store.chatPath.last == .conversation(conversation.id)
  }

  private func conversationRow(_ conversation: Conversation) -> some View {
    let selected = isOpen(conversation)
    let title = conversation.title.isEmpty ? L("generic_untitled") : conversation.title
    return VStack(spacing: 0) {
      Color.clear.frame(height: 4)
      Button {
        store.activate(conversation)
        store.section = .chat
        store.chatPath = [.conversation(conversation.id)]
        store.sidebarPresented = false
      } label: {
        HStack(spacing: 0) {
          statusMark(conversation)
          Text(title).typeStyle(.body).foregroundStyle(Palette.textPrimary).lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12).padding(.vertical, 11)
        .background(selected ? Palette.drawerSelected : .clear)
        .clipShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
      }
      .buttonStyle(RowPressStyle(radius: Radius.r10))
      .padding(.horizontal, 12)
      .contextMenu { rowMenu(conversation) }
      .accessibilityLabel(rowDescription(conversation, title: title))
      .accessibilityAddTraits(selected ? .isSelected : [])
    }
  }

  private func rowDescription(_ conversation: Conversation, title: String) -> String {
    switch conversation.mode {
    case .code: L("nav_drawer_code_session_row_description", title)
    case .cowork: L("nav_drawer_cowork_session_row_description", title)
    default: title
    }
  }

  /// Leading status mark: Working (spinner) or New (unread dot); quiet chats show none.
  @ViewBuilder private func statusMark(_ conversation: Conversation) -> some View {
    if conversation.isRunning {
      ClaudeSpinner(size: .icon, color: Palette.textSecondary).padding(.leading, 4).padding(.trailing, 16)
        .accessibilityLabel(L("cds_list_row_status_working"))
    } else if conversation.unread && !conversation.incognito {
      Circle().fill(Palette.accentMain100).frame(width: 8, height: 8).frame(width: 16, height: 16)
        .padding(.leading, 4).padding(.trailing, 16)
        .accessibilityLabel(L("cds_list_row_status_new"))
    }
  }

  @ViewBuilder private func rowMenu(_ conversation: Conversation) -> some View {
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
    }
    MenuItem(conversation.archived ? L("session_menu_unarchive") : L("session_menu_archive"), icon: .archive) {
      Task { await store.update(conversation, patch: .object(["archived": .bool(!conversation.archived)])) }
    }.disabled(conversation.isRunning)
    MenuItem(L("chat_delete"), icon: .trash, destructive: true) { deleting = conversation }
      .disabled(conversation.isRunning || store.conversationActions.contains(conversation.id))
  }

  private var showAllToggle: some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: 4)
      Button {
        pinnedExpanded.toggle()
      } label: {
        HStack(spacing: 8) {
          Text(pinnedExpanded ? L("nav_drawer_pinned_show_less") : L10n.plural("nav_drawer_pinned_show_all", count: pinned.count))
          AppGlyphView(pinnedExpanded ? .caretUp : .caretDown, size: 20)
        }
        .typeStyle(.body).foregroundStyle(Palette.text500).padding(12)
        .contentShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
      }
      .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
      Color.clear.frame(height: 8)
    }
  }

  private var allChatsRow: some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: 4)
      Button { select(.chat) } label: {
        HStack(spacing: 8) {
          Text(L("all_chats"))
          AppGlyphView(.caretRight, size: 20)
        }
        .typeStyle(.body).foregroundStyle(Palette.text500).padding(12)
        .contentShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
      }
      .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
      .accessibilityIdentifier("sidebar-all-chats")
    }
  }

  // MARK: Account bar

  private var accountBar: some View {
    let layout =
      dynamicTypeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(spacing: 12))
    let name = store.account?.name ?? ""
    return layout {
      Button {
        store.activeConversationID = nil
        store.chatPath = []
        store.section = .settings
        store.sidebarPresented = false
      } label: {
        HStack(spacing: 12) {
          ClaudeAvatar(name: name.isEmpty ? "?" : name, size: .account)
          VStack(alignment: .leading, spacing: 0) {
            Text(name.isEmpty ? L("title_settings") : name).typeStyle(.bodyStrong).foregroundStyle(Palette.text100)
              .lineLimit(1)
            if let email = store.account?.email, !email.isEmpty, email != name {
              Text(email).typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(1)
            }
          }
        }.contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(L("user_avatar_settings_content_description", name.isEmpty ? L("title_settings") : name))
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier("sidebar-account")
      if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
      Button { store.beginNewChat() } label: {
        HStack(spacing: 4) {
          AppGlyphView(.add, size: 20)
          Text(L("chat_new_chat")).typeStyle(.bodyStrong).lineLimit(1)
        }
        .foregroundStyle(Palette.bg000)
        .padding(.leading, 16).padding(.trailing, 24).frame(minHeight: 44)
        .background(Palette.text100, in: Capsule())
        .contentShape(Capsule())
      }
      .buttonStyle(.plain).fixedSize()
      .accessibilityIdentifier("sidebar-new-chat")
    }
    .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(alignment: .top) {
      // The bar sits over the list: solid drawer colour with a 44pt fade above it.
      ZStack(alignment: .top) {
        Palette.bg200
        LinearGradient(colors: [Palette.bg200.opacity(0), Palette.bg200], startPoint: .top, endPoint: .bottom)
          .frame(height: 44).offset(y: -44).allowsHitTesting(false)
      }.ignoresSafeArea(edges: .bottom)
    }
  }
}
