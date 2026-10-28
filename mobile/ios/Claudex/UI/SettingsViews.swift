import SwiftUI
import UIKit

// Settings: the root list with the identity card and the official groups, and the simple sub-screens. Claudex-only
// rows (API, Service status) sit in the official groups in the official row style.

/// Saves a few settings fields on top of the account's current settings.
@MainActor func saveSettingsFields(_ fields: [String: JSONValue], store: AppStore) async -> Bool {
  guard let remote = store.remote, var raw = store.snapshot?.settings.raw.object else { return false }
  for (key, value) in fields { raw[key] = value }
  do {
    let _: JSONValue = try await remote.rpc.call("saveSettings", args: [.object(raw)], as: JSONValue.self)
    await store.refresh()
    return true
  } catch {
    store.errorMessage = error.localizedDescription
    store.validateSessionError(error)
    return false
  }
}

/// The settings value of a preference with the service's default when it is absent.
@MainActor func settingsFlag(_ store: AppStore, _ key: String, default value: Bool) -> Bool {
  store.snapshot?.settings.raw[key].bool ?? value
}

struct SettingsView: View {
  @EnvironmentObject private var store: AppStore
  @AppStorage("appearance") private var appearance = "system"
  @State private var signingOut = false
  @State private var billing: JSONValue = .null
  @State private var memory: MemoryStatus?
  private var capabilitiesCount: Int {
    var count = 0
    if memory?.prefs.searchChats == true { count += 1 }
    if memory?.prefs.generate == true { count += 1 }
    if settingsFlag(store, "aiArtifacts", default: false) { count += 1 }
    if settingsFlag(store, "inlineVisualizations", default: true) { count += 1 }
    return count
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        identityCard.padding(.horizontal, 12)
        SettingsGroup {
          SettingsLink(icon: .userCircle, title: L("title_profile"), identifier: "settings-profile") { ProfileView() }
          SettingsLink(icon: .dollarSign, title: L("title_billing"), identifier: "settings-billing") { BillingView() }
          SettingsLink(icon: .chartLine, title: L("usage_title"), identifier: "settings-usage") { UsageView() }
          SettingsLink(icon: .key, title: L("claudex_api_title"), identifier: "settings-api") { APIGroupsView() }
        }
        SettingsGroup {
          SettingsLink(
            icon: .filter, title: L("capabilities_setting_title"),
            subtitle: capabilitiesCount > 0 ? L10n.plural("capabilities_enabled_count", count: capabilitiesCount) : nil,
            identifier: "settings-capabilities"
          ) { CapabilitiesView() }
        }
        SettingsGroup {
          SettingsPickerRow(
            icon: .moon, title: L("color_mode_setting_title"),
            options: [
              PickerOption(value: "system", title: L("color_mode_setting_system"), icon: .mobilePhone),
              PickerOption(value: "light", title: L("color_mode_setting_light"), icon: .sun),
              PickerOption(value: "dark", title: L("color_mode_setting_dark"), icon: .moon),
            ], selection: $appearance)
        }
        SettingsGroup {
          SettingsLink(icon: .notification, title: L("notifications_section_title")) { NotificationSettingsView() }
          SettingsLink(icon: .activity, title: L("claudex_service_status_title"), identifier: "settings-status") {
            ServiceStatusView()
          }
          SettingsLink(icon: .lockShield, title: L("privacy_title")) { PrivacySettingsView() }
          SettingsLink(icon: .share, title: L("sharing_settings_title")) { SharingSettingsView() }
        }
        SettingsGroup {
          SettingsButton(icon: .logout, title: L("title_logout"), tint: Palette.danger000, identifier: "settings-logout") {
            signingOut = true
          }
        }
      }
      .padding(.vertical, 12)
      .frame(maxWidth: Spacing.buttonMaxWidth).frame(maxWidth: .infinity)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("title_settings"))
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) { LearnMoreMenu() }
    }
    .task {
      await loadBilling()
      await loadMemory()
    }
    .alert(L("title_logout"), isPresented: $signingOut) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("button_logout"), role: .destructive) { Task { await store.signOut() } }
    } message: {
      Text(L("body_logout"))
    }
  }

  /// Identity card: name (15/550), email (13pt), plan badge pill.
  private var identityCard: some View {
    let name = store.account?.name ?? ""
    return HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 4) {
        Text(name.isEmpty ? (store.account?.email ?? "") : name).typeStyle(.bodyStrong).foregroundStyle(Palette.text100)
          .lineLimit(1)
        if let email = store.account?.email, !email.isEmpty, email != name {
          Text(email).typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(1)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
      if let plan = billing["plan"].string, !plan.isEmpty {
        Text(plan).font(Font(TypeStyle.uiFont(family: .sans, size: 10, weight: 700))).foregroundStyle(Palette.bg100)
          .lineLimit(1)
          .padding(.horizontal, 8).padding(.vertical, 6.5)
          .background(Palette.text100, in: Capsule())
      }
    }
    .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 16)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
    .accessibilityElement(children: .combine)
  }

  private func loadBilling() async {
    guard store.account != nil else { return }
    billing = (try? await store.accountRequest { try await $0.rpc.call("billingInfo", as: JSONValue.self) }) ?? .null
  }
  private func loadMemory() async {
    guard store.account != nil else { return }
    memory = try? await store.accountRequest { try await $0.memoryStatus() }
  }
}

/// The ⓘ menu (`learn_more_menu_*`): Licenses, then the version, which copies on tap.
private struct LearnMoreMenu: View {
  private var version: String {
    let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
    return build.isEmpty ? short : "\(short) (\(build))"
  }
  var body: some View {
    Menu {
      NavigationLink { LicensesView() } label: {
        Label(L("learn_more_menu_licenses"), systemImage: AppGlyph.file.symbol)
      }
      Divider()
      Button(L("version_info_prefix", version)) {
        UIPasteboard.general.string = version
        Snackbars.shared.toast(L("generic_copied_toast"))
      }
    } label: {
      AppGlyphView(.infoCircle).frame(width: 44, height: 44).contentShape(Rectangle())
    }
    .foregroundStyle(Palette.text300)
    .accessibilityLabel(L("learn_more_menu_icon_content_description"))
  }
}

/// Licenses: the open-source fonts the app bundles.
private struct LicensesView: View {
  var body: some View {
    SettingsPage(title: L("learn_more_menu_licenses")) {
      SettingsGroup {
        SettingsRow(icon: .textAa, title: "Noto Serif", subtitle: "SIL Open Font License 1.1")
        SettingsRow(icon: .code, title: "JetBrains Mono", subtitle: "SIL Open Font License 1.1")
      }
    }
  }
}

// MARK: Profile

/// Profile: "What should we call you?", Update Profile; the personal preferences (our custom instructions) and work
/// type with Save Preferences. Plain padded content, not group cards. Claudex has no account deletion on the phone,
/// so "Account Actions" is left out.
struct ProfileView: View {
  @EnvironmentObject private var store: AppStore
  @State private var name = ""
  @State private var preferences = ""
  @State private var work = "other"
  @State private var loaded = false
  @State private var savingName = false
  @State private var savingPreferences = false
  private static let workTypes = [
    "engineering", "design", "product", "data", "research", "marketing", "sales", "operations", "finance", "legal",
    "education", "writing", "other",
  ]
  private var settings: JSONValue { store.snapshot?.settings.raw ?? .null }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        label(L("profile_display_name"))
        ClaudeTextField(L("profile_display_name"), text: $name, shape: .rounded, identifier: "profile-name")
          .padding(.top, 4)
          .disabled(savingName)
        Button {
          Task {
            savingName = true
            if await saveSettingsFields(["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))], store: store) {
              Snackbars.shared.toast(L("profile_snackbar_account_info_updated"))
            }
            savingName = false
          }
        } label: {
          if savingName { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) } else { Text(L("profile_update_button")) }
        }
        .claudeButton(.primary, size: .large, fullWidth: true)
        .disabled(savingName || name == (settings["name"].string ?? ""))
        .padding(.top, 16)

        Text(L("profile_conversation_preferences")).typeStyle(.bodyLarge).foregroundStyle(Palette.text100).padding(.top, 24)
        Text(L("profile_conversation_preferences_description")).typeStyle(.body).foregroundStyle(Palette.text500)
          .padding(.top, 2)
        DialogTextArea(placeholder: L("profile_conversation_preferences_hint"), text: $preferences, lines: 4...6)
          .padding(.top, 4).disabled(savingPreferences)
        SettingsGroup {
          SettingsPickerRow(
            icon: nil, title: L("claudex_profile_work_type"),
            options: Self.workTypes.map { PickerOption(value: $0, title: L("claudex_work_type_" + $0)) },
            selection: $work)
        }.padding(.horizontal, -12).padding(.top, 12)
        Button {
          Task {
            savingPreferences = true
            if await saveSettingsFields(["instructions": .string(preferences), "workType": .string(work)], store: store) {
              Snackbars.shared.toast(L("profile_snackbar_preferences_updated"))
            }
            savingPreferences = false
          }
        } label: {
          if savingPreferences { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) } else {
            Text(L("profile_save_preferences_button"))
          }
        }
        .claudeButton(.primary, size: .large, fullWidth: true)
        .disabled(
          savingPreferences
            || (preferences == (settings["instructions"].string ?? "") && work == (settings["workType"].string ?? "other")))
        .padding(.top, 16)
      }
      .padding(.horizontal, 16).padding(.vertical, 12)
      .frame(maxWidth: Spacing.buttonMaxWidth).frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("title_profile"))
    .onAppear {
      guard !loaded else { return }
      loaded = true
      name = settings["name"].string ?? ""
      preferences = settings["instructions"].string ?? ""
      work = settings["workType"].string ?? "other"
    }
  }
  private func label(_ text: String) -> some View {
    Text(text).typeStyle(.body).foregroundStyle(Palette.text100)
  }
}

// MARK: Billing and usage

/// Billing: the plan card, balance and subscriptions; orders as transactions. Claudex has no in-app purchase, so the
/// official upgrade / manage-subscription buttons are left out.
struct BillingView: View {
  @EnvironmentObject private var store: AppStore
  @State private var billing: JSONValue = .null
  @State private var loading = true
  @State private var failed = false
  var body: some View {
    SettingsPage(title: L("title_billing")) {
      if loading && billing == .null {
        ListLoading()
      } else if failed && billing == .null {
        OfficialErrorState(text: L("generic_error_something_went_wrong")) { Task { await load() } }
      } else {
        planCard.padding(.horizontal, 12)
        SettingsGroup {
          SettingsRow(icon: .dollarSign, title: L("usage_credits_current_balance")) {
            Text(money(billing["balance"].number)).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
          }
          SettingsLink(icon: .history, title: L("usage_credit_bundles_view_all")) { TransactionsView() }
        }
        let subscriptions = billing["subscriptions"].array ?? []
        if !subscriptions.isEmpty {
          SettingsGroup(L("claudex_billing_subscriptions")) {
            ForEach(Array(subscriptions.enumerated()), id: \.offset) { _, item in
              SettingsRow(
                title: item["plan"].string ?? "",
                subtitle: item["expiresAt"].number.map { L("claudex_billing_expires", date($0)) } ?? item["status"].string)
            }
          }
        }
        Text(L("claudex_billing_manage_on_web")).typeStyle(.caption).foregroundStyle(Palette.text300)
          .padding(.horizontal, 24)
      }
    }
    .refreshable { await load() }
    .task { await load() }
  }
  /// Plan card: 12pt corners, hairline, plan name and expiry.
  private var planCard: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(billing["plan"].string ?? L("claudex_billing_pay_as_you_go")).typeStyle(.bodyLargeStrong)
        .foregroundStyle(Palette.text100)
      if let expires = billing["planExpiresAt"].number {
        Text(L("claudex_billing_expires", date(expires))).typeStyle(.body).foregroundStyle(Palette.text500)
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
  }
  private func load() async {
    guard store.account != nil else { loading = false; return }
    loading = true
    defer { loading = false }
    do {
      billing = try await store.accountRequest { try await $0.rpc.call("billingInfo", as: JSONValue.self) }
      failed = false
    } catch is CancellationError {} catch {
      failed = true
      store.validateSessionError(error)
    }
  }
}

func money(_ value: Double?, currency: String = "USD") -> String {
  guard let value, value.isFinite else { return "—" }
  return value.formatted(.currency(code: currency).locale(Locale(identifier: L10n.catalog.language)))
}
private func date(_ ms: Double) -> String {
  Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.year().month().day().locale(Locale(identifier: L10n.catalog.language)))
}

/// Usage: "Plan usage" and "Weekly limits" meters with "N% used" and the reset caption, then Credits (our balance)
/// with "View all transactions", and our usage records.
struct UsageView: View {
  @EnvironmentObject private var store: AppStore
  @State private var value: JSONValue = .null
  @State private var loading = true
  @State private var failed = false
  private var windows: [JSONValue] { value["windows"].array ?? [] }
  private var weekly: [JSONValue] { windows.filter { ["all_models", "models"].contains($0["kind"].string ?? "") } }
  private var plan: [JSONValue] { windows.filter { !["all_models", "models"].contains($0["kind"].string ?? "") } }
  var body: some View {
    SettingsPage(title: L("usage_title")) {
      if loading && value == .null {
        ListLoading()
      } else if failed && value == .null {
        OfficialErrorState(text: L("usage_load_error")) { Task { await load() } }
      } else {
        if windows.isEmpty {
          OfficialEmptyState(icon: .chartLine, text: L("usage_no_data_available"), iconSize: 48)
        }
        if !plan.isEmpty {
          SettingsGroup(L("usage_plan_usage_header")) { ForEach(Array(plan.enumerated()), id: \.offset) { meter($0.element) } }
        }
        if !weekly.isEmpty {
          SettingsGroup(L("usage_weekly_limits")) { ForEach(Array(weekly.enumerated()), id: \.offset) { meter($0.element) } }
        }
        SettingsGroup(L("usage_credits_header")) {
          SettingsRow(icon: nil, title: L("usage_credits_current_balance")) {
            Text(money(value["balanceUsd"].number)).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
          }
          SettingsLink(title: L("usage_credit_bundles_view_all")) { TransactionsView() }
          SettingsLink(title: L("claudex_usage_records_title")) { UsageRecordsView().id(store.accountGeneration) }
        }
        if let address = value["learnMoreUrl"].string, let url = URL(string: address), url.scheme == "https" {
          Link(destination: url) {
            Text(L("usage_learn_more")).typeStyle(.body).foregroundStyle(Palette.accentSecondary100)
          }.padding(.horizontal, 24)
        }
      }
    }
    .refreshable { await load() }
    .task { await load() }
    .onChange(of: store.accountGeneration) { _, _ in value = .null }
  }
  private func meter(_ window: JSONValue) -> some View {
    let percent = max(0, min(100, window["percent"].number ?? 0))
    let label = window["label"].string ?? L("usage_limit_fallback_label")
    return UsageMeter(
      title: window["kind"].string == "models" && !label.isEmpty ? L("usage_scoped_label", label) : label,
      caption: caption(window), fraction: percent / 100,
      trailing: L("usage_percent_used", Int(percent.rounded())),
      fill: window["exceeded"].bool == true ? Palette.danger100 : Palette.accentSecondary100)
  }
  private func caption(_ window: JSONValue) -> String {
    guard window["active"].bool != false, let reset = window["resetsAt"].number else {
      return L("usage_starts_when_message_sent")
    }
    let minutes = max(0, Int((reset / 1000 - Date().timeIntervalSince1970) / 60))
    if minutes < 60 { return L("usage_resets_in_minutes", minutes) }
    if minutes < 24 * 60 { return L("usage_resets_in_hours_minutes", minutes / 60, minutes % 60) }
    let when = Date(timeIntervalSince1970: reset / 1000).formatted(
      .dateTime.weekday(.abbreviated).hour().minute().locale(Locale(identifier: L10n.catalog.language)))
    return L("usage_resets_at", when)
  }
  private func load() async {
    guard store.account != nil else { loading = false; return }
    loading = true
    defer { loading = false }
    do {
      value = try await store.accountRequest { try await $0.rpc.call("planUsage", args: [.bool(true)], as: JSONValue.self) }
      failed = false
    } catch is CancellationError {} catch {
      failed = true
      if value != .null { Snackbars.shared.show(L("usage_refresh_error")) }
      store.validateSessionError(error)
    }
  }
}

/// Transactions (`UsageTransactionsScreen`): the account's orders, newest first, with "Load more".
struct TransactionsView: View {
  @EnvironmentObject private var store: AppStore
  @State private var items: [JSONValue] = []
  @State private var page = 0
  @State private var pages = 1
  @State private var loading = false
  @State private var failed = false
  var body: some View {
    SettingsPage(title: L("usage_transactions_title")) {
      if items.isEmpty {
        if loading || page == 0 {
          ListLoading()
        } else if failed {
          OfficialErrorState(text: L("usage_transactions_load_error")) { Task { await load(1) } }
        } else {
          OfficialEmptyState(icon: .history, text: L("usage_transactions_empty"), iconSize: 48)
        }
      } else {
        SettingsGroup {
          ForEach(Array(items.enumerated()), id: \.offset) { _, order in
            let currency = (order["currency"].string ?? "USD").uppercased()
            SettingsRow(
              title: order["kind"].string == "balance"
                ? L("usage_credit_bundle_purchase_title") : L("claudex_transactions_plan_purchase"),
              subtitle: [order["createdAt"].number.map(date), orderStatus(order["status"].string)].compactMap { $0 }
                .joined(separator: " · ")
            ) {
              Text(money(order["payAmount"].number ?? order["amount"].number, currency: currency)).typeStyle(.body)
                .foregroundStyle(Palette.text300)
            }
          }
        }
        if page < pages {
          Button(L("claudex_load_more")) { Task { await load(page + 1) } }
            .claudeButton(.secondary, size: .small).disabled(loading).frame(maxWidth: .infinity)
        }
      }
    }
    .task { if page == 0 { await load(1) } }
    .refreshable { await load(1) }
  }
  private func orderStatus(_ status: String?) -> String? {
    guard let status else { return nil }
    let key = "claudex_order_status_" + status.lowercased()
    return L10n.catalog.has(key) ? L(key) : status
  }
  private func load(_ next: Int) async {
    guard store.account != nil, !loading else { return }
    loading = true
    defer { loading = false }
    do {
      let result = try await store.accountRequest {
        try await $0.rpc.call("billingOrders", args: [.number(Double(next))], as: JSONValue.self)
      }
      let fresh = result["items"].array ?? []
      items = next == 1 ? fresh : items + fresh
      page = next
      pages = result["pages"].integer ?? next
      failed = false
    } catch is CancellationError {} catch {
      failed = true
      page = max(page, 1)
      store.validateSessionError(error)
    }
  }
}

// MARK: Notifications, privacy, sharing

/// Notifications: the official switch rows. Claudex does not send push notifications to the phone yet, so each row is
/// shown off and disabled with that reason (no pretend switch).
struct NotificationSettingsView: View {
  var body: some View {
    SettingsPage(title: L("notifications_section_title")) {
      SettingsGroup {
        SettingsToggleRow(
          icon: .chats, title: L("chat_completion_notification_settings_title"), helper: L("chat_completion_notification_settings_description"),
          isOn: .constant(false))
        SettingsToggleRow(
          icon: .clock, title: L("scheduled_tasks_notification_title"),
          helper: L("scheduled_tasks_notification_description"), isOn: .constant(false))
        SettingsToggleRow(
          icon: .code, title: L("code_notification_settings_title"), helper: L("code_notification_settings_description"),
          isOn: .constant(false))
      }.disabled(true)
      Text(L("claudex_notifications_unavailable")).typeStyle(.caption).foregroundStyle(Palette.text300)
        .padding(.horizontal, 24)
    }
  }
}

/// Privacy (`url`): "Data Privacy" and Claudex's own data note, then the account's
/// "Help improve Claudex" switch.
struct PrivacySettingsView: View {
  @EnvironmentObject private var store: AppStore
  @State private var saving = false
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        Text(L("privacy_data_privacy_section_title")).typeStyle(.bodyLargeStrong).foregroundStyle(Palette.text100)
          .padding(.bottom, 8)
        Text(L("claudex_privacy_p1")).typeStyle(.body).foregroundStyle(Palette.text100).padding(.bottom, 4)
        Text(L("claudex_privacy_p2")).typeStyle(.body).foregroundStyle(Palette.text100)
      }
      .padding(.horizontal, 24).padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      ClaudeDivider()
      SettingsGroup {
        SettingsToggleRow(
          icon: .feedback, title: L("claudex_help_improve_title"), helper: L("claudex_help_improve_description"),
          isOn: Binding(
            get: { settingsFlag(store, "helpImproveClaudex", default: false) },
            set: { value in
              Task {
                saving = true
                _ = await saveSettingsFields(["helpImproveClaudex": .bool(value)], store: store)
                saving = false
              }
            })
        ).disabled(saving || store.account == nil)
      }.padding(.top, 8)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("privacy_title"))
  }
}

/// Sharing: "Shared links".
struct SharingSettingsView: View {
  var body: some View {
    SettingsPage(title: L("sharing_settings_title")) {
      SettingsGroup {
        SettingsLink(icon: .linkSimple, title: L("shared_links")) { SharedLinksView() }
      }
    }
  }
}

/// Shared links: the account's hosted shares with "Shared %1$s" and Unshare.
struct SharedLinksView: View {
  @EnvironmentObject private var store: AppStore
  @State private var shares: [JSONValue] = []
  @State private var loading = true
  @State private var failed = false
  @State private var unsharing: JSONValue?
  var body: some View {
    SettingsPage(title: L("shared_links_section_title")) {
      if loading && shares.isEmpty {
        ListLoading()
      } else if failed && shares.isEmpty {
        OfficialErrorState(text: L("generic_error_something_went_wrong")) { Task { await load() } }
      } else if shares.isEmpty {
        VStack(spacing: 16) {
          AppGlyphView(.linkSimple, size: 20).foregroundStyle(Palette.text500)
            .frame(width: 48, height: 48).background(Palette.bg300, in: Circle())
          Text(L("shared_links_null_state_description")).typeStyle(.bodyLarge).foregroundStyle(Palette.text500)
            .multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(.top, 96).padding(.horizontal, 24)
      } else {
        SettingsGroup {
          ForEach(Array(shares.enumerated()), id: \.offset) { _, share in
            let url = share["url"].string.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
            SettingsRow(
              icon: share["kind"].string == "artifact" ? .artifacts : .chat,
              title: share["title"].string ?? L("generic_untitled"),
              subtitle: share["createdAt"].number.map { L("shared_links_time_ago", date($0)) }
            ) {
              Menu {
                if let url {
                  ShareLink(item: url) { Label(L("project_share_link"), systemImage: AppGlyph.share.symbol) }
                  Button(L("generic_copy"), systemImage: AppGlyph.copy.symbol) {
                    UIPasteboard.general.string = url.absoluteString
                    Snackbars.shared.toast(L("generic_copied_toast"))
                  }
                }
                MenuItem(L("shared_links_unshare_button"), icon: .trash, destructive: true) { unsharing = share }
              } label: {
                AppGlyphView(.dotsHorizontal, size: 20).frame(width: 44, height: 44).contentShape(Rectangle())
              }.foregroundStyle(Palette.text300).accessibilityLabel(L("generic_button_more_options"))
            }
          }
        }
      }
    }
    .refreshable { await load() }
    .task { await load() }
    .alert(
      L("shared_links_unshare_dialog_title"),
      isPresented: Binding(get: { unsharing != nil }, set: { if !$0 { unsharing = nil } })
    ) {
      Button(L("generic_button_cancel"), role: .cancel) { unsharing = nil }
      Button(L("shared_links_unshare_button"), role: .destructive) {
        if let id = unsharing?["id"].string { Task { await revoke(id) } }
        unsharing = nil
      }
    } message: {
      Text(L("shared_links_unshare_dialog_description", unsharing?["title"].string ?? ""))
    }
  }
  private func load() async {
    guard store.account != nil else { loading = false; return }
    loading = true
    defer { loading = false }
    do {
      let result = try await store.accountRequest { try await $0.rpc.call("hostedShares", as: JSONValue.self) }
      shares = (result.array ?? []).sorted { ($0["createdAt"].number ?? 0) > ($1["createdAt"].number ?? 0) }
      failed = false
    } catch is CancellationError {} catch {
      failed = true
      store.validateSessionError(error)
    }
  }
  private func revoke(_ id: String) async {
    do {
      try await store.accountRequest { remote in
        let _: JSONValue = try await remote.rpc.call("revokeShare", args: [.string(id)], as: JSONValue.self)
      }
      shares.removeAll { $0["id"].string == id }
    } catch {
      store.errorMessage = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}
