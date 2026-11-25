import SwiftUI
import UIKit

struct ConversationHome: View {
  @EnvironmentObject private var store: AppStore
  var body: some View { ChatView(conversationID: store.chatSurfaceConversationID) }
}
/// The home (new chat) screen's empty state (shell-navigation.md §5.4): spark and serif greeting,
/// vertically centred; inside a project it names the project in clay.
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
  /// Approvals waiting here sit above the composer (`ApprovalRequestView`); a connector tool's is the
  /// sheet of code-voice-tools.md §3 that opens by itself, and once dismissed its "Waiting for you"
  /// row opens it again.
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
          Button { store.beginNewChat() } label: { AnthropiconView(.chatAddFilled) }
            .accessibilityLabel(L("chat_new_chat")).accessibilityIdentifier("top-bar-new-chat")
          Menu {
            if let conversation { ChatMenuItems(conversation: conversation, rename: { titleDraft = conversation.title; renaming = true },
                                                changeModel: { changingModel = true },
                                                move: { moving = true }, share: { share = true }, review: { reviewing = true },
                                                delete: { deleteConfirm = true }) }
          } label: {
            AnthropiconView(.dotsVertical)
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
          if let conversation, conversation.mode == .code {
            PullRequestOffer(conversation: conversation, review: { reviewing = true })
          }
          // Cowork is its own drawer destination (official IA), not a home composer switch.
          ComposerView()
          if conversationID == nil {
            Text(L("conversation_disclaimer_1")).typeStyle(.caption).foregroundStyle(Palette.text500)
              .multilineTextAlignment(.center)
          }
        }.padding(.horizontal, 16).padding(.bottom, 10)
      }

      // Official chat dialogs (lists-projects.md §3.4–3.5) as native alerts.
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
    else if store.chatPath.isEmpty {
      store.activeConversationID = nil
      store.mode = .chat
    }

  }
}

private func pullReviewKey(_ review: PullReview) -> String {
  switch review {
  case .none: return "ccr_pr_review_none"
  case .approved: return "ccr_pr_review_approved"
  case .changes: return "ccr_pr_review_changes"
  case .required: return "ccr_pr_review_required"
  }
}

private func mergeHoldKey(_ hold: MergeHold) -> String {
  switch hold {
  case .conflicts: return "ccr_pr_conflicts"
  case .blocked: return "ccr_pr_blocked"
  case .behind: return "ccr_pr_behind"
  case .draft: return "ccr_pr_draft"
  case .queued: return "ccr_pr_queued"
  case .checking: return "ccr_pr_checking"
  }
}

private func ciChipKey(_ chip: CiChip) -> String {
  switch chip {
  case .pending: return "ccr_ci_pending"
  case .passed: return "ccr_ci_passed"
  case .failed: return "ccr_ci_failed"
  case .unavailable: return "ccr_ci_unavailable"
  }
}

/// The code session's branch row: a branch that is still on the computer, and the button that asks for a pull request.
private struct PullRequestOffer: View {
  @EnvironmentObject private var store: AppStore
  let conversation: Conversation
  let review: () -> Void
  @State private var offer: BranchOffer?
  @State private var chip: CiChip?
  @State private var hold: MergeHold?
  @State private var verdict: PullReview?
  @State private var noChecks = false
  @State private var pullFailed = false
  @State private var readyFailed = false
  @State private var draft = false
  var body: some View {
    let running = conversation.isRunning || store.isSending
    let page = pullRequestUrl(conversation.latestPullRequestKey)
    let canCreate = offer.map { offersPullRequest($0, running: running) } ?? false
    let visible = page != nil || chip != nil || hold != nil || verdict != nil || noChecks || pullFailed || draft || (offer.map { canCreate || !$0.pushed || $0.dirty } ?? false)
    VStack(alignment: .leading, spacing: 4) {
      if let page, let url = URL(string: page), let mark = pullRequestMark(conversation.latestPullRequestKey) {
        Button { UIApplication.shared.open(url) } label: {
          Text(L("ccr_pr_chip", mark)).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("ccr_pr_open"))
        .contextMenu { Button(L("ccr_pr_copy")) { UIPasteboard.general.string = mark } }
      }
      if let chip {
        Text(L("ccr_ci")).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
          .accessibilityLabel(L(ciChipKey(chip)))
      }
      if noChecks {
        Text(L("ccr_pr_no_checks")).typeStyle(.caption).foregroundStyle(Palette.text500)
      }
      if let hold {
        Text(L(mergeHoldKey(hold))).typeStyle(.caption).foregroundStyle(Palette.text500)
      }
      if let verdict {
        Text(L(pullReviewKey(verdict))).typeStyle(.caption).foregroundStyle(Palette.text500)
      }
      if pullFailed {
        Text(L("ccr_pr_load_failed")).typeStyle(.caption).foregroundStyle(Palette.text500)
      }
      if draft, let identity = pullRequestIdentity(conversation.latestPullRequestKey) {
        Button {
          Task {
            guard let direct = store.direct else { return }
            let answer = try? await direct.request("api/v1/claudex/web/github/pull/action", method: "POST", body: .object([
              "repo": .string(identity.repository), "number": .number(Double(identity.number)), "action": .string("ready"),
            ]))
            if answer?["ok"].bool == true { draft = false; readyFailed = false } else { readyFailed = true }
          }
        } label: {
          Text(L("session_filter_ready_for_review")).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
            .frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain)
      }
      if readyFailed {
        Text(L("ccr_pr_ready_failed")).typeStyle(.caption).foregroundStyle(Palette.text500)
      }
      if let offer, !offer.pushed {
        Text(L("ccr_pr_local")).typeStyle(.caption).foregroundStyle(Palette.text500)
      }
      if let offer, offer.dirty {
        Button(action: review) {
          Text(L("ccr_pr_local_changes")).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
            .frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain)
      }
      if let offer, canCreate {
        Button {
          let prompt = createPrPrompt(offer)
          Task { _ = await store.sendArtifactComment(conversation, text: prompt) }
        } label: {
          Text(L(offer.pushed ? "ccr_pr_create" : "ccr_pr_push")).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L(offer.pushed ? "ccr_pr_create" : "ccr_pr_push_a11y"))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .opacity(visible ? 1 : 0)
    .accessibilityHidden(!visible)
    .task(id: "\(conversation.id)|\(conversation.updatedAt)") { await load() }
    .task(id: conversation.latestPullRequestKey ?? "") { await loadPull() }
  }
  private func loadPull() async {
    draft = conversation.latestPullRequestState == "draft"
    guard let identity = pullRequestIdentity(conversation.latestPullRequestKey), let direct = store.direct else { chip = nil; hold = nil; verdict = nil; noChecks = false; pullFailed = false; return }
    do {
      let result = try await direct.request("api/v1/claudex/web/github/pull", query: ["repo": identity.repository, "number": String(identity.number)])
      let state = result["state"].string
      pullFailed = false
      chip = ciChip(checks: result["checks"].string, state: state)
      noChecks = noChecksReported(checks: result["checks"].string, state: state)
      hold = mergeHold(state: state, conflicting: result["conflicting"].bool == true, mergeState: result["merge_state"].string)
      verdict = pullReview(result["review"].string)
      if let state { draft = state == "draft" }
    } catch {
      if !Task.isCancelled { chip = nil; hold = nil; verdict = nil; noChecks = false; pullFailed = true }
    }
  }
  private func load() async {
    guard let remote = store.remote else { offer = nil; return }
    let cloud = conversation.extensionFields["environment"]?["kind"].string == "space"
    let cwd = conversation.extensionFields["cwd"]?.string
    do {
      let result = try await remote.rpc.call("codeGitStatus", args: [.string(conversation.id)], as: JSONValue.self)
      let ahead = result["ahead"].integer ?? Int(result["ahead"].number ?? 0)
      offer = branchOffer(state: result["state"].string, branch: result["branch"].string, repository: result["repository"].string, baseBranch: result["baseBranch"].string, cwd: cwd, cloud: cloud, pushed: result["pushed"].bool == true, dirty: result["dirty"].bool == true, ahead: ahead)
    } catch {
      if !Task.isCancelled { offer = nil }
    }
  }
}

private func conversationArtifacts(_ conversation: Conversation) -> [LibraryArtifact] {
  conversation.turns.flatMap { turn in
    turn.items.flatMap { ArtifactIndex.fencedArtifacts($0, conversation: conversation).map(LibraryArtifact.init) }
  }
}

private func conversationFiles(_ conversation: Conversation) -> [GeneratedFile] {
  ArtifactIndex.latestGeneratedFiles(conversation).filter(\.isReady)
}

@ViewBuilder private func artifactDestination(_ artifact: LibraryArtifact) -> some View {
  if let file = artifact.generatedFile, file.blob == true { GeneratedFileDetailView(file: file) }
  else { ArtifactPreviewView(artifact: artifact) }
}

private enum OutputRow: Identifiable {
  case artifact(LibraryArtifact)
  case file(GeneratedFile)
  var id: String {
    switch self {
    case .artifact(let artifact): return "a:" + artifact.id
    case .file(let file): return "f:" + file.id
    }
  }
  var title: String {
    switch self {
    case .artifact(let artifact): return artifact.name
    case .file(let file): return file.name
    }
  }
}

private func outputRows(_ conversation: Conversation) -> [OutputRow] {
  conversationArtifacts(conversation).map(OutputRow.artifact) + conversationFiles(conversation).map(OutputRow.file)
}

@ViewBuilder private func outputDestination(_ row: OutputRow) -> some View {
  switch row {
  case .artifact(let artifact): artifactDestination(artifact)
  case .file(let file): GeneratedFileDetailView(file: file)
  }
}

/// The file mark beside +. One output opens itself; more open the sheet. The spoken name follows the selected tab.
struct ConversationOutputsButton: View {
  let conversation: Conversation
  @State private var showing = false
  @State private var tab = 0
  var body: some View {
    let rows = outputRows(conversation)
    if !rows.isEmpty {
      let label = tab == 2 ? L("ccr_outputs_activity") : L10n.plural(tab == 1 ? "ccr_outputs_view_file" : "ccr_outputs_view_artifact", count: rows.count)
      let mark = OutputsMark(icon: tab == 2 ? .listBullet : .file, label: label)
      Group {
        if rows.count == 1, let row = rows.first {
          NavigationLink { outputDestination(row) } label: { mark }.buttonStyle(IconPressStyle())
        } else {
          Button { showing = true } label: { mark }.buttonStyle(IconPressStyle())
        }
      }
      .sheet(isPresented: $showing) { ConversationOutputsSheet(rows: rows, tab: $tab) }
    }
  }
}

private struct OutputsMark: View {
  let icon: Anthropicon
  let label: String
  var body: some View {
    ZStack {
      Circle().fill(Palette.tileFill)
      AnthropiconView(icon, size: 20).foregroundStyle(Palette.text100)
    }
    .frame(width: 36, height: 36).frame(width: 48, height: 48).contentShape(Circle())
    .accessibilityLabel(label)
  }
}

private struct ConversationOutputsSheet: View {
  let rows: [OutputRow]
  @Binding var tab: Int
  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 0) {
        Picker("", selection: $tab) {
          Text(L("ccr_files_tab_artifacts")).tag(0)
          Text(L("ccr_files_tab_files")).tag(1)
          Text(L("ccr_files_tab_activity")).tag(2)
        }.pickerStyle(.segmented).padding(16)
        if tab == 2 || rows.isEmpty {
          Text(L("ccr_files_empty")).typeStyle(.body).foregroundStyle(Palette.text500).padding(20)
          Spacer()
        } else {
          List(rows) { row in
            NavigationLink { outputDestination(row) } label: {
              Text(row.title.isEmpty ? L("generic_untitled") : row.title).typeStyle(.body)
            }
          }
        }
      }
      .navigationTitle(tab == 1 ? L("ccr_files_tab_files") : tab == 2 ? L("ccr_files_tab_activity") : L("ccr_files_tab_artifacts"))
      .navigationBarTitleDisplayMode(.inline)
      .background(Palette.bg100)
    }
  }
}

