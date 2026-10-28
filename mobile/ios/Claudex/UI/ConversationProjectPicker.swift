import SwiftUI

/// "Add to project" / "Change project" for one chat: the official project picker sheet; the
/// move is confirmed by the service before the "Moved to …" toast.
struct ConversationProjectPicker: View {
    @EnvironmentObject private var store: AppStore
    let conversationID: String
    @State private var context: UUID?
    @State private var query = ""
    private var conversation: Conversation? { store.conversations.first { $0.id == conversationID } }
    private var projects: [Project] {
        let all = store.snapshot?.projects ?? []
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(text) }
    }
    var body: some View {
        ProjectPickerSheet(current: conversation?.projectId, allowsRemoval: conversation?.projectId != nil) { project in
            Task { await move(project) }
        }
        .task { context = store.accountGeneration }
    }
    private func move(_ project: Project?) async {
        guard context == store.accountGeneration, let conversation, !conversation.isRunning else { return }
        do {
            let patch = try NativeConversationDetails.move(to: project?.id, availableIDs: Set((store.snapshot?.projects ?? []).map(\.id)))
            await store.update(conversation, patch: patch)
            guard context == store.accountGeneration,
                  store.conversations.first(where: { $0.id == conversationID })?.projectId == project?.id else { return }
            Snackbars.shared.toast(project.map { L("chat_moved_to_project_toast", $0.name) } ?? L("chat_removed_from_project_toast"))
        } catch { store.errorMessage = error.localizedDescription }
    }
}
