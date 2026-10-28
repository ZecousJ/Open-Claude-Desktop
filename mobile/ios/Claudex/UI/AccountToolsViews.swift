import SwiftUI
import UIKit

/// Usage records (Claudex): each request's model, time, tokens and cost, filtered by date range
/// and model; listed in the Transactions row style.
struct UsageRecordsView: View {
  @EnvironmentObject private var store: AppStore
  @State private var records: UsageRecordPage?
  @State private var loading = false
  @State private var failed = false
  @State private var model = ""
  @State private var start = ""
  @State private var end = ""
  var body: some View {
    SettingsPage(title: L("claudex_usage_records_title")) {
      SettingsGroup(L("claudex_usage_records_filter")) {
        field(L("claudex_usage_records_start"), text: $start)
        field(L("claudex_usage_records_end"), text: $end)
        field(L("claudex_usage_records_model"), text: $model)
        SettingsButton(icon: .search, title: L("generic_search")) { Task { await load(page: 1) } }.disabled(loading)
      }
      if records == nil && loading {
        ListLoading()
      } else if records == nil && failed {
        OfficialErrorState(text: L("usage_load_error")) { Task { await load(page: 1) } }
      } else if records?.items.isEmpty == true {
        OfficialEmptyState(icon: .chartLine, text: L("usage_no_data_available"), iconSize: 48)
      }
      if let records, !records.items.isEmpty {
        SettingsGroup {
          ForEach(records.items) { record in
            SettingsRow(
              title: record.model.isEmpty ? L("artifact_default_title") : record.model,
              subtitle: [
                NativeDisplayTime.format(record.createdAt),
                L("claudex_usage_record_tokens", number(record.inputTokens), number(record.outputTokens), number(record.cacheTokens)),
                record.raw["duration_ms"].number.map { L("claudex_usage_record_duration", ($0 / 1000).formatted()) },
                record.raw["api_key"]["name"].string.flatMap { $0.isEmpty ? nil : L("claudex_usage_record_key", $0) },
              ].compactMap { $0 }.joined(separator: "\n"),
              subtitleLines: 4
            ) {
              VStack(alignment: .trailing, spacing: 2) {
                Text(cost(record.cost)).typeStyle(.body).foregroundStyle(Palette.text100)
                Text(cost(record.standardCost)).typeStyle(.caption).foregroundStyle(Palette.text500).strikethrough()
              }
            }
          }
        }
        HStack {
          Button(L("claudex_page_previous")) { Task { await load(page: records.page - 1) } }
            .claudeButton(.secondary, size: .small).disabled(loading || records.page <= 1)
          Spacer()
          Text("\(records.page) / \(records.pages)").typeStyle(.caption).foregroundStyle(Palette.text500)
          Spacer()
          Button(L("claudex_page_next")) { Task { await load(page: records.page + 1) } }
            .claudeButton(.secondary, size: .small).disabled(loading || records.page >= records.pages)
        }.padding(.horizontal, 12)
      }
    }
    .task { await load(page: 1) }
    .refreshable { await load(page: 1) }
  }
  private func field(_ title: String, text: Binding<String>) -> some View {
    SettingsRow(title: title) {
      TextField(text: text) { Text(L("claudex_optional")).foregroundStyle(Palette.text500) }
        .typeStyle(.body).foregroundStyle(Palette.text100).multilineTextAlignment(.trailing)
        .autocorrectionDisabled().textInputAutocapitalization(.never).frame(maxWidth: 160)
    }
  }
  private func number(_ value: Double?) -> String { value.flatMap { $0.isFinite ? $0.formatted() : nil } ?? "—" }
  private func cost(_ value: Double?) -> String {
    value.flatMap { $0.isFinite ? "$" + $0.formatted(.number.precision(.fractionLength(4))) : nil } ?? "—"
  }
  @MainActor private func load(page: Int) async {
    guard !loading else { return }
    loading = true
    let query = UsageRecordQuery(page: page, start: start.isEmpty ? nil : start, end: end.isEmpty ? nil : end, model: model)
    defer { loading = false }
    do {
      records = try await store.accountRequest { try await $0.usageRecords(query) }
      failed = false
    } catch is CancellationError {} catch {
      failed = true
      if records != nil { store.errorMessage = error.localizedDescription }
      store.validateSessionError(error)
    }
  }
}

/// API keys (Claudex): the Shared-links row pattern — name, "Created …", group and status, the
/// key masked until shown; the row menu shows, copies (expires from the clipboard after two
/// minutes) or deletes. "+" creates a key in a dialog.
struct APIKeysView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.scenePhase) private var scenePhase
  @State private var keys: [AccountAPIKey] = []
  @State private var groups: [APIGroup] = []
  @State private var busy = false
  @State private var loaded = false
  @State private var failed = false
  @State private var reveal: Set<Int> = []
  @State private var creating = false
  @State private var deleting: AccountAPIKey?
  @State private var loadedGeneration: UUID?
  var body: some View {
    SettingsPage(title: L("claudex_api_keys_title")) {
      if !loaded {
        ListLoading()
      } else if failed && keys.isEmpty {
        OfficialErrorState(text: L("generic_error_something_went_wrong")) { Task { await load() } }
      } else if keys.isEmpty {
        OfficialEmptyState(icon: .key, text: L("claudex_api_keys_empty"), iconSize: 48)
      } else {
        SettingsGroup {
          ForEach(keys) { key in
            SettingsRow(
              title: key.name,
              subtitle: [
                reveal.contains(key.id) ? key.key : key.masked,
                [key.groupName, status(key.status)].filter { !$0.isEmpty }.joined(separator: " · "),
                L("artifact_gallery_created", NativeDisplayTime.format(key.createdAt)),
              ].joined(separator: "\n"),
              subtitleLines: 3
            ) {
              Menu {
                MenuItem(reveal.contains(key.id) ? L("claudex_api_key_hide") : L("claudex_api_key_show"), icon: reveal.contains(key.id) ? .eyeSlash : .eye) {
                  if reveal.contains(key.id) { reveal.remove(key.id) } else { reveal.insert(key.id) }
                }
                MenuItem(L("generic_copy"), icon: .copy) {
                  UIPasteboard.general.setItems(
                    [[UIPasteboard.typeAutomatic: key.key]],
                    options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
                  Snackbars.shared.toast(L("generic_copied_toast"))
                }
                MenuItem(L("generic_button_delete"), icon: .trash, destructive: true) { deleting = key }
              } label: {
                AppGlyphView(.dotsHorizontal, size: 20).frame(width: 44, height: 44).contentShape(Rectangle())
              }
              .foregroundStyle(Palette.text300).disabled(busy)
              .accessibilityLabel(L("generic_button_more_options"))
            }
            .textSelection(.enabled)
          }
        }
        Text(L("claudex_api_keys_footer")).typeStyle(.caption).foregroundStyle(Palette.text300).padding(.horizontal, 24)
      }
    }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        ClaudeIconButton(.add, label: L("claudex_api_key_create")) { creating = true }
          .disabled(busy || groups.isEmpty)
      }
    }
    .task { await load() }
    .refreshable { await load() }
    .onDisappear {
      reveal = []
      deleting = nil
    }
    .onChange(of: scenePhase) { _, phase in if phase != .active { reveal = [] } }
    .claudeDialog(isPresented: $creating) {
      CreateKeyDialog(groups: groups) { name, group in await create(name: name, groupID: group) } close: { creating = false }
    }
    .alert(
      L("claudex_api_key_delete_title"),
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    ) {
      Button(L("generic_button_cancel"), role: .cancel) { deleting = nil }
      Button(L("generic_button_delete"), role: .destructive) {
        if let key = deleting { Task { await delete(key.id) } }
        deleting = nil
      }
    } message: {
      Text(L("claudex_api_key_delete_body"))
    }
  }
  private func status(_ value: String) -> String {
    let key = "claudex_api_key_status_" + value
    return L10n.catalog.has(key) ? L(key) : ""
  }
  @MainActor private func load() async {
    guard !busy else { return }
    busy = true
    reveal = []
    let epoch = store.accountGeneration
    defer {
      busy = false
      loaded = true
    }
    do {
      let available = try await store.accountRequest { try await $0.apiGroups() }
      let own = try await store.accountRequest { try await $0.apiKeys() }
      guard epoch == store.accountGeneration else { return }
      loadedGeneration = epoch
      groups = available.groups
      keys = own
      failed = false
    } catch is CancellationError {} catch {
      failed = true
      store.validateSessionError(error)
    }
  }
  @MainActor private func create(name: String, groupID: Int) async -> String? {
    guard !busy, loadedGeneration == store.accountGeneration else { return nil }
    busy = true
    defer { busy = false }
    do {
      let made = try await store.accountRequest { try await $0.createAPIKey(name: name, groupID: groupID) }
      keys.insert(made, at: 0)
      Snackbars.shared.toast(L("claudex_api_key_created"))
      return nil
    } catch is CancellationError { return nil } catch {
      store.validateSessionError(error)
      return error.localizedDescription
    }
  }
  @MainActor private func delete(_ id: Int) async {
    guard !busy, loadedGeneration == store.accountGeneration else { return }
    busy = true
    defer { busy = false }
    do {
      try await store.accountRequest { try await $0.deleteAPIKey(id) }
      keys.removeAll { $0.id == id }
      reveal.remove(id)
    } catch is CancellationError {} catch {
      store.errorMessage = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}

/// "Create key": the official text-field dialog with the name and the group picker.
private struct CreateKeyDialog: View {
  let groups: [APIGroup]
  let create: (String, Int) async -> String?
  let close: () -> Void
  @State private var name = ""
  @State private var groupID: Int?
  @State private var busy = false
  @State private var error: String?
  private var valid: Bool { groupID != nil && (try? APIKeyContract.validatedName(name)) != nil }
  var body: some View {
    FormDialogCard(title: L("claudex_api_key_create")) {
      ClaudeTextField(L("generic_name_label"), text: $name, shape: .rounded, identifier: "api-key-name")
        .textInputAutocapitalization(.never).autocorrectionDisabled()
      Menu {
        ForEach(groups) { group in
          MenuItem(group.name, selected: groupID == group.id) { groupID = group.id }
        }
      } label: {
        HStack {
          Text(groups.first { $0.id == groupID }?.name ?? L("claudex_api_key_group")).typeStyle(.body)
            .foregroundStyle(groupID == nil ? Palette.text500 : Palette.text100)
          Spacer()
          AppGlyphView(.caretUpCaretDown, size: 20).foregroundStyle(Palette.text500)
        }
        .padding(16).frame(minHeight: 54)
        .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
      }
      if let error { Text(error).typeStyle(.caption).foregroundStyle(Palette.dangerText) }
    } actions: {
      Button(L("generic_button_cancel"), action: close).claudeButton(.secondary, size: .small).disabled(busy)
      Button(L("claudex_api_key_create_button")) {
        guard let groupID else { return }
        Task {
          busy = true
          error = await create(name, groupID)
          busy = false
          if error == nil { close() }
        }
      }.claudeButton(.primary, size: .small).disabled(busy || !valid)
    }
    .onAppear { groupID = groups.first?.id }
  }
}
