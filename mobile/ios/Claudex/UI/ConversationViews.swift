import SwiftUI

struct ConversationHome: View {
  @EnvironmentObject private var store: AppStore
  var body: some View { ChatView(conversationID: store.chatSurfaceConversationID) }
}
/// The home (new chat) screen's empty state: spark and serif greeting, vertically centred; inside a project it names
/// the project in clay.
struct ConversationWelcome: View {
  @EnvironmentObject private var store: AppStore
  private var greeting: AttributedString {
    if let id = store.preparedProjectID, let project = store.snapshot?.projects.first(where: { $0.id == id }) {
      let marker = "\u{1}"
      let parts = L("chat_headline_project", marker).components(separatedBy: marker)
      var text = AttributedString(parts.first ?? "")
      var name = AttributedString(project.name)
      name.foregroundColor = Palette.clay
      text.append(name)
      if parts.count > 1 { text.append(AttributedString(parts[1])) }
      return text
    }
    return AttributedString(L("chat_headline_today"))
  }
  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        HomeGreeting(attributed: greeting)
          .frame(maxWidth: .infinity).frame(minHeight: geometry.size.height)
      }
      .scrollBounceBehavior(.basedOnSize)
    }
  }
}
struct ChatView: View {
  @EnvironmentObject private var store: AppStore
  let conversationID: String?
  private static let draft = Conversation(id: "local:draft", title: "", mode: .chat, providerId: "", model: "",
                                          pinned: false, archived: false, createdAt: 0, updatedAt: 0, turns: [])
  @State private var share = false
  @State private var deleteConfirm = false
  @State private var renaming = false
  @State private var changingModel = false
  @State private var titleDraft = ""
  @State private var moving = false
  @State private var reviewing = false
  /// Approvals waiting here sit above the composer (`ApprovalRequestView`); a connector tool's is the sheet of that
  /// opens by itself, and once dismissed its "Waiting for you" row opens it again.
  private var conversation: Conversation? { store.conversations.first { $0.id == conversationID } }
  private var approvals: [JSONValue] {
    guard let conversationID else { return [] }
    return (store.snapshot?.approvals ?? []).filter { $0["conversationId"].string == conversationID }
  }
  var body: some View {
    VStack(spacing: 0) {
      if let conversation {
        // Only a failure is shown; loading the full tool output is silent (no plumbing text).
        if conversation.slim == true, case .failed = store.transcriptLoads[conversation.id] {
          TranscriptNoticeCard(text: L("claudex_transcript_full_output_failed"), action: L("generic_retry")) {
            store.retryTranscript(conversation.id)
          }.padding(.horizontal, 20).padding(.top, 8)
            .accessibilityIdentifier("retry-full-transcript")
        }
      }
      // The transcript stays mounted under the new-chat greeting (an empty draft, no
      // spinner), as Android's ChatSurface does, so a first message shows at once
      // instead of waiting for the page to load.
      ZStack {
        if let shown = conversation ?? (conversationID == nil ? Self.draft : nil) {
          SharedConversationView(conversation: shown, quietLoading: conversation == nil)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        if conversation == nil {
          if conversationID == nil { ConversationWelcome() } else { ChatNotFoundState() }
        }
      }
    }.background(Palette.bg100)
      .navigationTitle(conversation?.title ?? (conversationID == nil ? "" : L("chat_list_screen_title"))).navigationBarTitleDisplayMode(.inline)
      .navigationBarBackButtonHidden(true).sidebarToolbar()
      .toolbar {
        ToolbarItemGroup(placement: .topBarTrailing) {
          if conversationID != nil {
          Button { store.beginNewChat() } label: { AppGlyphView(.chatAddFilled) }
            .accessibilityLabel(L("chat_new_chat")).accessibilityIdentifier("top-bar-new-chat")
          Menu {
            if let conversation { ChatMenuItems(conversation: conversation, rename: { titleDraft = conversation.title; renaming = true },
                                                changeModel: { changingModel = true },
                                                move: { moving = true }, share: { share = true }, review: { reviewing = true },
                                                delete: { deleteConfirm = true }) }
          } label: {
            AppGlyphView(.dotsVertical)
          }.accessibilityLabel(L("generic_button_more_options"))
          }
        }
      }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 4) {
          // Approvals and questions waiting in this chat sit above the composer, one official card each.
          if let conversation, !approvals.isEmpty {
            VStack(spacing: 8) {
              ForEach(Array(approvals.enumerated()), id: \.offset) { _, approval in
                ApprovalRequestView(approval: approval, conversation: conversation)
              }
            }.padding(.bottom, 4)
          }
          // Cowork is its own drawer destination (official IA), not a home composer switch.
          ComposerView()
          if conversationID == nil {
            Text(L("conversation_disclaimer_1")).typeStyle(.caption).foregroundStyle(Palette.text500)
              .multilineTextAlignment(.center)
          }
        }.padding(.horizontal, 16).padding(.bottom, 10)
      }

      // Official chat dialogs as native alerts.
      .alert(conversation?.mode == .code ? L("session_menu_delete_dialog_title") : L("chat_menu_delete_conversation_dialog_title"), isPresented: $deleteConfirm) {
        Button(L("generic_button_cancel"), role: .cancel) {}
        Button(L("chat_menu_delete"), role: .destructive) { Task { if let conversationID { await store.deleteConversation(conversationID) } } }
      } message: { Text(L("delete_dialog_default_subtitle")) }
      .alert(L("chat_menu_rename_dialog_title"), isPresented: $renaming) {
        TextField(L("generic_name_label"), text: $titleDraft)
        Button(L("generic_button_cancel"), role: .cancel) {}
        Button(L("chat_menu_rename")) {
          if let conversation {
            do { let patch = try NativeConversationDetails.rename(titleDraft); Task { await store.update(conversation, patch: patch) } }
            catch { store.errorMessage = error.localizedDescription }
          }
        }.disabled((try? NativeConversationDetails.rename(titleDraft)) == nil)
      }
      .claudeSheet(isPresented: $changingModel) { ModelSheet(mode: .code, conversation: conversation) }
      .sheet(isPresented: $moving) { if let conversationID { ConversationProjectPicker(conversationID: conversationID).id(store.accountGeneration) } }
      .sheet(isPresented: $share) { if let conversation { ShareConversationView(conversation: conversation) } }
      .navigationDestination(isPresented: $reviewing) { if let conversation { ReviewChangesView(conversation: conversation) } }
      .onAppear { activateVisibleConversation() }
      .onChange(of: conversationID) { _, _ in activateVisibleConversation() }
      .onDisappear { if let conversationID { store.deactivateConversation(conversationID) } }
  }
  private func activateVisibleConversation() {
    if let conversation { store.activate(conversation) }
    else if let conversationID { store.activeConversationID = conversationID }
    else if store.chatPath.isEmpty { store.activeConversationID = nil }

  }
}

