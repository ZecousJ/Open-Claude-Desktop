import SwiftUI

private struct APIGroupChoice: Identifiable {
  let provider: APIGroupProvider
  let group: APIGroup
  var id: String { provider.id + ":" + String(group.id) }
}

/// The API page, laid out like the official Connectors page: the API keys row, the image model picker, then one group
/// per platform whose rows are that platform's API groups (models and rate as the subtitle, a check on the one in
/// use).
struct APIGroupsView: View {
  @EnvironmentObject private var store: AppStore
  @State private var groups: APIGroups?
  @State private var rates: [String: Double] = [:]
  @State private var busy = false
  @State private var failed = false
  @State private var choosing: APIGroupChoice?
  var body: some View {
    SettingsPage(title: L("claudex_api_title")) {
      SettingsGroup {
        SettingsLink(icon: .key, title: L("claudex_api_keys_title"), subtitle: L("claudex_api_keys_subtitle")) {
          APIKeysView().id(store.accountGeneration)
        }
      }
      if groups == nil && busy {
        ListLoading()
      } else if groups == nil && failed {
        OfficialErrorState(text: L("generic_error_something_went_wrong")) { Task { await load(fresh: true) } }
      }
      if let images = groups?.images, !images.models.isEmpty {
        SettingsGroup {
          SettingsPickerRow(
            icon: .image, title: L("claudex_api_image_model"),
            options: images.models.map { PickerOption(value: $0.id, title: $0.name) },
            selection: Binding(get: { images.selected }, set: { value in Task { await selectImage(value) } }))
        }.disabled(busy)
      }
      ForEach(groups?.providers ?? []) { provider in
        SettingsGroup(provider.name) {
          if provider.groups.isEmpty {
            SettingsRow(title: L("claudex_api_no_groups"))
          }
          ForEach(provider.groups) { group in
            let selected = provider.selected == group.id
            Button { if !selected { choosing = APIGroupChoice(provider: provider, group: group) } } label: {
              SettingsRow(title: group.name, subtitle: subtitle(group)) {
                if selected { AppGlyphView(.check, size: 20).foregroundStyle(Palette.text100) }
              }
            }
            .buttonStyle(SettingsRowPressStyle())
            .disabled(busy)
            .accessibilityAddTraits(selected ? .isSelected : [])
          }
        }
      }
      if groups != nil {
        Text(L("claudex_api_footer")).typeStyle(.caption).foregroundStyle(Palette.text300).padding(.horizontal, 24)
      }
    }
    .task { await load() }
    .refreshable { await load(fresh: true) }
    .onChange(of: store.accountGeneration) { _, _ in
      groups = nil
      rates = [:]
      choosing = nil
    }
    .alert(
      L("claudex_api_switch_title"),
      isPresented: Binding(get: { choosing != nil }, set: { if !$0 { choosing = nil } })
    ) {
      Button(L("generic_button_cancel"), role: .cancel) { choosing = nil }
      Button(L("claudex_api_switch")) {
        if let choice = choosing { Task { await select(choice) } }
        choosing = nil
      }
    } message: {
      Text(L("claudex_api_switch_body", choosing?.provider.name ?? "", choosing?.group.name ?? ""))
    }
  }
  private func subtitle(_ group: APIGroup) -> String {
    var parts = [L10n.plural("claudex_api_model_count", count: group.models)]
    if let rate = rates[String(group.id)], rate.isFinite, rate >= 0 { parts.append(L("claudex_api_rate", rate.formatted())) }
    return parts.joined(separator: " · ")
  }
  @MainActor private func load(fresh: Bool = false) async {
    guard !busy, store.account != nil else { return }
    busy = true
    defer { busy = false }
    do {
      groups = try await store.accountRequest { try await $0.apiGroups(fresh: fresh) }
      failed = false
      do { rates = try await store.accountRequest { try await $0.groupRates() } } catch is CancellationError {
        throw CancellationError()
      } catch {
        rates = [:]
        store.validateSessionError(error)
      }
    } catch is CancellationError {} catch {
      failed = true
      store.validateSessionError(error)
    }
  }
  @MainActor private func selectImage(_ model: String) async {
    guard !busy, groups?.images?.models.contains(where: { $0.id == model }) == true, groups?.images?.selected != model else { return }
    busy = true
    defer { busy = false }
    do {
      groups = try await store.accountRequest { try await $0.setImageModel(model) }
      await store.refresh()
    } catch is CancellationError {} catch {
      store.errorMessage = error.localizedDescription
      store.validateSessionError(error)
    }
  }
  @MainActor private func select(_ choice: APIGroupChoice) async {
    guard !busy,
      groups?.providers.first(where: { $0.id == choice.provider.id })?.groups.contains(where: { $0.id == choice.group.id }) == true
    else { return }
    busy = true
    defer { busy = false }
    do {
      groups = try await store.accountRequest { try await $0.setAPIGroup(providerID: choice.provider.id, groupID: choice.group.id) }
      await store.refresh()
    } catch is CancellationError {} catch {
      store.errorMessage = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}
