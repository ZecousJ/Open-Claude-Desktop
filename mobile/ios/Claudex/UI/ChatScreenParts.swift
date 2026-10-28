import SwiftUI

/// The chat top bar's "More options" menu, with the Claudex extras (Share, Archive, Review changes, Refresh) grouped
/// between the project items and Delete. A Code session has the official session menu: no Pin (only Unpin for one
/// already pinned), Copy branch (first, when the session has one), Copy session ID, and no Refresh.
struct ChatMenuItems: View {
  @EnvironmentObject private var store: AppStore
  let conversation: Conversation
  let rename: () -> Void
  let changeModel: () -> Void
  let move: () -> Void
  let share: () -> Void
  let review: () -> Void
  let delete: () -> Void
  private var hasProjects: Bool { !(store.snapshot?.projects ?? []).isEmpty }
  private var isCode: Bool { conversation.mode == .code }
  var body: some View {
    Section {
      // Copy branch comes first and only when the session has a branch.
      if isCode, let branch = conversation.branchName {
        MenuItem(L("session_menu_copy_branch"), icon: .copy) {
          UIPasteboard.general.string = branch
          Snackbars.shared.toast(L("ccr_branch_copied"))
        }
      }
      MenuItem(L("chat_rename"), icon: .edit, action: rename)
      // `session_menu_change_model`: the session's own model, used from its next message.
      if isCode { MenuItem(L("session_menu_change_model"), icon: .extendedThinking, action: changeModel) }
      if !isCode || conversation.pinned {
        MenuItem(conversation.pinned ? L("chat_unstar") : L("chat_star"), icon: conversation.pinned ? .pinSlash : .pin) {
          Task { await store.update(conversation, patch: .object(["pinned": .bool(!conversation.pinned)])) }
        }
      }
      if hasProjects {
        MenuItem(conversation.projectId == nil ? L("chat_add_project") : L("chat_change_project"), icon: .projects, action: move)
          .disabled(conversation.isRunning)
      }
      if conversation.projectId != nil {
        MenuItem(L("chat_remove_from_project"), icon: .projectsX) { Task { await removeFromProject() } }
          .disabled(conversation.isRunning)
      }
    }
    Section {
      MenuItem(L("generic_share"), icon: .share, action: share)
      MenuItem(conversation.archived ? L("session_menu_unarchive") : L("session_menu_archive"), icon: .archive) {
        Task { await store.update(conversation, patch: .object(["archived": .bool(!conversation.archived)])) }
      }.disabled(conversation.isRunning)
      if NativeConversationDetails.showsCodeChanges(conversation.mode) {
        MenuItem(L("claudex_chat_menu_review_changes"), icon: .code, action: review)
      }
      if isCode {
        MenuItem(L("session_menu_copy_session_id"), icon: .copy) {
          UIPasteboard.general.string = conversation.id
          Snackbars.shared.toast(L("ccr_session_id_copied"))
        }
      } else {
        MenuItem(L("claudex_chat_menu_refresh"), icon: .arrowClockwise) { Task { await store.refresh() } }
      }
    }
    MenuItem(L("chat_delete"), icon: .trash, destructive: true, action: delete)
      .disabled(conversation.isRunning || store.conversationActions.contains(conversation.id))
  }
  private func removeFromProject() async {
    guard let patch = try? NativeConversationDetails.move(to: nil, availableIDs: []) else { return }
    await store.update(conversation, patch: patch)
    if store.conversations.first(where: { $0.id == conversation.id })?.projectId == nil {
      Snackbars.shared.toast(L("chat_removed_from_project_toast"))
    }
  }
}

/// "Chat not found": chat icon, title and message, centred.
struct ChatNotFoundState: View {
  var body: some View {
    VStack(spacing: 12) {
      AppGlyphView(.chat, size: 32).foregroundStyle(Palette.text500)
      Text(L("chat_not_found_title")).typeStyle(.bodyLargeStrong).foregroundStyle(Palette.text100)
      Text(L("chat_not_found_message")).typeStyle(.body).foregroundStyle(Palette.text500)
        .multilineTextAlignment(.center)
    }
    .padding(.horizontal, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// The official notice card: 16pt corners, `bg100`, 1pt hairline, info icon, 15pt secondary text and a small
/// Secondary button.
struct TranscriptNoticeCard: View {
  let text: String
  var action: String?
  var run: () -> Void = {}
  var body: some View {
    HStack(spacing: 12) {
      AppGlyphView(.infoCircle, size: 20)
      Text(text).typeStyle(.body).frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
      if let action {
        Button(action, action: run).claudeButton(.secondary, size: .small)
      }
    }
    .foregroundStyle(Palette.text300)
    .padding(.leading, 16).padding(.trailing, 12).padding(.vertical, 6)
    .frame(minHeight: 48)
    .background(Palette.bg100, in: RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r16, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
  }
}

