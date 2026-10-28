import SwiftUI

/// Scheduled tasks: sections Active / Inactive (a paused task is simply in Inactive) / Completed (a one-time task
/// that has had its run), each task a row with its schedule and next run; tap opens the task's details. "New task"
/// offers the official entry (a new chat with the prefilled request) and Claudex's form editor.
struct SchedulesView: View {
  @EnvironmentObject private var store: AppStore
  @State private var routines: [Routine] = []
  @State private var policy: JSONValue = .null
  @State private var busy = false
  @State private var loaded = false
  @State private var failed = false
  @State private var editor = false
  private var supported: Bool { store.snapshot?.host?["capabilities"]["scheduledTasks"].bool == true }
  private var policyEnabled: Bool { policy["scheduledTasks"]["enabled"].bool == true }
  private var limitAllows: Bool { policy["scheduledTasks"]["maxTasks"].integer.map { routines.count < $0 } ?? true }
  private var canCreate: Bool {
    supported && policyEnabled && store.snapshot?.host?["capabilities"]["cloudCowork"].bool == true && limitAllows
  }
  private var sections: (active: [Routine], inactive: [Routine], completed: [Routine]) { RoutineSections.split(routines) }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if !supported {
          OfficialEmptyState(icon: .clock, text: L("claudex_schedules_unsupported")).padding(.top, 96)
        } else if !loaded {
          ListLoading()
        } else if failed && routines.isEmpty {
          Button { Task { await load() } } label: {
            OfficialEmptyState(icon: .warningCircle, text: L("scheduled_tasks_error_retry"), iconSize: 48)
          }.buttonStyle(.plain).padding(.top, 96)
        } else if routines.isEmpty {
          OfficialEmptyState(icon: .clock, text: L("scheduled_tasks_empty_title"), subtitle: L("scheduled_tasks_empty_subtitle"))
            .padding(.top, 96)
        }
        section(L("scheduled_tasks_section_active"), sections.active)
        section(L("scheduled_tasks_section_inactive"), sections.inactive)
        section(L("scheduled_tasks_section_completed"), sections.completed)
        // Only what explains a disabled New task: the administrator turned tasks off, or the limit is reached.
        if supported && loaded && (!policyEnabled || !limitAllows) {
          Text(policyEnabled ? L("claudex_schedules_count", routines.count, policy["scheduledTasks"]["maxTasks"].integer ?? routines.count) : L("claudex_schedules_policy_off"))
            .typeStyle(.caption).foregroundStyle(Palette.text500)
            .padding(.horizontal, 24).padding(.top, 16)
        }
      }.padding(.bottom, 24)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("scheduled_tasks_title"), serif: false)
    .sidebarToolbar()
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          MenuItem(L("claudex_schedule_new_in_chat"), icon: .chat) {
            store.beginNewChat()
            store.composerText = L("scheduled_tasks_new_task_prompt")
          }
          MenuItem(L("claudex_schedule_new_form"), icon: .edit) { editor = true }
            .disabled(busy || !canCreate)
        } label: {
          AppGlyphView(.add).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .foregroundStyle(Palette.text100)
        .accessibilityLabel(L("scheduled_tasks_new_task"))
        .accessibilityIdentifier("schedule-new")
      }
    }
    .task { await load() }
    .refreshable { await load() }
    .sheet(isPresented: $editor) { RoutineEditorView(routine: nil) { Task { await load() } } }
  }
  @ViewBuilder private func section(_ title: String, _ items: [Routine]) -> some View {
    if !items.isEmpty {
      SectionHeader(title: title).padding(.leading, 8).padding(.top, 8)
      ForEach(items) { routine in
        NavigationLink { RoutineDetailView(routine: routine, policy: policy) { Task { await load() } } } label: {
          RoutineRow(routine: routine)
        }
        .buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
        .accessibilityIdentifier("schedule-" + routine.id)
      }
    }
  }
  @MainActor private func load() async {
    guard !busy, store.account != nil, supported else {
      loaded = true
      return
    }
    busy = true
    defer {
      busy = false
      loaded = true
    }
    do {
      let result = try await store.accountRequest { remote in
        async let schedules = remote.schedules()
        async let policy = remote.schedulePolicy()
        return try await (schedules, policy)
      }
      routines = result.0
      policy = result.1
      failed = false
    } catch is CancellationError {} catch {
      failed = true
      if !routines.isEmpty { Snackbars.shared.show(L("routines_refresh_error")) }
      store.validateSessionError(error)
    }
  }
}

/// A task row: name, "schedule · Next at …", the Working spinner while it runs.
private struct RoutineRow: View {
  let routine: Routine
  var body: some View {
    HStack(spacing: 8) {
      if routine.running {
        ClaudeSpinner(size: .icon, color: Palette.textSecondary).padding(.leading, 4)
          .accessibilityLabel(L("cds_list_row_status_working"))
      }
      VStack(alignment: .leading, spacing: 0) {
        Text(routine.name.isEmpty ? L("untitled_task") : routine.name).typeStyle(.bodyLarge)
          .foregroundStyle(Palette.text100).lineLimit(1)
        Text(subtitle).typeStyle(.body).foregroundStyle(Palette.text500).lineLimit(1)
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 56)
    .contentShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
  }
  private var subtitle: String {
    var parts = [routineRuleLabel(routine)]
    // A one-time task's label already names its moment.
    if routine.enabled, !["manual", "once"].contains(routine.repeatRule["kind"].string), let next = routine.nextRunAt {
      parts.append(L("scheduled_task_next_at", shortDate(next)))
    }
    if routine.completedOnce { parts.append(L("routine_badge_ran_once")) }
    return parts.joined(separator: " · ")
  }
}

private func shortDate(_ ms: Double) -> String {
  Date(timeIntervalSince1970: ms / 1000).formatted(
    .dateTime.month().day().hour().minute().locale(Locale(identifier: L10n.catalog.language)))
}

/// A task's details (`ScheduleTaskDetails`): Details (Task active switch, Repeats, Next run, Last run,
/// Created, Model), Instructions, History; the top-bar menu has Edit task, Run now (it starts at once, with
/// "Run started") and Delete task.
struct RoutineDetailView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  let routine: Routine
  let policy: JSONValue
  let changed: () -> Void
  @State private var current: Routine?
  @State private var runs: [RoutineRun] = []
  @State private var loadingRuns = true
  @State private var busy = false
  @State private var editing = false
  @State private var deleting = false
  @State private var showAllAllowed = false
  private var task: Routine { current ?? routine }
  private var policyEnabled: Bool { policy["scheduledTasks"]["enabled"].bool == true }
  var body: some View {
    SettingsPage(title: task.name.isEmpty ? L("untitled_task") : task.name) {
      SettingsGroup(L("scheduled_task_detail_details")) {
        SettingsToggleRow(
          title: L("scheduled_task_toggle_description"),
          isOn: Binding(get: { task.enabled }, set: { value in Task { await setEnabled(value) } })
        ).disabled(busy || (!task.enabled && !policyEnabled))
        detail(L("scheduled_task_detail_repeats"), task.onceAt != nil ? routineRuleLabel(task) : routineRuleLabel(task) + " · " + L("claudex_server_time"))
        if task.enabled, task.repeatRule["kind"].string != "manual", let next = task.nextRunAt {
          detail(L("routine_detail_next_run"), shortDate(next))
        }
        if let state = task.raw["lastRunStatus"].string {
          detail(L("routine_detail_last_run"), routineStatus(state), error: task.raw["lastError"].string)
        }
        if let created = task.raw["createdAt"].number { detail(L("routine_detail_created"), shortDate(created)) }
        detail(L("scheduled_task_model"), task.raw["defaultModel"].bool == false ? (task.raw["model"].string ?? "") : L("scheduled_task_model_default"))
      }
      if let mode = task.permission {
        SettingsGroup(L("scheduled_task_detail_permissions")) {
          SettingsRow(icon: permissionIcon(mode), title: permissionTitle(mode), subtitle: permissionDescription(mode), subtitleLines: 3)
        }
      }
      if !task.allowed.isEmpty {
        SettingsGroup(L("scheduled_task_detail_always_allowed")) {
          ForEach(Array((showAllAllowed ? task.allowed : Array(task.allowed.prefix(3))).enumerated()), id: \.offset) { _, entry in
            SettingsRow(title: allowedLabel(entry), subtitleLines: 3)
          }
          if task.allowed.count > 3 {
            SettingsButton(title: L(showAllAllowed ? "scheduled_task_detail_allowed_tools_show_less" : "scheduled_task_detail_allowed_tools_show_all")) { showAllAllowed.toggle() }
          }
        }
      }
      SettingsGroup(L("routine_detail_instructions")) {
        Text(task.prompt).typeStyle(.body).foregroundStyle(Palette.text100).textSelection(.enabled)
          .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r2, style: .continuous))
      }
      SettingsGroup(L("scheduled_task_detail_history")) {
        if loadingRuns && runs.isEmpty {
          SettingsRow(title: L("usage_meter_row_loading")).redacted(reason: .placeholder)
        } else if runs.isEmpty {
          VStack(spacing: 4) {
            Text(L("cowork_scheduled_empty_title")).typeStyle(.bodyLarge)
            Text(L("cowork_scheduled_empty_subtitle")).typeStyle(.body)
          }
          .foregroundStyle(Palette.text500).multilineTextAlignment(.center)
          .frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.vertical, 16)
        }
        ForEach(runs) { run in
          let row = SettingsRow(
            title: routineStatus(run.status),
            subtitle: [shortDate(run.startedAt), run.trigger == "manual" ? L("routine_run_kind_manual") : L("routine_run_kind_scheduled"), run.error]
              .compactMap { $0 }.joined(separator: " · "),
            subtitleLines: 3)
          if let id = run.conversationId {
            NavigationLink { ChatView(conversationID: id) } label: { row }
              .buttonStyle(SettingsRowPressStyle())
              .accessibilityHint(L("routine_runs_open_session"))
          } else {
            row
          }
        }
      }
    }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          MenuItem(L("scheduled_task_edit"), icon: .edit) { editing = true }
          MenuItem(L("scheduled_task_run_now"), icon: .play) { Task { await run() } }
            .disabled(!policyEnabled || task.running)
          MenuItem(L("scheduled_task_delete"), icon: .trash, destructive: true) { deleting = true }
        } label: {
          AppGlyphView(.dotsVertical).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .foregroundStyle(Palette.text100).disabled(busy)
        .accessibilityLabel(L("generic_button_more_options"))
      }
    }
    .task { await loadRuns() }
    .refreshable { await reload() }
    .sheet(isPresented: $editing) {
      RoutineEditorView(routine: task) { Task { await reload() } }
    }
    .alert(L("scheduled_task_delete"), isPresented: $deleting) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("scheduled_task_delete_confirm"), role: .destructive) { Task { await delete() } }
    } message: {
      Text(L("scheduled_task_delete_dialog_description"))
    }
  }
  private func detail(_ title: String, _ value: String, error: String? = nil) -> some View {
    SettingsRow(title: title, subtitle: error, subtitleLines: 3) {
      Text(value).typeStyle(.body).foregroundStyle(Palette.text300).multilineTextAlignment(.trailing).lineLimit(2)
    }
  }
  @MainActor private func reload() async {
    if let fresh = try? await store.accountRequest({ try await $0.schedules() }).first(where: { $0.id == routine.id }) {
      current = fresh
    }
    await loadRuns()
    changed()
  }
  @MainActor private func loadRuns() async {
    loadingRuns = true
    defer { loadingRuns = false }
    do { runs = try await store.accountRequest { try await $0.scheduleRuns(routine.id) } } catch is CancellationError {} catch {
      Snackbars.shared.show(L("routine_runs_refresh_error"))
      store.validateSessionError(error)
    }
  }
  @MainActor private func setEnabled(_ value: Bool) async {
    await mutate(failure: L("scheduled_task_update_failed")) { remote in
      current = try await remote.saveSchedule(task.settingEnabled(value))
    }
  }
  @MainActor private func run() async {
    await mutate(failure: L("scheduled_task_run_failed")) { remote in
      current = try await remote.runSchedule(task.id)
      Snackbars.shared.toast(L("scheduled_task_run_started"))
    }
    await loadRuns()
  }
  @MainActor private func delete() async {
    await mutate(failure: L("scheduled_task_update_failed")) { remote in
      try await remote.deleteSchedule(task.id)
      dismiss()
    }
  }
  @MainActor private func mutate(failure: String, _ operation: (RemoteClaudexService) async throws -> Void) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      try await store.accountRequest(operation)
      changed()
    } catch is CancellationError {} catch {
      Snackbars.shared.show(error.localizedDescription, title: failure)
      store.validateSessionError(error)
    }
  }
}

/// Edit task / New task: Name, Instructions, Model, then the Schedule section: Repeats (Manual only / Once / Hourly /
/// Daily / Weekdays / Weekly / Custom, a cron expression), Day and Time; then Permission (Manual, Auto, Skip all
/// approvals). The repeating rules' times are the service's: the protocol carries no phone time zone. Once is an
/// exact moment, picked as a date and a time in this phone's time zone.
struct RoutineEditorView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  let routine: Routine?
  let saved: () -> Void
  @State private var name = ""
  @State private var prompt = ""
  @State private var kind = "manual"
  @State private var time = "09:00"
  @State private var minuteText = "0"
  /// The minute of the hour an hourly task runs at (the field accepts up to two digits; 0–59).
  private var minute: Int { min(59, Int(minuteText) ?? 0) }
  @State private var day = 1
  @State private var cron = ""
  @State private var onceAt = RoutineDefaults.onceMoment(Date())
  @State private var permission = "bypass"
  @State private var permissionTouched = false
  @State private var modelID = ""
  @State private var initialModelID = ""
  @State private var busy = false
  @State private var error: String?
  @State private var discarding = false
  @State private var initial = ""
  private var kinds: [PickerOption<String>] {
    var options: [PickerOption<String>] = []
    if routine?.repeatRule == .null { options.append(PickerOption(value: "legacy", title: L("claudex_schedule_keep_existing"))) }
    options += [
      PickerOption(value: "manual", title: L("scheduled_task_manual_only")),
      PickerOption(value: "once", title: L("routine_create_frequency_once")),
      PickerOption(value: "hourly", title: L("routine_create_frequency_hourly")),
      PickerOption(value: "daily", title: L("routine_create_frequency_daily")),
      PickerOption(value: "weekdays", title: L("routine_create_frequency_weekdays")),
      PickerOption(value: "weekly", title: L("routine_create_frequency_weekly")),
      PickerOption(value: "custom", title: L("routine_create_frequency_custom")),
    ]
    return options
  }
  private var models: [PickerOption<String>] {
    var options = store.availableModels.filter { !$0.hidden }.map { PickerOption(value: $0.id, title: $0.displayName) }
    if modelID.isEmpty || !options.contains(where: { $0.value == modelID }) {
      let current = routine.flatMap { $0.raw["defaultModel"].bool == false ? $0.raw["model"].string : nil } ?? L("scheduled_task_model_default")
      options.insert(PickerOption(value: "", title: current), at: 0)
    }
    return options
  }
  private var cronProblem: CronRule.Problem? { kind == "custom" ? CronRule.problem(cron) : nil }
  private var scheduled: Bool { kind != "manual" && kind != "once" && kind != "legacy" }
  /// A moment that has passed can only be kept by a one-time task that is merely waiting for its run (or paused).
  private var oncePast: Bool {
    guard kind == "once", RoutineContract.oncePast(RoutineContract.onceMoment(onceAt), now: Date().timeIntervalSince1970 * 1000) else { return false }
    guard let routine, let saved = routine.onceAt else { return true }
    return RoutineContract.onceMoment(onceAt) != saved || routine.completedOnce
  }
  private var valid: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && cronProblem == nil && !oncePast
  }
  private var permissionOptions: [PickerOption<String>] {
    Routine.permissionModes.map { PickerOption(value: $0, title: permissionTitle($0), icon: permissionIcon($0), description: permissionDescription($0)) }
  }
  private var cronMessage: String? {
    guard !cron.trimmingCharacters(in: .whitespaces).isEmpty, let problem = cronProblem else { return nil }
    switch problem {
    case .subHourly: return L("routine_create_custom_cron_subhourly_error")
    case .numericOnly: return L("claudex_schedule_cron_numeric")
    case .sundayIsZero: return L("claudex_schedule_cron_sunday")
    case .invalid: return L("claudex_schedule_cron_invalid")
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          VStack(alignment: .leading, spacing: 8) {
            ClaudeTextField(L("generic_name_label"), text: $name, shape: .rounded, identifier: "schedule-name")
            DialogTextArea(placeholder: L("routine_detail_instructions"), text: $prompt, lines: 5...12)
              .accessibilityLabel(L("routine_detail_instructions"))
          }.padding(.horizontal, 12)
          SettingsGroup {
            SettingsPickerRow(icon: .agent, title: L("scheduled_task_model"), options: models, selection: $modelID)
          }
          SettingsGroup(L("scheduled_task_edit_schedule")) {
            SettingsPickerRow(icon: .clock, title: L("scheduled_task_detail_repeats"), options: kinds, selection: $kind)
            if kind == "hourly" {
              SettingsFieldRow(
                title: L("claudex_schedule_minute"), placeholder: "0", keyboard: .numberPad, width: 60,
                text: Binding(get: { minuteText }, set: { minuteText = String($0.filter(\.isNumber).prefix(2)) }),
                identifier: "schedule-minute")
            }
            if kind == "weekly" {
              SettingsPickerRow(
                title: L("routine_create_day_label"),
                options: (0..<7).map { PickerOption(value: $0, title: weekdayName($0)) }, selection: $day)
            }
            if kind == "once" {
              SettingsRow(icon: .calendar, title: L("scheduled_task_edit_date")) {
                DatePicker("", selection: $onceAt, in: min(Date(), onceAt)..., displayedComponents: .date).labelsHidden()
              }
              SettingsRow(icon: .clock, title: L("routine_create_time_label")) {
                DatePicker("", selection: $onceAt, displayedComponents: .hourAndMinute).labelsHidden()
              }
            }
            if ["daily", "weekdays", "weekly"].contains(kind) {
              SettingsFieldRow(
                title: L("routine_create_time_label"), placeholder: "HH:mm", keyboard: .numbersAndPunctuation, width: 100,
                text: $time, identifier: "schedule-time")
            }
            if kind == "custom" {
              SettingsFieldRow(
                title: L("scheduled_task_edit_cron_expression"), placeholder: L("routine_create_custom_cron_placeholder"),
                keyboard: .numbersAndPunctuation, width: 180, text: $cron, identifier: "schedule-cron")
            }
          }
          if let cronMessage { Text(cronMessage).typeStyle(.caption).foregroundStyle(Palette.dangerText).padding(.horizontal, 24) }
          if oncePast { Text(L("routine_create_time_past_error")).typeStyle(.caption).foregroundStyle(Palette.dangerText).padding(.horizontal, 24) }
          if kind == "once" {
            Text(L("claudex_schedule_once_zone_note", TimeZone.current.identifier)).typeStyle(.caption).foregroundStyle(Palette.text500).padding(.horizontal, 24)
          }
          if scheduled {
            Text(L("claudex_schedule_server_time_note")).typeStyle(.caption).foregroundStyle(Palette.text500).padding(.horizontal, 24)
          }
          SettingsGroup {
            SettingsPickerRow(
              icon: permissionIcon(permission), title: L("scheduled_task_edit_permission"), options: permissionOptions,
              selection: Binding(get: { permission }, set: { permission = $0; permissionTouched = true }))
          }
          if let error { InlineNotice(text: error, tone: .error).padding(.horizontal, 12) }
        }.padding(.vertical, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(Palette.bg100.ignoresSafeArea())
      .disabled(busy)
      .pageTitle(routine == nil ? L("scheduled_tasks_new_task") : L("scheduled_task_edit"))
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ClaudeIconButton(.x, label: L("generic_button_close")) {
            if changed { discarding = true } else { dismiss() }
          }.disabled(busy)
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button(L("generic_save")) { Task { await save() } }
            .claudeButton(.primary, size: .small).disabled(busy || !valid)
            .accessibilityIdentifier("schedule-save")
        }
      }
      .alert(L("scheduled_task_edit_discard_title"), isPresented: $discarding) {
        Button(L("scheduled_task_edit_keep_editing"), role: .cancel) {}
        Button(L("scheduled_task_edit_discard"), role: .destructive) { dismiss() }
      }
    }
    .interactiveDismissDisabled(busy || changed)
    .onAppear {
      guard initial.isEmpty else { return }
      if let routine {
        name = routine.name
        prompt = routine.prompt
        let rule = routine.repeatRule
        let stored = rule["kind"].string ?? "legacy"
        kind = stored == "cron" ? "custom" : stored
        time = rule["time"].string ?? "09:00"
        minuteText = String(rule["minute"].integer ?? 0)
        day = rule["day"].integer ?? 1
        if let at = routine.onceAt { onceAt = Date(timeIntervalSince1970: at / 1000) }
        permission = routine.permission ?? "bypass"
        switch stored {
        case "cron": cron = rule["expression"].string ?? ""
        case "custom": cron = CronRule.forDays(time: time, days: (rule["days"].array ?? []).compactMap(\.integer))
        default: cron = ""
        }
        if routine.raw["defaultModel"].bool == false, let id = routine.raw["model"].string,
          routine.raw["providerId"].string == store.selectedProviderID || store.selectedProviderID.isEmpty,
          store.availableModels.contains(where: { $0.id == id }) { modelID = id }
      } else {
        modelID = store.selectedProvider?.model ?? ""
      }
      initialModelID = modelID
      initial = snapshot
    }
  }
  private var snapshot: String {
    [name, prompt, kind, time, String(minute), String(day), cron, modelID, String(RoutineContract.onceMoment(onceAt)), permission].joined(separator: "\u{1F}") + "\u{1F}x"
  }
  private var changed: Bool { !initial.isEmpty && snapshot != initial }
  @MainActor private func save() async {
    guard !busy else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      let settings = store.snapshot?.settings
      let provider = store.selectedProvider ?? settings?.providers.first { $0.id == settings?.activeProviderId } ?? settings?.providers.first
      let rule = kind == "legacy" ? nil : try RoutineContract.validatedRule(
        kind: kind == "custom" ? "cron" : kind, time: time, minute: minute, day: day, days: [], expression: cron,
        at: kind == "once" ? RoutineContract.onceMoment(onceAt) : nil)
      let chosen = modelID != initialModelID && !modelID.isEmpty ? (providerID: provider?.id ?? "", model: modelID) : nil
      // A one-time task that has had its run is switched on again by its new moment.
      let switchOn = kind == "once" && routine?.completedOnce == true
      let input = try RoutineContract.input(
        existing: routine, name: name, description: routine?.raw["description"].string ?? "", prompt: prompt, enabled: switchOn || (routine?.enabled ?? true),
        providerID: provider?.id ?? "", model: routine == nil && !modelID.isEmpty ? modelID : provider?.model ?? "", rule: rule,
        now: Date().timeIntervalSince1970 * 1000, chosenModel: chosen,
        permission: routine == nil || permissionTouched ? permission : nil)
      _ = try await store.accountRequest { try await $0.saveSchedule(input) }
      dismiss()
      saved()
    } catch is CancellationError {} catch {
      self.error = (error as? ServiceError) == .invalidResponse
        ? L("claudex_schedule_invalid") : error.localizedDescription
      store.validateSessionError(error)
    }
  }
}

/// The official approval-mode words (`approval_mode_*`) for a task's permission mode.
func permissionTitle(_ mode: String) -> String {
  switch mode {
  case "default": L("approval_mode_manual_title")
  case "auto": L("approval_mode_auto_title")
  default: L("approval_mode_skip_title")
  }
}

func permissionDescription(_ mode: String) -> String {
  switch mode {
  case "default": L("approval_mode_manual_description")
  case "auto": L("approval_mode_auto_description")
  default: L("approval_mode_skip_description")
  }
}

func permissionIcon(_ mode: String) -> AppGlyph {
  switch mode {
  case "default": .hand
  case "auto": .lightning
  default: .warningShield
  }
}

/// "Run command (npm test)": one kept approval as the task's Always allowed list names it.
func allowedLabel(_ entry: RoutineAllowed) -> String {
  let tool: String
  switch (entry.kind, entry.tool) {
  case ("command", "Network"): tool = L("claudex_allowed_network")
  case ("command", _): tool = L("claudex_allowed_command")
  case ("edit", _): tool = L("claudex_allowed_edit")
  case ("permission", _): tool = L("claudex_allowed_permission")
  default: tool = entry.tool
  }
  return entry.pattern.map { L("scheduled_task_detail_allowed_tool_with_pattern", tool, $0) } ?? tool
}

enum RoutineDefaults {
  /// A new one-time task starts tomorrow at the next whole hour.
  static func onceMoment(_ now: Date, calendar: Calendar = .current) -> Date {
    let hour = calendar.date(byAdding: .hour, value: 1, to: calendar.date(from: calendar.dateComponents([.year, .month, .day, .hour], from: now)) ?? now) ?? now
    return calendar.date(byAdding: .day, value: 1, to: hour) ?? hour
  }
}

func routineStatus(_ value: String) -> String {
  switch value {
  case "starting", "running": L("routine_run_status_running")
  case "completed": L("routine_run_status_completed")
  case "failed": L("claudex_task_status_failed")
  case "interrupted": L("routine_run_status_cancelled")
  default: value
  }
}

func weekdayName(_ value: Int) -> String {
  var calendar = Calendar(identifier: .gregorian)
  calendar.locale = Locale(identifier: L10n.catalog.language)
  let symbols = calendar.weekdaySymbols
  return symbols[min(6, max(0, value))]
}

func routineRuleLabel(_ routine: Routine) -> String {
  let rule = routine.repeatRule, time = rule["time"].string ?? ""
  switch rule["kind"].string {
  case "manual": return L("scheduled_task_manual_only")
  case "once": return L("scheduled_task_once", rule["at"].number.map(shortDate) ?? "")
  case "hourly": return L("claudex_schedule_hourly_at", rule["minute"].integer ?? 0)
  case "daily": return L("scheduled_task_daily", time)
  case "weekdays": return L("scheduled_task_weekdays", time)
  case "weekly": return L("scheduled_task_weekly", weekdayName(rule["day"].integer ?? 0), time)
  case "custom":
    return customRuleLabel(days: (rule["days"].array ?? []).compactMap(\.integer), time: time)
  case "cron":
    let expression = rule["expression"].string ?? ""
    guard let simple = CronRule.asDays(expression) else { return L("claudex_schedule_cron", expression) }
    return customRuleLabel(days: simple.days, time: simple.time)
  default: return L("claudex_schedule_existing", routine.raw["frequency"].string ?? "")
  }
}

/// Chosen days at a time, worded like the other rules when they are every day, one day or the weekdays.
private func customRuleLabel(days: [Int], time: String) -> String {
  let distinct = Array(Set(days)).sorted()
  if distinct.count == 7 { return L("scheduled_task_daily", time) }
  if distinct.count == 1 { return L("scheduled_task_weekly", weekdayName(distinct[0]), time) }
  if distinct == [1, 2, 3, 4, 5] { return L("scheduled_task_weekdays", time) }
  return L("claudex_schedule_custom_at", distinct.map(weekdayName).joined(separator: L("claudex_list_separator")), time)
}
