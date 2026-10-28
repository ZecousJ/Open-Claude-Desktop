import SwiftUI

/// Capabilities: the Memory group (switch rows, the memory documents, and Claudex's memory import as an extra row in
/// the same style) and Tool access (the account's AI-powered artifacts and inline visualizations). Web search is not
/// offered on mobile.
struct CapabilitiesView: View {
  @EnvironmentObject private var store: AppStore
  @State private var status: MemoryStatus?
  @State private var busy = false
  @State private var failed = false
  @State private var importing = false
  @State private var savingTools = false
  var body: some View {
    SettingsPage(title: L("capabilities_setting_title")) {
      if status == nil && busy {
        ListLoading()
      } else if status == nil && failed {
        OfficialErrorState(text: L("generic_error_something_went_wrong")) { Task { await load() } }
      }
      if let status {
        SettingsGroup(L("memory_title")) {
          SettingsToggleRow(
            title: L("memory_search_setting_title"), helper: L("memory_search_setting_description"),
            isOn: Binding(get: { status.prefs.searchChats }, set: { value in Task { await preference(searchChats: value) } })
          ).disabled(busy || !status.canChange || !status.allowed.searchChats)
          SettingsToggleRow(
            title: L("memory_setting_title"), helper: L("memory_setting_description"),
            isOn: Binding(get: { status.prefs.generate }, set: { value in Task { await preference(generate: value) } })
          ).disabled(busy || !status.canChange || !status.allowed.generate)
          if status.available || status.global != nil {
            SettingsLink(
              icon: .memory, title: L("memory_summary_button_title"),
              subtitle: lastUpdated(status) ?? L("memory_summary_button_description_null_state")
            ) { MemoryDocumentView(scope: .global, title: L("memory_summary_title")) }
            ForEach((store.snapshot?.projects ?? []).filter { UUID(uuidString: $0.id) != nil }) { project in
              SettingsLink(icon: .projects, title: project.name, subtitle: L("memory_files_native_row_description")) {
                MemoryDocumentView(scope: .project(project.id), title: L("memory_breadcrumb", project.name, L("memory_title")))
              }
            }
            SettingsButton(icon: .arrowInSquare, title: L("claudex_memory_import_title"), subtitle: L("claudex_memory_import_subtitle")) {
              importing = true
            }.disabled(!status.canChange)
          }
        }
        if !status.canChange {
          Text(memoryAvailability(status)).typeStyle(.caption).foregroundStyle(Palette.text300).padding(.horizontal, 24)
        }
      }
      SettingsGroup(L("settings_tool_access")) {
        SettingsToggleRow(
          icon: .artifacts, title: L("ai_artifacts_title"), helper: L("ai_artifacts_description"),
          isOn: tool("aiArtifacts", default: false))
        SettingsToggleRow(
          icon: .chart, title: L("inline_visualizations_title"), helper: L("inline_visualizations_description"),
          isOn: tool("inlineVisualizations", default: true))
      }.disabled(savingTools || store.account == nil)
    }
    .refreshable { await load() }
    .task { await load() }
    .sheet(isPresented: $importing) { MemoryImportSheet { Task { await load() } } }
  }
  private func tool(_ key: String, default value: Bool) -> Binding<Bool> {
    Binding(
      get: { settingsFlag(store, key, default: value) },
      set: { next in
        Task {
          savingTools = true
          _ = await saveSettingsFields([key: .bool(next)], store: store)
          savingTools = false
        }
      })
  }
  private func lastUpdated(_ status: MemoryStatus) -> String? {
    guard let at = status.lastRun?["at"].number ?? status.global?.updatedAt, at > 0 else { return nil }
    return L("memory_preview_last_updated", RelativeTime.string(ms: at, capitalized: false))
  }
  @MainActor private func load() async {
    guard !busy, store.account != nil else { return }
    busy = true
    defer { busy = false }
    do {
      status = try await store.accountRequest { try await $0.memoryStatus() }
      failed = false
    } catch is CancellationError {} catch {
      failed = true
      store.validateSessionError(error)
    }
  }
  @MainActor private func preference(searchChats: Bool? = nil, generate: Bool? = nil) async {
    guard !busy, status?.canChange == true else { return }
    busy = true
    defer { busy = false }
    do { status = try await store.accountRequest { try await $0.setMemoryPreference(searchChats: searchChats, generate: generate) } }
    catch is CancellationError {} catch {
      store.errorMessage = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}

/// Claudex's memory import: paste memory exported from another assistant, preview the merge
/// with the global memory, then save it. Nothing is saved before the preview is confirmed.
private struct MemoryImportSheet: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  let saved: () -> Void
  @State private var text = ""
  @State private var preview: JSONValue?
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: L("claudex_memory_import_title"))
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if let preview {
            Text(L("claudex_memory_import_preview")).typeStyle(.body).foregroundStyle(Palette.text300)
            Text(preview["merged"].string ?? "").typeStyle(.body).foregroundStyle(Palette.text100).textSelection(.enabled)
              .padding(12).frame(maxWidth: .infinity, alignment: .leading)
              .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
          } else {
            Text(L("claudex_memory_import_note")).typeStyle(.body).foregroundStyle(Palette.text300)
            DialogTextArea(placeholder: L("claudex_memory_import_placeholder"), text: $text, lines: 6...14)
          }
          if let error { InlineNotice(text: error, tone: .error) }
        }.padding(.horizontal, Spacing.sheetGutter).padding(.vertical, 12)
      }
      HStack(spacing: 8) {
        if preview != nil {
          Button(L("generic_back_button_content_description")) { preview = nil }
            .claudeButton(.secondary, size: .large, fullWidth: true).disabled(busy)
        }
        Button {
          Task { await (preview == nil ? makePreview() : save()) }
        } label: {
          if busy { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) } else {
            Text(preview == nil ? L("claudex_memory_import_preview_button") : L("generic_save"))
          }
        }
        .claudeButton(.primary, size: .large, fullWidth: true)
        .disabled(busy || (preview == nil && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
      }.padding(.horizontal, Spacing.sheetGutter).padding(.vertical, 16)
    }
    .background(Palette.bg100)
    .claudeSheetChrome([.large])
    .interactiveDismissDisabled(busy)
  }
  private func makePreview() async {
    busy = true
    error = nil
    defer { busy = false }
    do {
      let input = text
      preview = try await store.accountRequest { try await $0.rpc.call("previewMemoryImport", args: [.string(input)], as: JSONValue.self) }
    } catch is CancellationError {} catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
  private func save() async {
    guard let merged = preview?["merged"].string, let revision = preview?["revision"].integer else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      _ = try await store.accountRequest { try await $0.saveMemoryDocument(.global, content: merged, revision: revision) }
      Snackbars.shared.toast(L("memory_edit_result_updated"))
      saved()
      dismiss()
    } catch is CancellationError {} catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}

/// A memory document (global or a project's), as the official Manage memory shows it: the memory
/// itself read-only, a "Tell Claudex what to remember or forget" field with Submit edit (the service
/// adds it as an edit the next summary honours), the saved edits with Remove, and Reset memory.
struct MemoryDocumentView: View {
  @EnvironmentObject private var store: AppStore
  let scope: MemoryScope
  let title: String
  @State private var document: MemoryDocument?
  @State private var status: MemoryStatus?
  @State private var instruction = ""
  @State private var loaded = false
  @State private var busy = false
  @State private var updating = false
  /// How the last edit went (`memory_edit_result_*`), shown where "Updating memory…" was.
  @State private var result: String?
  @State private var error: String?
  @State private var resetting = false
  @State private var removing: MemoryEdit?
  private var canChange: Bool { status?.canChange == true }
  private var limit: Int { document?.editChars ?? 500 }
  var body: some View {
    SettingsPage(title: title) {
      if !loaded && busy { ListLoading() }
      if let error { InlineNotice(text: error, tone: .error).padding(.horizontal, 12) }
      if let status, !status.canChange {
        Text(memoryAvailability(status)).typeStyle(.caption).foregroundStyle(Palette.text300).padding(.horizontal, 24)
      }
      if loaded {
        VStack(alignment: .leading, spacing: 8) {
          if let content = document?.content, !content.isEmpty {
            Text(content).typeStyle(.body).foregroundStyle(Palette.text100).textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
          } else {
            Text(L("claudex_memory_empty")).typeStyle(.body).foregroundStyle(Palette.text500)
          }
          if let document {
            Text(L("memory_file_updated", Date(timeIntervalSince1970: document.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened)))
              .typeStyle(.caption).foregroundStyle(Palette.text500)
          }
        }.padding(.horizontal, 12)
        VStack(alignment: .leading, spacing: 8) {
          DialogTextArea(placeholder: L("memory_edit_placeholder_all"), text: $instruction, lines: 3...6)
            .disabled(busy || !canChange)
            .onChange(of: instruction) { _, value in result = nil; if value.count > limit { instruction = String(value.prefix(limit)) } }
          if updating { Text(L("memory_edit_updating")).typeStyle(.caption).foregroundStyle(Palette.text500) }
          else if let result { Text(result).typeStyle(.caption).foregroundStyle(Palette.text500) }
          Button(L("memory_edit_submit")) { Task { await submit() } }
            .claudeButton(.primary, size: .mediumLarge, fullWidth: true)
            .disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy || !canChange)
          Text(L("claudex_memory_privacy_note")).typeStyle(.caption).foregroundStyle(Palette.text500)
        }.padding(.horizontal, 12)
        if let edits = document?.edits, !edits.isEmpty {
          SettingsGroup(L("claudex_memory_remembered")) {
            ForEach(edits) { edit in
              SettingsRow(title: edit.text, subtitleLines: 3) {
                ClaudeIconButton(.x, label: L("claudex_memory_remove"), tint: Palette.text300, size: 20) { removing = edit }
                  .disabled(busy || !canChange)
              }
            }
          }
        }
        SettingsGroup {
          SettingsButton(icon: .trash, title: L("memory_reset_title"), tint: Palette.danger100) { resetting = true }
            .disabled(busy || !canChange)
        }
      }
    }
    .refreshable { await load() }
    .task { await load() }
    .alert(L("memory_reset_title"), isPresented: $resetting) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("memory_reset_title"), role: .destructive) { Task { await reset() } }
    } message: {
      Text(scope == .global ? L("memory_reset_description") : L("delete_dialog_default_subtitle"))
    }
    .alert(
      L("claudex_memory_remove_title"),
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    ) {
      Button(L("generic_button_cancel"), role: .cancel) { removing = nil }
      Button(L("claudex_memory_remove"), role: .destructive) {
        if let edit = removing { Task { await remove(edit) } }
        removing = nil
      }
    } message: {
      Text(removing?.text ?? "")
    }
  }
  @MainActor private func load() async {
    guard !busy else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      let result = try await store.accountRequest { remote in
        async let status = remote.memoryStatus()
        async let document = remote.memoryDocument(scope)
        return try await (status, document)
      }
      status = result.0
      document = result.1
      loaded = true
    } catch is CancellationError {} catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
  /// Sends the instruction; the field keeps it when the service refuses.
  @MainActor private func submit() async {
    let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !busy, loaded, canChange, !text.isEmpty else { return }
    busy = true
    updating = true
    error = nil
    defer { busy = false; updating = false }
    do {
      let change = try await store.accountRequest { try await $0.updateMemoryEdits(scope, add: text) }
      document = change.document
      // A refused edit stays in the field to be changed.
      if !change.outcome.refused { instruction = "" }
      result = MemoryEditLine.card(change.outcome)
    } catch is CancellationError {} catch {
      self.error = L("memory_edit_failed")
      store.validateSessionError(error)
    }
  }
  @MainActor private func reset() async { await mutate { remote in _ = try await remote.resetMemory(scope) } }
  @MainActor private func remove(_ edit: MemoryEdit) async {
    guard !busy, canChange else { return }
    busy = true
    error = nil
    do {
      let change = try await store.accountRequest { try await $0.updateMemoryEdits(scope, remove: [edit.id]) }
      busy = false
      Snackbars.shared.toast(MemoryEditLine.text(change.outcome))
      await load()
    } catch is CancellationError { busy = false } catch {
      busy = false
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
  @MainActor private func mutate(_ operation: (RemoteClaudexService) async throws -> Void) async {
    guard !busy, canChange else { return }
    busy = true
    error = nil
    do {
      try await store.accountRequest(operation)
      busy = false
      await load()
    } catch is CancellationError { busy = false } catch {
      busy = false
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}

/// The line that says how a Manage-memory change went, as the official app words it. More than three names are
/// counted ("4 memory files"); Claudex keeps statements where the original names memory files.
enum MemoryEditLine {
  static func text(_ outcome: MemoryEditOutcome) -> String {
    switch outcome.kind {
    case "added": return L("memory_edit_result_added")
    case "updated": return L("memory_edit_result_updated")
    case "noop": return L("memory_edit_result_noop")
    // The text field already stops at the length memory allows, so a too-long edit reads as a refusal.
    case "rejected", "too_long": return L("memory_edit_rejected")
    case "removed": return L("memory_edit_result_removed", names(outcome.removed))
    // Android's official strings have no "Added to memory, removed …"; an added and removed pair reads as an update.
    default:
      return outcome.removed.isEmpty ? L("memory_edit_result_updated") : L("memory_edit_result_updated_removed", names(outcome.removed))
    }
  }
  /// The result card: the line, then "Done." (the official card shows the model's text, or "Done." without one).
  static func card(_ outcome: MemoryEditOutcome) -> String {
    text(outcome) + (outcome.refused ? "" : "\n" + L("memory_edit_result_done"))
  }
  private static func names(_ removed: [String]) -> String {
    removed.count > 3 ? L10n.plural("memory_edit_many_files", count: removed.count) : ListFormatter.localizedString(byJoining: removed)
  }
}

func memoryAvailability(_ status: MemoryStatus) -> String {
  switch status.reason {
  case "policy": L("claudex_memory_unavailable_policy")
  case "server": L("claudex_memory_unavailable_server")
  case "offline": L("claudex_memory_unavailable_offline")
  case "unsupported": L("claudex_memory_unavailable_unsupported")
  default: L("claudex_memory_unavailable")
  }
}
