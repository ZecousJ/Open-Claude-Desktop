import CoreLocation
import EventKit
import PhotosUI
import SwiftUI
import UIKit
import UserNotifications

// Settings (fidelity/mobile-official/settings.md): the root list with the identity card and the
// official groups, and the simple sub-screens. Claudex-only rows (API, Service status) sit in the
// official groups in the official row style (strings-feature-map.md §5, C22).

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

/// Location and calendar permission. The system asks; a refusal is not treated as access.
final class DevicePermissionCenter: NSObject, ObservableObject, CLLocationManagerDelegate {
  let location = CLLocationManager()
  let events = EKEventStore()
  @Published var locationStatus: CLAuthorizationStatus
  @Published var calendarStatus: EKAuthorizationStatus
  override init() {
    locationStatus = CLLocationManager().authorizationStatus
    calendarStatus = EKEventStore.authorizationStatus(for: .event)
    super.init()
    location.delegate = self
  }
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    locationStatus = manager.authorizationStatus
  }
  func refresh() {
    locationStatus = location.authorizationStatus
    calendarStatus = EKEventStore.authorizationStatus(for: .event)
  }
  func requestLocation() {
    if locationStatus == .denied || locationStatus == .restricted { openSettings() }
    else if locationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
  }

  private var locateDone: ((CLLocation?) -> Void)?

  /// Reads one fix and leaves it on this device. The callback is "off", "denied", "waiting", or nil when a fix was read.
  func locate(_ requested: String, done: @escaping (String?) -> Void) {
    guard CLLocationManager.locationServicesEnabled() else { done("off"); return }
    if location.authorizationStatus == .notDetermined {
      location.requestWhenInUseAuthorization()
      done("waiting")
      return
    }
    let granted: String? = switch location.authorizationStatus {
    case .authorizedAlways, .authorizedWhenInUse: location.accuracyAuthorization == .reducedAccuracy ? "coarse" : "precise"
    default: nil
    }
    if let gate = DeviceAccess.locationGate(servicesOn: true, granted: granted) { done(gate); return }
    locateDone = { [granted] fix in
      guard let fix, let granted else { done("waiting"); return }
      let revealed = DeviceAccess.reveal(requested: requested, granted: granted, latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude)
      done(revealed == nil ? "waiting" : nil)
    }
    location.requestLocation()
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    let callback = locateDone
    locateDone = nil
    callback?(locations.last)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    let callback = locateDone
    locateDone = nil
    callback?(nil)
  }
  /// Reads matching titles and keeps them on the device. Empty means the search ran.
  func searchEvents(_ request: DeviceAccess.Search) -> String? {
    guard calendarStatus == .fullAccess else { return L("calendar_events_permission_denied_system") }
    let start = request.start.flatMap(Self.moment) ?? Date()
    let end = request.end.flatMap(Self.moment) ?? start.addingTimeInterval(7 * 86_400)
    let calendars = events.calendars(for: .event)
    let chosen = request.calendarId.map { id in calendars.filter { $0.calendarIdentifier == id } } ?? calendars
    let fetched = events.events(matching: events.predicateForEvents(withStart: start, end: end, calendars: chosen))
    let found = fetched.map { DeviceAccess.Found(title: $0.title, allDay: $0.isAllDay, calendarId: $0.calendar.calendarIdentifier) }
    _ = DeviceAccess.matching(granted: true, events: found, request: request)
    return ""
  }

  /// Reads calendar names and keeps them on the device. Empty means the list was read.
  func calendarNames() -> String? {
    guard calendarStatus == .fullAccess else { return L("calendar_events_permission_denied_system") }
    _ = DeviceAccess.visibleTitles(granted: true, titles: events.calendars(for: .event).map(\.title))
    return ""
  }

  /// Writes the accepted events and reads each one back. An empty result means every event is in the calendar.
  /// People named on an event are not invited here: this calendar does not let the app add them.
  func createEvents(_ requested: [DeviceAccess.NewEvent]) -> String {
    guard calendarStatus == .fullAccess else { return L("calendar_events_permission_denied_system") }
    let writable = events.calendars(for: .event).filter(\.allowsContentModifications)
    guard let fallback = writable.first else { return L("calendar_event_create_status_failed") }
    var made = 0
    for event in requested {
      guard let start = Self.moment(event.start) else { continue }
      let end = event.end.flatMap(Self.moment) ?? start.addingTimeInterval(event.allDay ? 86_400 : 3_600)
      let item = EKEvent(eventStore: events)
      item.title = event.title
      item.startDate = start
      item.endDate = end
      item.isAllDay = event.allDay
      item.notes = event.description
      item.location = event.location
      item.calendar = writable.first { $0.calendarIdentifier == event.calendarId } ?? fallback
      let supported: Set<String> = ["fallback", "notification", "alarm"]
      if event.nudges.contains(where: { !supported.contains($0.method) }) || !event.attendees.isEmpty { continue }
      event.nudges.forEach { item.addAlarm(EKAlarm(relativeOffset: TimeInterval(-$0.minutes * 60))) }
      if let recurrence = event.recurrence {
        guard let rule = Self.repeatRule(recurrence) else { continue }
        item.recurrenceRules = [rule]
      }
      let span: EKSpan = event.recurrence == nil ? .thisEvent : .futureEvents
      guard (try? events.save(item, span: span)) != nil,
            let read = events.event(withIdentifier: item.eventIdentifier), read.title == event.title else { continue }
      let expected = event.nudges.map { TimeInterval(-$0.minutes * 60) }.sorted()
      let actual = (read.alarms ?? []).map(\.relativeOffset).sorted()
      if expected == actual && Self.sameRepeat(read, event.recurrence) { made += 1 }
      else { try? events.remove(read, span: span) }
    }
    return made == requested.count ? "" : L("calendar_event_create_status_failed")
  }

  /// Removes events that still belong to the named calendar, then checks they are gone.
  func deleteEvents(_ requested: [DeviceAccess.RemovedEvent]) -> String {
    guard calendarStatus == .fullAccess else { return L("calendar_events_permission_denied_system") }
    var removed = 0
    for event in requested {
      guard let item = events.event(withIdentifier: event.eventId), item.calendar.calendarIdentifier == event.calendarId else { continue }
      if event.span == "instance" && item.hasRecurrenceRules { continue }
      let span: EKSpan = event.span == "series" ? .futureEvents : .thisEvent
      guard (try? events.remove(item, span: span)) != nil, events.event(withIdentifier: event.eventId) == nil else { continue }
      removed += 1
    }
    return removed == requested.count ? "" : L("calendar_event_delete_status_failed")
  }

  /// Applies the named changes and reads the event back. A repeating event's single occurrence is left unchanged.
  func updateEvents(_ requested: [DeviceAccess.UpdatedEvent]) -> String {
    guard calendarStatus == .fullAccess else { return L("calendar_events_permission_denied_system") }
    var changed = 0
    for event in requested {
      guard let item = events.event(withIdentifier: event.eventId), item.calendar.calendarIdentifier == event.calendarId else { continue }
      if event.span == "instance" && item.hasRecurrenceRules { continue }
      let statusOnly = event.status != nil && event.status != "cancelled" && event.title == nil && event.start == nil && event.end == nil && event.allDay == nil && event.description == nil && event.location == nil && event.availability == nil
      if statusOnly { continue }
      if let title = event.title { item.title = title }
      if let start = event.start.flatMap(Self.moment) { item.startDate = start }
      if let end = event.end.flatMap(Self.moment) { item.endDate = end }
      if let allDay = event.allDay { item.isAllDay = allDay }
      if let notes = event.description { item.notes = notes }
      if let place = event.location { item.location = place }
      if let availability = event.availability {
        item.availability = switch availability { case "free": .free; case "tentative": .tentative; default: .busy }
      }
      if event.status == "cancelled" {
        let span: EKSpan = event.span == "series" ? .futureEvents : .thisEvent
        guard (try? events.remove(item, span: span)) != nil, events.event(withIdentifier: event.eventId) == nil else { continue }
        changed += 1
        continue
      }
      let span: EKSpan = event.span == "series" ? .futureEvents : .thisEvent
      guard (try? events.save(item, span: span)) != nil else { continue }
      let read = events.event(withIdentifier: event.eventId)
      if event.title == nil || read?.title == event.title { changed += 1 }
    }
    return changed == requested.count ? "" : L("calendar_event_update_status_failed")
  }

  private static func repeatRule(_ recurrence: DeviceAccess.Recurrence) -> EKRecurrenceRule? {
    let frequency: EKRecurrenceFrequency
    switch recurrence.frequency {
    case "daily": frequency = .daily
    case "weekly": frequency = .weekly
    case "monthly": frequency = .monthly
    case "yearly": frequency = .yearly
    default: return nil
    }
    let days = recurrence.days.compactMap(weekday)
    if days.count != recurrence.days.count { return nil }
    let end: EKRecurrenceEnd?
    if let count = recurrence.count { end = EKRecurrenceEnd(occurrenceCount: count) }
    else if let until = recurrence.until { guard let date = untilDate(until) else { return nil }; end = EKRecurrenceEnd(end: date) }
    else { end = nil }
    return EKRecurrenceRule(recurrenceWith: frequency, interval: recurrence.interval, daysOfTheWeek: days.isEmpty ? nil : days, daysOfTheMonth: recurrence.monthDay.map { [NSNumber(value: $0)] }, monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: end)
  }

  private static func sameRepeat(_ item: EKEvent, _ recurrence: DeviceAccess.Recurrence?) -> Bool {
    let rules = item.recurrenceRules ?? []
    guard let recurrence else { return rules.isEmpty }
    guard rules.count == 1, let rule = rules.first else { return false }
    let frequency: EKRecurrenceFrequency
    switch recurrence.frequency {
    case "daily": frequency = .daily
    case "weekly": frequency = .weekly
    case "monthly": frequency = .monthly
    case "yearly": frequency = .yearly
    default: return false
    }
    let days = (rule.daysOfTheWeek ?? []).compactMap { weekdayToken($0.dayOfTheWeek) }
    let monthDays = (rule.daysOfTheMonth ?? []).map(\.intValue)
    guard rule.frequency == frequency, rule.interval == recurrence.interval, days == recurrence.days, monthDays == (recurrence.monthDay.map { [$0] } ?? []) else { return false }
    if let count = recurrence.count { return rule.recurrenceEnd?.occurrenceCount == count }
    if let until = recurrence.until, let date = untilDate(until), let stored = rule.recurrenceEnd?.endDate { return stored.timeIntervalSince(date) == 0 }
    return rule.recurrenceEnd == nil
  }

  private static func weekday(_ token: String) -> EKRecurrenceDayOfWeek? {
    switch token {
    case "SU": return EKRecurrenceDayOfWeek(.sunday)
    case "MO": return EKRecurrenceDayOfWeek(.monday)
    case "TU": return EKRecurrenceDayOfWeek(.tuesday)
    case "WE": return EKRecurrenceDayOfWeek(.wednesday)
    case "TH": return EKRecurrenceDayOfWeek(.thursday)
    case "FR": return EKRecurrenceDayOfWeek(.friday)
    case "SA": return EKRecurrenceDayOfWeek(.saturday)
    default: return nil
    }
  }

  private static func weekdayToken(_ day: EKWeekday) -> String? {
    switch day {
    case .sunday: return "SU"
    case .monday: return "MO"
    case .tuesday: return "TU"
    case .wednesday: return "WE"
    case .thursday: return "TH"
    case .friday: return "FR"
    case .saturday: return "SA"
    @unknown default: return nil
    }
  }

  private static func untilDate(_ value: String) -> Date? {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    return formatter.date(from: value)
  }

  private static func moment(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }

  func requestCalendar() {
    if calendarStatus == .denied || calendarStatus == .restricted { openSettings(); return }
    if calendarStatus != .notDetermined && calendarStatus != .writeOnly { return }
    events.requestFullAccessToEvents { [weak self] _, _ in
      DispatchQueue.main.async { self?.calendarStatus = EKEventStore.authorizationStatus(for: .event) }
    }
  }
  private func openSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
  }
}

struct PermissionsView: View {
  @StateObject private var access = DevicePermissionCenter()
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        SettingsGroup {
          Button { access.requestLocation() } label: {
            SettingsRow(icon: .location, title: L("permission_location_title"), subtitle: access.locationStatus == .denied || access.locationStatus == .restricted ? L("permission_location_system_disabled") : L("permission_location_description"), subtitleLines: 4)
          }
          .buttonStyle(SettingsRowPressStyle())
          .accessibilityIdentifier("settings-location")
          Button { access.requestCalendar() } label: {
            SettingsRow(icon: .calendar, title: L("permission_calendar_title"), subtitle: access.calendarStatus == .denied || access.calendarStatus == .restricted ? L("permission_calendar_system_disabled") : L("permission_calendar_description"), subtitleLines: 4)
          }
          .buttonStyle(SettingsRowPressStyle())
          .accessibilityIdentifier("settings-calendar")
        }
      }
      .padding(.vertical, 12)
      .frame(maxWidth: Spacing.buttonMaxWidth).frame(maxWidth: .infinity)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("permissions_setting_title"))
  }
}

/// One switch: popup messages close themselves, or stay until they are dismissed.
struct AccessibilitySettingsView: View {
  @AppStorage("popup_auto_dismiss") private var autoDismiss = true
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        SettingsGroup {
          SettingsToggleRow(title: L("popup_auto_dismiss_title"), helper: L("popup_auto_dismiss_description"), isOn: $autoDismiss)
        }
      }
      .padding(.vertical, 12)
      .frame(maxWidth: Spacing.buttonMaxWidth).frame(maxWidth: .infinity)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("accessibility_setting_title"))
  }
}

struct SettingsView: View {
  @EnvironmentObject private var store: AppStore
  @AppStorage("appearance") private var appearance = "system"
  @AppStorage("font_style") private var fontStyle = "default"
  @AppStorage("haptic_feedback_enabled") private var hapticFeedback = true
  @State private var signingOut = false
  @State private var billing: JSONValue = .null
  @State private var memory: MemoryStatus?
  @StateObject private var access = DevicePermissionCenter()
  private var capabilitiesCount: Int {
    var count = 0
    if memory?.prefs.searchChats == true { count += 1 }
    if memory?.prefs.generate == true { count += 1 }
    if settingsFlag(store, "aiArtifacts", default: false) { count += 1 }
    if settingsFlag(store, "inlineVisualizations", default: true) { count += 1 }
    return count
  }
  private var connectedBases: Int { store.knowledgeBases.filter(\.available).count }
  private var permissionsEnabled: Int {
    let location = access.locationStatus == .authorizedAlways || access.locationStatus == .authorizedWhenInUse
    let calendar = access.calendarStatus == .fullAccess || access.calendarStatus == .writeOnly
    return (location ? 1 : 0) + (calendar ? 1 : 0)
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
          SettingsLink(
            icon: .connector, title: L("connectors_setting_title"),
            subtitle: connectedBases > 0 ? L10n.plural("connectors_connected_count", count: connectedBases) : nil,
            identifier: "settings-connectors"
          ) { ConnectorsView() }
          SettingsLink(icon: .toggles, title: L("permissions_setting_title"), subtitle: permissionsEnabled > 0 ? L10n.plural("permissions_enabled_count", count: permissionsEnabled) : nil, identifier: "settings-permissions") { PermissionsView() }
          SettingsLink(icon: .accessibility, title: L("accessibility_setting_title"), identifier: "settings-accessibility") { AccessibilitySettingsView() }
        }
        SettingsGroup {
          SettingsPickerRow(
            icon: .moon, title: L("color_mode_setting_title"),
            options: [
              PickerOption(value: "system", title: L("color_mode_setting_system"), icon: .mobilePhone),
              PickerOption(value: "light", title: L("color_mode_setting_light"), icon: .sun),
              PickerOption(value: "dark", title: L("color_mode_setting_dark"), icon: .moon),
            ], selection: $appearance)
          SettingsPickerRow(
            icon: .textAa, title: L("font_style_setting_title"),
            options: [
              PickerOption(value: "default", title: L("font_style_default"), icon: .textAa),
              PickerOption(value: "system", title: L("font_style_system"), icon: .mobilePhone),
            ], selection: $fontStyle)
        }
        SettingsGroup {
          if Haptics.supported {
            SettingsToggleRow(icon: .haptics, title: L("haptic_feedback_title"), isOn: $hapticFeedback)
          }
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
      await store.loadKnowledgeBases()
    }
    .onAppear { access.refresh() }
    .alert(L("title_logout"), isPresented: $signingOut) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("button_logout"), role: .destructive) { Task { await store.signOut() } }
    } message: {
      Text(L("body_logout"))
    }
  }

  /// Identity card (`ubk.e` → `wnp.a`): name (15/550), email (13pt), plan badge pill.
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

/// The ⓘ menu (`learn_more_menu_*`): licenses, check for updates, then the version, which copies on tap.
private struct LearnMoreMenu: View {
  @EnvironmentObject private var store: AppStore
  private var version: String {
    let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
    return build.isEmpty ? short : "\(short) (\(build))"
  }
  var body: some View {
    Menu {
      NavigationLink { LicensesView() } label: {
        Label(L("learn_more_menu_licenses"), systemImage: Anthropicon.file.symbol)
      }
      Button { store.checkForAppUpdate(asked: true) } label: {
        Label(L("claudex_update_check"), systemImage: Anthropicon.download.symbol)
      }
      Divider()
      Button(L("version_info_prefix", version)) {
        UIPasteboard.general.string = version
        Snackbars.shared.toast(L("generic_copied_toast"))
      }
    } label: {
      AnthropiconView(.infoCircle).frame(width: 44, height: 44).contentShape(Rectangle())
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

/// Profile (`wlx` / `s2j` case 6): "What should we call you?", Update Profile; the personal
/// preferences (our custom instructions) and work type with Save Preferences. Plain padded
/// content, not group cards. Claudex has no account deletion on the phone, so "Account Actions"
/// is left out.
struct ProfileView: View {
  @EnvironmentObject private var store: AppStore
  @State private var name = ""
  @State private var fullName = ""
  @State private var preferences = ""
  @State private var work = "other"
  @State private var loaded = false
  @State private var savingName = false
  @State private var savingPreferences = false
  @State private var savingPhoto = false
  @State private var photoSheet = false
  @State private var camera = false
  @State private var photoItem: PhotosPickerItem?
  @State private var removingPhoto = false
  @State private var explainDelete = false
  @State private var confirmDelete = false
  @State private var deleting = false
  @State private var deleteBlocked = false
  private var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
  private var photo: String? {
    let value = settings["avatarPhoto"].string ?? ""
    return ProfilePhotoPolicy.accepts(value) ? value : nil
  }
  private static let workTypes = [
    "engineering", "design", "product", "data", "research", "marketing", "sales", "operations", "finance", "legal",
    "education", "writing", "other",
  ]
  private var settings: JSONValue { store.snapshot?.settings.raw ?? .null }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 16) {
          profilePhoto
          Button(L("profile_photo_edit_button")) { photoSheet = true }
            .claudeButton(.secondary, size: .medium)
            .disabled(savingPhoto)
        }
        label(L("profile_full_name")).padding(.top, 24)
        ClaudeTextField(L("profile_full_name"), text: $fullName, shape: .rounded, identifier: "profile-full-name")
          .padding(.top, 4)
          .disabled(savingName)
        label(L("profile_display_name")).padding(.top, 16)
        ClaudeTextField(L("profile_display_name"), text: $name, shape: .rounded, identifier: "profile-name")
          .padding(.top, 4)
          .disabled(savingName)
        Button {
          Task {
            savingName = true
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let nextFull = fullName.trimmingCharacters(in: .whitespacesAndNewlines)
            if await saveSettingsFields(["name": .string(trimmed)], store: store) {
              if !nextFull.isEmpty, nextFull != (store.account?.name ?? "") {
                do {
                  let _: JSONValue = try await store.accountRequest { try await $0.rpc.call("setFullName", args: [.string(nextFull)], as: JSONValue.self) }
                  await store.refresh()
                } catch {
                  store.errorMessage = error.localizedDescription
                  store.validateSessionError(error)
                  savingName = false
                  return
                }
              }
              Snackbars.shared.toast(L("profile_snackbar_account_info_updated"))
            }
            savingName = false
          }
        } label: {
          if savingName { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) } else { Text(L("profile_update_button")) }
        }
        .claudeButton(.primary, size: .large, fullWidth: true)
        .disabled(savingName || (name == (settings["name"].string ?? "") && fullName == (store.account?.name ?? "")))
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
        Text(L("profile_account_actions")).typeStyle(.bodyLarge).foregroundStyle(Palette.text100).padding(.top, 24)
        SettingsGroup {
          SettingsButton(icon: .trash, title: L("profile_delete_account"), tint: Palette.danger100) {
            if !deleting { explainDelete = true }
          }
          .disabled(deleting)
        }.padding(.horizontal, -12).padding(.top, 8)
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
      fullName = store.account?.name ?? ""
      preferences = settings["instructions"].string ?? ""
      work = settings["workType"].string ?? "other"
    }
    .sheet(isPresented: $photoSheet) {
      VStack(spacing: 0) {
        SheetHeader(title: L("profile_photo_sheet_title"))
        SettingsGroup {
          Button { photoSheet = false; camera = true } label: {
            SettingsRow(icon: .camera, title: L("profile_photo_take_photo"))
          }
          .buttonStyle(SettingsRowPressStyle())
          .disabled(!cameraAvailable || savingPhoto)
          PhotosPicker(selection: $photoItem, matching: .images) {
            SettingsRow(icon: .image, title: L("profile_photo_view_library"))
          }
          .disabled(savingPhoto)
          if photo != nil {
            Button { photoSheet = false; removingPhoto = true } label: {
              SettingsRow(icon: .trash, title: L("profile_photo_remove"), tint: Palette.danger100)
            }
            .buttonStyle(SettingsRowPressStyle())
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.bottom, 12)
      .background(Palette.bg100.ignoresSafeArea())
      .presentationDetents([.medium])
    }
    .fullScreenCover(isPresented: $camera) {
      CameraPicker { data in
        camera = false
        if let data { Task { await savePhoto(data) } }
      }.ignoresSafeArea()
    }
    .onChange(of: photoItem) { _, item in
      guard let item else { return }
      photoItem = nil
      photoSheet = false
      Task {
        if let data = try? await item.loadTransferable(type: Data.self) { await savePhoto(data) }
        else { store.errorMessage = L("profile_photo_error_invalid_image") }
      }
    }
    .alert(L("delete_account_dialog_title"), isPresented: $explainDelete) {
      Button(L("delete_account_dialog_understand_button")) { confirmDelete = true }
      Button(L("generic_button_cancel"), role: .cancel) {}
    } message: {
      Text(L("delete_account_dialog_understand_text"))
    }
    .alert(L("delete_account_dialog_confirm_text"), isPresented: $confirmDelete) {
      Button(L("delete_account_dialog_confirm_button"), role: .destructive) {
        deleting = true
        Task {
          let outcome = await store.deleteAccount()
          deleting = false
          if outcome == "unavailable" { deleteBlocked = true }
        }
      }
      Button(L("generic_button_cancel"), role: .cancel) {}
    }
    .alert(L("delete_account_dialog_title"), isPresented: $deleteBlocked) {
      Button(L("generic_button_done")) {}
    } message: {
      Text(L("delete_account_dialog_cannot_delete"))
    }
    .alert(L("profile_photo_remove_dialog_title"), isPresented: $removingPhoto) {
      Button(L("profile_photo_remove_dialog_confirm"), role: .destructive) { Task { await clearPhoto() } }
      Button(L("generic_button_cancel"), role: .cancel) {}
    } message: {
      Text(L("profile_photo_remove_dialog_body"))
    }
  }
  private var profilePhoto: some View {
    Group {
      if let photo, let comma = photo.firstIndex(of: ","),
         let data = Data(base64Encoded: String(photo[photo.index(after: comma)...])),
         let image = UIImage(data: data) {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: Anthropicon.user.symbol).font(.system(size: 28)).foregroundStyle(Palette.text500)
          .frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.bg300)
      }
    }
    .frame(width: 72, height: 72)
    .clipShape(Circle())
    .accessibilityLabel(L("profile_photo_avatar_content_description"))
  }
  private func savePhoto(_ data: Data) async {
    guard !savingPhoto else { return }
    savingPhoto = true
    defer { savingPhoto = false }
    guard let url = profilePhotoURL(data) else { store.errorMessage = L("profile_photo_error_invalid_image"); return }
    if await saveSettingsFields(["avatarPhoto": .string(url), "profilePhotoEnabled": .bool(true)], store: store) == false {
      store.errorMessage = L("profile_photo_error_update")
    }
  }
  private func clearPhoto() async {
    savingPhoto = true
    defer { savingPhoto = false }
    if await saveSettingsFields(["avatarPhoto": .string(""), "profilePhotoEnabled": .bool(false)], store: store) == false {
      store.errorMessage = L("profile_photo_error_remove")
    }
  }
  private func label(_ text: String) -> some View {
    Text(text).typeStyle(.body).foregroundStyle(Palette.text100)
  }
}

/// Center-crops a picked photo to a square and saves it as a 256 px PNG data URL.
private func profilePhotoURL(_ data: Data) -> String? {
  guard let image = UIImage(data: data),
        let crop = ProfilePhotoPolicy.crop(width: Int(image.size.width.rounded()), height: Int(image.size.height.rounded()))
  else { return nil }
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = true
  let rendered = UIGraphicsImageRenderer(size: CGSize(width: ProfilePhotoPolicy.edge, height: ProfilePhotoPolicy.edge), format: format)
  let png = rendered.pngData { _ in
    let scale = CGFloat(ProfilePhotoPolicy.edge) / CGFloat(crop.side)
    image.draw(in: CGRect(
      x: -CGFloat(crop.x) * scale, y: -CGFloat(crop.y) * scale,
      width: image.size.width * scale, height: image.size.height * scale))
  }
  return ProfilePhotoPolicy.dataURL(png: png)
}

// MARK: Billing and usage

/// Billing (`tww`): the plan card, balance and subscriptions; orders as transactions. Claudex has
/// no in-app purchase, so the official upgrade / manage-subscription buttons are left out.
struct BillingView: View {
  @EnvironmentObject private var store: AppStore
  @State private var billing: JSONValue = .null
  @State private var loading = true
  @State private var failed = false
  @State private var spend: BillingPolicy.Spend?
  @State private var editingSpend = false
  @State private var amountText = ""
  @State private var savingLimit = false
  @State private var code = ""
  @State private var redeeming = false
  @State private var redeemNote: (text: String, failed: Bool)?
  @State private var checkout: BillingPolicy.Checkout?
  @State private var funding = false
  @State private var fundAmount = ""
  @State private var fundMethod = ""
  @State private var paying = false
  @State private var payNote: String?
  @State private var qrCode: String?
  @Environment(\.openURL) private var openURL
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
          if let spend {
            Button {
              amountText = spend.limitUsd.map { BillingPolicy.money($0, whole: true).replacingOccurrences(of: "$", with: "") } ?? "2000"
              editingSpend = true
            } label: {
              SettingsRow(title: L("spend_limit_title"), subtitle: spendLine(spend), subtitleLines: 2) {
                Text(L("spend_limit_manage")).typeStyle(.body).foregroundStyle(Palette.accentSecondary100)
              }
            }.buttonStyle(SettingsRowPressStyle())
          }
          if checkout?.balance == true {
            SettingsButton(icon: .dollarSign, title: L("billing_add_funds")) { funding = true }
          }
          SettingsLink(icon: .history, title: L("usage_credit_bundles_view_all")) { TransactionsView() }
        }
        if billing["redeem"].bool != false {
          VStack(alignment: .leading, spacing: 8) {
            Text(L("billing_redeem_title")).typeStyle(.body).foregroundStyle(Palette.text300)
            ClaudeTextField(L("billing_redeem_placeholder"), text: $code, shape: .rounded, identifier: "billing-redeem")
              .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button(L("billing_redeem_button")) {
              guard !redeeming else { return }
              redeeming = true
              redeemNote = nil
              Task {
                let result = await store.redeemCode(code)
                switch result {
                case .redeemed(let redeemed):
                  redeemNote = (redeemText(redeemed), false)
                  code = ""
                  if let next = try? await store.accountRequest({ try await $0.rpc.call("billingInfo", as: JSONValue.self) }) { billing = next }
                case .problem(let problem):
                  redeemNote = (redeemFailure(problem), true)
                }
                redeeming = false
              }
            }
            .claudeButton(.primary).disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || redeeming)
            if let redeemNote {
              Text(redeemNote.text).typeStyle(.body).foregroundStyle(redeemNote.failed ? Palette.danger100 : Palette.text500)
            }
          }.padding(.horizontal, 16)
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
        if checkout?.balance != true {
          Text(L("claudex_billing_manage_on_web")).typeStyle(.caption).foregroundStyle(Palette.text300)
            .padding(.horizontal, 24)
        }
      }
    }
    .refreshable { await load() }
    .task { await load(); spend = await store.readSpendLimit(); checkout = await store.loadCheckout() }
    .sheet(isPresented: $editingSpend) { spendEditor }
    .sheet(isPresented: $funding) { fundsSheet }
  }
  private var spendEditor: some View {
    let amount = BillingPolicy.parseAmount(amountText)
    let help = amountText.trimmingCharacters(in: .whitespaces).isEmpty ? L("spend_limit_enter")
      : amount == nil ? L("spend_limit_enter_example")
      : amount == 0 ? L("spend_limit_zero") : L("spend_limit_immediate")
    return VStack(alignment: .leading, spacing: 12) {
      SheetHeader(title: L("spend_limit_set_title"))
      Text(L("spend_limit_set_body")).typeStyle(.body).foregroundStyle(Palette.text500)
      ClaudeTextField(L("spend_limit_amount"), text: $amountText, shape: .rounded, identifier: "spend-limit-amount")
        .keyboardType(.decimalPad)
      Text(help).typeStyle(.caption).foregroundStyle(amount == nil || amount == 0 ? Palette.danger100 : Palette.text500)
      Button(L("spend_limit_unlimited")) { Task { await saveLimit(nil) } }
        .claudeButton(.secondary).disabled(savingLimit)
      Button(L("spend_limit_save")) { if let amount { Task { await saveLimit(amount) } } }
        .claudeButton(.primary).disabled(amount == nil || savingLimit)
      Spacer(minLength: 0)
    }
    .padding(16)
    .background(Palette.bg100.ignoresSafeArea())
    .presentationDetents([.medium])
  }
  private func saveLimit(_ amount: Double?) async {
    savingLimit = true
    if let saved = await store.saveSpendLimit(amount) {
      spend = saved
      editingSpend = false
    }
    savingLimit = false
  }
  private var fundsSheet: some View {
    let methods = checkout?.methods ?? []
    let chosen = methods.first { $0.id == fundMethod } ?? methods.first
    let amount = BillingPolicy.parseAmount(fundAmount)
    let problem = chosen.flatMap { BillingPolicy.amountProblem(amount, method: $0, floor: checkout?.min ?? 0, ceiling: checkout?.max ?? 0) }
    return VStack(alignment: .leading, spacing: 12) {
      SheetHeader(title: L("billing_add_funds"))
      ClaudeTextField(L("spend_limit_amount"), text: $fundAmount, shape: .rounded, identifier: "billing-amount")
        .keyboardType(.decimalPad)
      ForEach(methods, id: \.id) { method in
        Button { fundMethod = method.id } label: {
          SettingsRow(title: payMethodName(method.id), tint: method.id == chosen?.id ? Palette.text100 : Palette.text500)
        }.buttonStyle(SettingsRowPressStyle())
      }
      if let problem, let chosen {
        let bound = problem == "low" ? max(chosen.min, checkout?.min ?? 0) : [chosen.max, checkout?.max ?? 0].filter { $0 > 0 }.min() ?? 0
        Text(problem == "low" ? L("billing_amount_low", BillingPolicy.money(bound, whole: true)) : problem == "high" ? L("billing_amount_high", BillingPolicy.money(bound, whole: true)) : L("billing_amount_empty"))
          .typeStyle(.caption).foregroundStyle(Palette.danger100)
      }
      if let payNote { Text(payFailure(payNote)).typeStyle(.body).foregroundStyle(Palette.danger100) }
      if let qrCode { Text(L("billing_qr_body")).typeStyle(.body).foregroundStyle(Palette.text500); Text(qrCode).typeStyle(.codeSmall).textSelection(.enabled) }
      Button(L("billing_pay")) {
        guard let chosen, let amount, problem == nil, !paying else { return }
        paying = true
        payNote = nil
        Task {
          let result = await store.startTopUp(method: chosen.id, amount: amount)
          paying = false
          switch result {
          case .browser(let url, let orderId):
            funding = false
            openURL(url)
            Snackbars.shared.show(L("billing_pay_waiting"))
            if let status = await store.followPayment(orderId), status == "COMPLETED" {
              if let next = try? await store.accountRequest({ try await $0.rpc.call("billingInfo", as: JSONValue.self) }) { billing = next }
              Snackbars.shared.show(L("billing_pay_completed"))
            }
          case .qr(let code, _): qrCode = code
          case .failed(let reason): payNote = reason
          }
        }
      }.claudeButton(.primary).disabled(problem != nil || paying)
      Spacer(minLength: 0)
    }
    .padding(16).background(Palette.bg100.ignoresSafeArea()).presentationDetents([.medium, .large])
  }
  private func payMethodName(_ id: String) -> String {
    switch id {
    case "alipay": L("billing_method_alipay")
    case "wxpay": L("billing_method_wxpay")
    case "stripe": L("billing_method_stripe")
    case "airwallex": L("billing_method_airwallex")
    default: L("billing_pay")
    }
  }
  private func payFailure(_ reason: String) -> String {
    switch reason {
    case "wechat": L("billing_pay_wechat")
    case "desktop": L("billing_pay_desktop")
    case "insecure": L("billing_pay_insecure")
    default: L("billing_pay_unknown")
    }
  }
  private func spendLine(_ spend: BillingPolicy.Spend) -> String {
    let used = BillingPolicy.money(spend.usedUsd)
    if let limit = spend.limitUsd { return L("spend_limit_line_capped", used, BillingPolicy.money(limit, whole: true)) }
    return L("spend_limit_line_none", used)
  }
  private func redeemText(_ redeemed: BillingPolicy.Redeemed) -> String {
    switch redeemed.type {
    case "balance": return L("billing_redeem_balance", BillingPolicy.money(redeemed.value))
    case "subscription":
      let name = redeemed.plan.isEmpty ? L("claudex_billing_pay_as_you_go") : redeemed.plan
      return redeemed.days > 0 ? L("billing_redeem_plan", name, redeemed.days) : L("billing_redeem_plan_open", name)
    case "concurrency": return L("billing_redeem_concurrency", Int(redeemed.value))
    default: return L("billing_redeem_done")
    }
  }
  private func redeemFailure(_ problem: String) -> String {
    switch problem {
    case "invalid": L("billing_redeem_invalid")
    case "missing": L("billing_redeem_missing")
    case "used": L("billing_redeem_used")
    case "expired": L("billing_redeem_expired")
    case "locked": L("billing_redeem_locked")
    case "limited": L("billing_redeem_limited")
    default: L("billing_redeem_failed")
    }
  }
  /// Plan card (`tww.a`): 12pt corners, hairline, plan name and expiry.
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

/// Usage (`a2v`): "Plan usage" and "Weekly limits" meters with "N% used" and the reset caption,
/// then Credits (our balance) with "View all transactions", and our usage records.
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
              VStack(alignment: .trailing, spacing: 4) {
                Text(money(order["payAmount"].number ?? order["amount"].number, currency: currency)).typeStyle(.body)
                  .foregroundStyle(Palette.text300)
                if order["status"].string == "PENDING", let id = order["id"].integer {
                  Button(L("billing_order_cancel")) {
                    Task { if await store.cancelPayment(id) { await load(1) } }
                  }.buttonStyle(.plain).foregroundStyle(Palette.danger100)
                }
              }
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

// MARK: Connectors (knowledge bases)

/// Connectors (`yex`): Claudex's knowledge bases are its connectors. Each base is a row with its
/// description; an unreachable one shows "Unavailable". Bases are turned on per chat from the
/// composer's + menu.
struct ConnectorsView: View {
  @EnvironmentObject private var store: AppStore
  @State private var loaded = false
  var body: some View {
    SettingsPage(title: L("connectors_setting_title")) {
      if !loaded && store.knowledgeBases.isEmpty {
        ListLoading()
      } else if store.knowledgeBases.isEmpty {
        OfficialEmptyState(icon: .connector, text: L("claudex_connectors_empty"), iconSize: 48)
      } else {
        SettingsGroup(L("claudex_knowledge_bases_header")) {
          ForEach(store.knowledgeBases) { base in
            SettingsRow(
              icon: .database, title: base.name,
              subtitle: base.available ? (base.description.isEmpty ? nil : base.description) : L("claudex_connector_unavailable"),
              subtitleLines: 2)
            .opacity(base.available ? 1 : 0.6)
          }
        }
        Text(L("claudex_connectors_footer")).typeStyle(.caption).foregroundStyle(Palette.text300).padding(.horizontal, 24)
      }
    }
    .refreshable { await store.loadKnowledgeBases() }
    .task {
      await store.loadKnowledgeBases()
      loaded = true
    }
  }
}

// MARK: Notifications, privacy, sharing

/// Notifications (`qww`). Replies can notify when one finishes in the background.
/// A tool approval can be allowed once or declined from its notification. A scheduled task notifies when this app next hears that its run finished or failed. Code session updates stay off.
struct NotificationSettingsView: View {
  @EnvironmentObject private var store: AppStore
  @AppStorage("reply-notifications") private var replies = true
  var body: some View {
    SettingsPage(title: L("notifications_section_title")) {
      SettingsGroup {
        SettingsToggleRow(
          icon: .chats, title: L("chat_completion_notification_settings_title"), helper: L("chat_completion_notification_settings_description"),
          isOn: $replies)
        SettingsToggleRow(
          icon: .clock, title: L("scheduled_tasks_notification_title"), helper: L("scheduled_tasks_notification_description"),
          isOn: Binding(
            get: { settingsFlag(store, "notifySchedules", default: true) },
            set: { value in
              if value { UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in } }
              Task { _ = await saveSettingsFields(["notifySchedules": .bool(value)], store: store) }
            }))
      }
      .onChange(of: replies) { _, on in
        if on { UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in } }
      }
    }
  }
}

/// Privacy (`url`): "Data Privacy" and Claudex's own data note, then the account's
/// "Help improve Claudex" switch.
struct PrivacySettingsView: View {
  @EnvironmentObject private var store: AppStore
  @State private var saving = false
  @State private var exporting = false
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
        SettingsButton(icon: .download, title: L("claudex_export_data")) {
          guard !exporting else { return }
          exporting = true
          Task {
            if let file = await store.exportAccountData() { ActivitySheet.present([file]) }
            exporting = false
          }
        }
        .disabled(exporting || store.account == nil)
      }.padding(.top, 8)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("privacy_title"))
  }
}

/// Sharing (`juw`): "Shared links".
struct SharingSettingsView: View {
  @AppStorage("share_defaults_to_new_chat") private var shareDefaultsToNewChat = false
  var body: some View {
    SettingsPage(title: L("sharing_settings_title")) {
      SettingsGroup(L("share_from_other_apps")) {
        SettingsToggleRow(icon: .share, title: L("share_always_new_chat"), isOn: $shareDefaultsToNewChat)
      }
      SettingsGroup {
        SettingsLink(icon: .linkSimple, title: L("shared_links")) { SharedLinksView() }
      }
    }
  }
}

/// Shared links (`fuw`): the account's hosted shares with "Shared %1$s" and Unshare.
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
          AnthropiconView(.linkSimple, size: 20).foregroundStyle(Palette.text500)
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
                  ShareLink(item: url) { Label(L("project_share_link"), systemImage: Anthropicon.share.symbol) }
                  Button(L("generic_copy"), systemImage: Anthropicon.copy.symbol) {
                    UIPasteboard.general.string = url.absoluteString
                    Snackbars.shared.toast(L("generic_copied_toast"))
                  }
                }
                MenuItem(L("shared_links_unshare_button"), icon: .trash, destructive: true) { unsharing = share }
              } label: {
                AnthropiconView(.dotsHorizontal, size: 20).frame(width: 44, height: 44).contentShape(Rectangle())
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
