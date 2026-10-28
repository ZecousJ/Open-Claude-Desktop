import SwiftUI

/// The account's online desktops and the Code conversation opened on one
/// (Core/RemoteDevices.swift). Device events arrive on the account's stream;
/// AppStore hands them here.
@MainActor final class DeviceController: ObservableObject {
  @Published private(set) var devices: [DeviceInfo] = []
  @Published private(set) var loaded = false
  @Published private(set) var conversations: [String: [DeviceConversationSummary]] = [:]
  @Published private(set) var open: DeviceConversationState?
  @Published private(set) var sending = false
  /// Computer id → the folders phones may start sessions in.
  @Published private(set) var directories: [String: [DeviceDirectory]] = [:]
  /// Computer id → the folder picked for new sessions (the default folder otherwise).
  @Published var chosenDirectory: [String: String] = [:]
  @Published var error: String?
  var client: DeviceClient?
  private var generation = 0
  private var renewTask: Task<Void, Never>?
  private var devicesTask: Task<Void, Never>?
  private var listTasks: [String: Task<Void, Never>] = [:]

  func reset() {
    generation += 1
    renewTask?.cancel(); renewTask = nil
    devicesTask?.cancel(); devicesTask = nil
    for task in listTasks.values { task.cancel() }; listTasks = [:]
    devices = []; loaded = false; conversations = [:]; open = nil; sending = false; error = nil
    directories = [:]; chosenDirectory = [:]
  }

  /// The folder new sessions start in: the picked one if it is still offered, else the default, else the first.
  func directory(for device: String) -> DeviceDirectory? {
    let list = directories[device] ?? []
    return list.first { $0.path == chosenDirectory[device] } ?? list.first { $0.isDefault } ?? list.first
  }

  func loadDirectories(_ device: String) async {
    guard let client else { return }
    let epoch = generation
    do {
      let list = try await client.directories(device)
      guard epoch == generation else { return }
      directories[device] = list
    } catch is CancellationError {
    } catch {
      guard epoch == generation else { return }
      self.error = error.localizedDescription
    }
  }

  /// Starts a session in the chosen folder with its first message; the id of the session to open, or nil (the reason is in `error`).
  func startSession(_ device: String, text: String) async -> String? {
    guard let client, !sending, let directory = directory(for: device) else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    sending = true; defer { sending = false }
    do {
      let id = try await client.newSession(device, cwd: directory.path, text: trimmed)
      await loadConversations(device)
      return id
    } catch { self.error = error.localizedDescription; return nil }
  }

  /// "End session" on a row or in the session's menu; true once the computer archived it.
  func endSession(_ device: String, _ id: String) async -> Bool {
    guard let client else { return false }
    do {
      try await client.endSession(device, conversationID: id)
      conversations[device]?.removeAll { $0.id == id }
      await loadConversations(device)
      return true
    } catch { self.error = L("claudex_device_end_failed"); return false }
  }

  func models(_ device: String) async -> DeviceModels? {
    guard let client else { return nil }
    do { return try await client.models(device) } catch { self.error = error.localizedDescription; return nil }
  }

  /// "Change model" in the session's menu; true once saved.
  func setModel(_ device: String, _ id: String, _ model: DeviceModelOption) async -> Bool {
    guard let client else { return false }
    do { try await client.setModel(device, conversationID: id, model: model); await openConversation(device, id); return true }
    catch { self.error = L("ccr_model_save_failed"); return false }
  }

  func loadDevices() async {
    guard let client else { return }
    let epoch = generation
    do {
      let next = try await client.devices()
      guard epoch == generation else { return }
      devices = next; loaded = true
      // A computer that went away takes its lists with it.
      conversations = conversations.filter { pair in next.contains { $0.id == pair.key } }
    } catch is CancellationError {
    } catch {
      guard epoch == generation else { return }
      loaded = true; self.error = error.localizedDescription
    }
  }

  func loadConversations(_ device: String) async {
    guard let client else { return }
    let epoch = generation
    do {
      let list = try await client.conversations(device)
      guard epoch == generation else { return }
      conversations[device] = list
    } catch is CancellationError {
    } catch {
      guard epoch == generation else { return }
      self.error = error.localizedDescription
    }
  }

  func openConversation(_ device: String, _ id: String) async {
    guard let client else { return }
    let epoch = generation
    do {
      let state = try await client.open(device, conversationID: id)
      guard epoch == generation else { return }
      open = state
      renew(device, id)
    } catch is CancellationError {
    } catch {
      guard epoch == generation else { return }
      self.error = error.localizedDescription
    }
  }

  /// The computer streams a conversation for a few minutes after it was
  /// opened: ask again while it stays on screen.
  private func renew(_ device: String, _ id: String) {
    renewTask?.cancel()
    renewTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(150))
        guard !Task.isCancelled, let self, self.open?.conversation.id == id, let client = self.client else { return }
        if let state = try? await client.open(device, conversationID: id), self.open?.conversation.id == id { self.open = state }
      }
    }
  }

  func close(_ id: String) {
    guard open?.conversation.id == id else { return }
    renewTask?.cancel(); renewTask = nil
    open = nil
  }

  func send(_ text: String) async -> Bool {
    guard let client, let open, !sending else { return false }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    sending = true; defer { sending = false }
    do { try await client.send(open.deviceID, conversationID: open.conversation.id, text: trimmed); return true }
    catch { self.error = error.localizedDescription; return false }
  }

  func interrupt() async {
    guard let client, let open else { return }
    do { try await client.interrupt(open.deviceID, conversationID: open.conversation.id) }
    catch { self.error = error.localizedDescription }
  }

  /// Answers a computer's request with the response its card built (the computer's engine applies it, and
  /// refuses a session grant the administrator turned off).
  func approve(_ approval: JSONValue, response: JSONValue) async throws {
    guard let client, let open else { return }
    try await client.approve(open.deviceID, approvalID: approval["id"], decision: response)
  }

  func receive(_ event: DeviceStreamEvent) {
    switch event {
    case .devicesChanged:
      devicesTask?.cancel()
      devicesTask = Task { [weak self] in
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        await self?.loadDevices()
        // Back online after a restart: open it again so it streams.
        if let self, let open = self.open, self.devices.contains(where: { $0.id == open.deviceID }) {
          await self.openConversation(open.deviceID, open.conversation.id)
        }
      }
    case .device(let id, let inner):
      if inner["type"].string == "device-conversations" {
        guard conversations[id] != nil else { return }
        listTasks[id]?.cancel()
        listTasks[id] = Task { [weak self] in
          try? await Task.sleep(for: .milliseconds(200))
          guard !Task.isCancelled else { return }
          await self?.loadConversations(id)
          if self?.directories[id] != nil { await self?.loadDirectories(id) }
        }
        return
      }
      guard var state = open, state.deviceID == id else { return }
      if state.apply(inner) { open = state }
    }
  }
}

/// The Code screen's Devices row: a horizontal row of pill chips, one per computer signed in to this account (the
/// service lists the ones that are on), then "Add device", which explains how to connect a computer. Statuses are
/// static list states; there is never a connecting / reconnecting text.
struct DeviceSection: View {
  @EnvironmentObject private var store: AppStore
  @ObservedObject var devices: DeviceController
  @State private var connecting = false
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(L("ccr_devices_section_title")).typeStyle(.body).foregroundStyle(Palette.text300)
        .padding(.horizontal, 24).accessibilityAddTraits(.isHeader)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          if !devices.loaded {
            ClaudeSpinner(size: .xSmall).frame(height: 44).padding(.horizontal, 12)
          }
          ForEach(devices.devices) { device in
            NavigationLink { DeviceConversationsView(devices: devices, device: device) } label: {
              DeviceChip(icon: .laptop, title: device.name, online: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(device.name), \(L("ccr_devices_status_active"))")
            .accessibilityHint(L("ccr_devices_picker_action"))
            .accessibilityIdentifier("device-" + device.id)
          }
          Button { connecting = true } label: { DeviceChip(icon: .add, title: L("ccr_devices_add_device"), online: nil) }
            .buttonStyle(.plain)
            .accessibilityHint(L("ccr_devices_setup_title"))
            .accessibilityIdentifier("device-add")
        }.padding(.horizontal, 16).padding(.vertical, 4)
      }
    }
    .padding(.top, 8)
    .task { await devices.loadDevices() }
    .sheet(isPresented: $connecting) { ConnectComputerSheet(deviceName: nil) }
  }
}

/// A device chip: pill, min 44pt, 12/4/16/4 padding, 8pt spacing; online = raised (`surfaceSunken` fill, hairline,
/// 4pt shadow) with a green dot on the laptop; offline = outline only with `laptopSlash` and muted name; "Add device"
/// uses the online frame.
struct DeviceChip: View {
  let icon: AppGlyph
  let title: String
  /// true online, false offline, nil = the "Add device" chip.
  let online: Bool?
  var body: some View {
    HStack(spacing: 8) {
      AppGlyphView(online == false ? .laptopSlash : icon)
        .overlay(alignment: .bottomTrailing) {
          if online == true {
            Circle().fill(Palette.successSolid).frame(width: 8, height: 8)
              .overlay(Circle().stroke(Palette.surfaceSunken, lineWidth: 1.5))
          }
        }
      Text(title).typeStyle(.body).lineLimit(1).frame(maxWidth: 112, alignment: .leading).fixedSize(horizontal: true, vertical: false)
    }
    .foregroundStyle(online == false ? Palette.textTertiary : Palette.textPrimary)
    .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 4)
    .frame(minHeight: 44)
    .background {
      if online != false {
        Capsule().fill(Palette.surfaceSunken).shadow(color: .black.opacity(0.08), radius: 4, y: 1)
      }
    }
    .overlay(Capsule().strokeBorder(Palette.borderDefault, lineWidth: 1))
    .contentShape(Capsule())
  }
}

/// "Connect your computer" / "Reconnect your computer", worded for Claudex: there is no terminal command — the
/// computer appears once Claudex is open on it and signed in to this account.
struct ConnectComputerSheet: View {
  /// A known computer that went away (the reconnect wording), or nil for setup.
  let deviceName: String?
  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: deviceName == nil ? L("ccr_devices_setup_title") : L("ccr_devices_asleep_title"))
      ScrollView {
        VStack(spacing: 24) {
          AppGlyphView(.laptop, size: 48).foregroundStyle(Palette.textSecondary)
          if let deviceName {
            paragraph(L("ccr_devices_asleep_lead", deviceName))
            paragraph(L("claudex_devices_asleep_instruction"))
          } else {
            paragraph(L("claudex_devices_setup_body"))
            paragraph(L("ccr_devices_setup_footer"))
          }
          HStack(spacing: 12) {
            Rectangle().fill(Palette.borderDefault).frame(height: 1)
            Text(L("ccr_devices_setup_or")).typeStyle(.caption).foregroundStyle(Palette.textSecondary)
            Rectangle().fill(Palette.borderDefault).frame(height: 1)
          }
          HStack(alignment: .top, spacing: 8) {
            AppGlyphView(.laptop, size: 20).foregroundStyle(Palette.textSecondary)
            Text(L("claudex_devices_desktop_hint")).typeStyle(.caption).foregroundStyle(Palette.textSecondary)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(.horizontal, Spacing.sheetGutter).padding(.top, 40).padding(.bottom, 24)
      }
    }
    .claudeSheetChrome([.medium, .large])
  }
  private func paragraph(_ text: String) -> some View {
    Text(text).typeStyle(.body).foregroundStyle(Palette.textSecondary).multilineTextAlignment(.center)
      .frame(maxWidth: .infinity)
  }
}

/// A computer's Code sessions (`DeviceSessions`): its status line, then the sessions with the
/// folder and time; tap opens the session on the computer.
struct DeviceConversationsView: View {
  @ObservedObject var devices: DeviceController
  let device: DeviceInfo
  @State private var picking = false
  @State private var ending: Set<String> = []
  private var list: [DeviceConversationSummary]? { devices.conversations[device.id] }
  /// Until the device list has loaded, the computer counts as online (it was just listed).
  private var online: Bool { !devices.loaded || devices.devices.contains { $0.id == device.id } }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        // The computer itself: its name and platform, with the connection status (as on Android).
        SettingsGroup {
          SettingsRow(
            icon: online ? .laptop : .laptopSlash, title: device.name,
            subtitle: [device.platformName, device.version].filter { !$0.isEmpty }.joined(separator: " · ")
          ) {
            Text(online ? L("ccr_devices_status_active") : L("ccr_devices_status_asleep")).typeStyle(.caption)
              .foregroundStyle(Palette.text500)
          }
        }.padding(.vertical, 12)
        // The folder new sessions start in, then New session (`code/remote/devices/e` c and d).
        if online, let directory = devices.directory(for: device.id) {
          SettingsGroup {
            Button { picking = true } label: {
              SettingsRow(icon: .folder, title: L("ccr_device_directory_label"), subtitle: directory.name) {
                AppGlyphView(.caretRight, size: 20).foregroundStyle(Palette.text500)
              }
            }.buttonStyle(SettingsRowPressStyle())
              .accessibilityHint(L("ccr_device_new_session_directory_hint")).accessibilityIdentifier("device-directory")
          }
          NavigationLink { DeviceNewSessionView(devices: devices, device: device) } label: {
            Text(L("new_session")).frame(maxWidth: .infinity)
          }
          .claudeButton(.primary, size: .large, fullWidth: true).padding(.horizontal, 16).padding(.vertical, 12)
          .accessibilityIdentifier("device-new-session")
        } else if online, devices.directories[device.id] != nil {
          Text(L("claudex_device_no_directories")).typeStyle(.body).foregroundStyle(Palette.text500)
            .padding(.horizontal, 24).padding(.bottom, 12)
        }
        if online {
          Text(L("ccr_paired_active_sessions_title")).typeStyle(.body).foregroundStyle(Palette.text300)
            .padding(.horizontal, 24).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
        }
        if !online {
          VStack(spacing: 12) {
            Text(L("ccr_devices_asleep_lead", device.name)).typeStyle(.body).foregroundStyle(Palette.textSecondary)
            Text(L("claudex_devices_asleep_instruction")).typeStyle(.body).foregroundStyle(Palette.textSecondary)
          }.multilineTextAlignment(.center).padding(24).frame(maxWidth: .infinity)
        } else if list == nil {
          ListLoading()
        } else if list?.isEmpty == true {
          OfficialEmptyState(icon: .laptop, text: L("ccr_device_no_active_sessions"), iconSize: 48).padding(.top, 32)
        }
        if online {
          ForEach(list ?? []) { item in
            HStack(spacing: 4) {
              NavigationLink { DeviceConversationView(devices: devices, device: device, summary: item) } label: {
                DeviceSessionRow(item: item)
              }
              .buttonStyle(RowPressStyle(radius: Radius.r10))
              .accessibilityIdentifier("device-conversation-" + item.id)
              // `ccr_paired_end_session`: a small button on the row, no confirmation.
              Button {
                ending.insert(item.id)
                Task { _ = await devices.endSession(device.id, item.id); ending.remove(item.id) }
              } label: {
                if ending.contains(item.id) { ClaudeSpinner(size: .xSmall) } else { Text(L("ccr_paired_end_session")) }
              }
              .claudeButton(.secondary, size: .small).disabled(ending.contains(item.id))
              .accessibilityIdentifier("device-end-" + item.id)
            }.padding(.horizontal, 12)
          }
        }
      }.padding(.bottom, 24)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(device.name, serif: false)
    .refreshable { await devices.loadConversations(device.id); await devices.loadDirectories(device.id) }
    .task(id: device.id) {
      if !devices.loaded { await devices.loadDevices() }
      await devices.loadConversations(device.id)
      await devices.loadDirectories(device.id)
    }
    .claudeSheet(isPresented: $picking) { DeviceDirectorySheet(devices: devices, device: device) }
  }
}

/// A session row on a computer: title, "folder · time" (`ccr_paired_no_folder` without one),
/// a Waiting mark when it asks for approval, the Working spinner while it runs.
private struct DeviceSessionRow: View {
  let item: DeviceConversationSummary
  var body: some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 0) {
        Text(item.title.isEmpty ? L("generic_untitled") : item.title).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
          .lineLimit(2)
        Text([item.folderName ?? L("ccr_paired_no_folder"), RelativeTime.string(ms: item.updatedAt)].joined(separator: " · "))
          .typeStyle(.body).foregroundStyle(Palette.text500).lineLimit(1)
      }.frame(maxWidth: .infinity, alignment: .leading)
      if item.approvals > 0 {
        AppGlyphView(.warning, size: 16).foregroundStyle(Palette.warning)
          .accessibilityLabel(L("cds_list_row_status_waiting"))
      } else if item.running {
        ClaudeSpinner(size: .icon, color: Palette.textSecondary)
          .accessibilityLabel(L("cds_list_row_status_working"))
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 56)
    .contentShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
  }
}

/// One Code session on a computer: its transcript, its approvals and a composer that sends to it
/// there.
struct DeviceConversationView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var devices: DeviceController
  let device: DeviceInfo
  let summary: DeviceConversationSummary
  @State private var text = ""
  @State private var changingModel = false
  private var state: DeviceConversationState? {
    devices.open.flatMap { $0.deviceID == device.id && $0.conversation.id == summary.id ? $0 : nil }
  }
  var body: some View {
    VStack(spacing: 0) {
      if let state {
        SharedConversationView(conversation: state.conversation, remoteSending: devices.sending || state.running)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        if !state.approvals.isEmpty {
          ScrollView {
            VStack(spacing: 12) {
              ForEach(Array(state.approvals.enumerated()), id: \.offset) { _, approval in
                ApprovalRequestView(approval: approval, conversation: state.conversation, onDevice: true,
                                    answerHandler: { response in try await devices.approve(approval, response: response) })
              }
            }.padding(12)
          }.frame(maxHeight: 240)
        }
      } else {
        LoadingState()
      }
    }
    .background(Palette.bg100.ignoresSafeArea())
    .safeAreaInset(edge: .bottom) {
      DeviceComposerBar(deviceName: device.name, text: $text, canSend: canSend, sending: devices.sending, running: state?.running == true,
                        stop: { Task { await devices.interrupt() } },
                        send: { let message = text; Task { if await devices.send(message) { text = "" } } })
        .padding(.horizontal, 12).padding(.bottom, 8).background(Palette.bg100)
    }
    .pageTitle(state?.conversation.title ?? summary.title, serif: false)
    .toolbar {
      if let state {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            MenuItem(L("session_menu_change_model"), icon: .extendedThinking) { changingModel = true }
            MenuItem(L("ccr_paired_end_session"), icon: .archive) {
              Task { if await devices.endSession(device.id, state.conversation.id) { dismiss() } }
            }
          } label: { AppGlyphView(.dotsVertical) }
            .accessibilityLabel(L("generic_button_more_options")).accessibilityIdentifier("device-session-menu")
        }
      }
    }
    .claudeSheet(isPresented: $changingModel) {
      if let state { DeviceModelSheet(devices: devices, device: device, conversation: state.conversation) }
    }
    .task(id: summary.id) { await devices.openConversation(device.id, summary.id) }
    .onDisappear { devices.close(summary.id) }
    .onChange(of: devices.error) { _, message in
      if let message {
        Snackbars.shared.show(message, kind: .warning)
        devices.error = nil
      }
    }
  }
  private var canSend: Bool {
    state != nil && !devices.sending && !(state?.running ?? false)
      && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}

/// New session on a computer: the folder it starts in (picked on the computer's page), then the first message.
/// The computer creates the session with that message, so the page opens it when the computer answers.
struct DeviceNewSessionView: View {
  @ObservedObject var devices: DeviceController
  let device: DeviceInfo
  @State private var text = ""
  @State private var created: DeviceConversationSummary?
  private var directory: DeviceDirectory? { devices.directory(for: device.id) }
  private var canSend: Bool {
    directory != nil && !devices.sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  var body: some View {
    ScrollView {
      SettingsGroup {
        SettingsRow(icon: .folder, title: L("ccr_device_directory_label"), subtitle: directory?.name ?? L("ccr_paired_no_folder"))
      }.padding(.vertical, 12)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .safeAreaInset(edge: .bottom) {
      DeviceComposerBar(deviceName: device.name, text: $text, canSend: canSend, sending: devices.sending, running: false,
                        hint: L("claudex_device_new_hint", directory?.name ?? ""), stop: {},
                        send: {
                          let message = text
                          Task {
                            guard let id = await devices.startSession(device.id, text: message) else { return }
                            text = ""
                            created = DeviceConversationSummary(id: id, title: "", cwd: directory?.path, updatedAt: Date().timeIntervalSince1970 * 1000, running: true, approvals: 0, model: "")
                          }
                        })
        .padding(.horizontal, 12).padding(.bottom, 8).background(Palette.bg100)
    }
    .pageTitle(L("new_session"), serif: false)
    .navigationDestination(item: $created) { DeviceConversationView(devices: devices, device: device, summary: $0) }
    .task(id: device.id) { if devices.directories[device.id] == nil { await devices.loadDirectories(device.id) } }
    .onChange(of: devices.error) { _, message in
      if let message {
        Snackbars.shared.show(message, kind: .warning)
        devices.error = nil
      }
    }
  }
}

/// The composer of a computer's session: the text, the computer's name, Stop while a turn runs and Send.
struct DeviceComposerBar: View {
  let deviceName: String
  @Binding var text: String
  let canSend: Bool
  let sending: Bool
  let running: Bool
  var hint: String?
  let stop: () -> Void
  let send: () -> Void
  @FocusState private var focused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField(text: $text, axis: .vertical) {
        Text(hint ?? L("claudex_device_composer_placeholder", deviceName)).foregroundStyle(Palette.text500)
      }
      .lineLimit(1...6).focused($focused).typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
      .tint(Palette.accentMain100)
      .padding(.horizontal, 4).padding(.top, 4).accessibilityIdentifier("device-composer-input")
      HStack(spacing: 8) {
        HStack(spacing: 4) {
          AppGlyphView(.laptop, size: 20)
          Text(deviceName).typeStyle(.caption).lineLimit(1)
        }.foregroundStyle(Palette.text500)
        Spacer(minLength: 0)
        if running {
          Button {
            focused = false
            stop()
          } label: {
            AppGlyphView(.stopFilled, size: 20).frame(width: 36, height: 36)
              .background(Palette.bg300, in: Circle())
          }.buttonStyle(.plain).foregroundStyle(Palette.text100)
            .accessibilityLabel(L("claudex_device_stop")).accessibilityIdentifier("device-stop")
        }
        Button {
          focused = false
          send()
        } label: {
          Group {
            if sending {
              ClaudeSpinner(size: .xSmall, color: Palette.oncolor100)
            } else {
              AppGlyphView(.arrowUp, size: 20)
            }
          }
          .frame(width: 36, height: 36).foregroundStyle(Palette.oncolor100)
          .background(canSend ? Palette.brandFill : Palette.disabledFill, in: Circle())
        }.buttonStyle(.plain).disabled(!canSend)
          .accessibilityLabel(L("claudex_device_send")).accessibilityIdentifier("device-send")
      }
    }
    .padding(12)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r20, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r20, style: .continuous).strokeBorder(Palette.border300, lineWidth: 0.5))
  }
}

/// Directory picker (`DeviceDirectories`): "Choose a directory"; the default folder carries its badge, the chosen one a check.
struct DeviceDirectorySheet: View {
  @ObservedObject var devices: DeviceController
  let device: DeviceInfo
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    let list = devices.directories[device.id] ?? []
    let current = devices.directory(for: device.id)
    VStack(spacing: 0) {
      SheetHeader(title: L("ccr_device_directory_label"))
      Text(L("ccr_devices_directory_picker_subtitle")).typeStyle(.body).foregroundStyle(Palette.textSecondary)
        .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.vertical, 4)
      ScrollView {
        OptionGroup {
          ForEach(Array(list.enumerated()), id: \.element.id) { index, directory in
            Button {
              devices.chosenDirectory[device.id] = directory.path
              dismiss()
            } label: {
              OptionRow(icon: .folder, title: directory.name,
                        subtitle: L10n.plural("ccr_device_active_sessions_header", count: directory.sessions, directory.sessions),
                        selected: directory.path == current?.path, position: .at(index, of: list.count)) {
                HStack(spacing: 8) {
                  if directory.isDefault { ModelBadge(text: L("ccr_device_picker_default_badge")) }
                  AppGlyphView(.check).foregroundStyle(Palette.text100).opacity(directory.path == current?.path ? 1 : 0)
                }
              }
            }
            .buttonStyle(RowPressStyle(radius: Radius.r16))
            .accessibilityAddTraits(directory.path == current?.path ? .isSelected : [])
          }
        }.padding(.top, 12).padding(.bottom, 24)
      }
    }.background(Palette.bg100)
  }
}

/// "Change model" for a session on a computer: the models that computer's services offer; the session uses the
/// pick from its next message.
struct DeviceModelSheet: View {
  @ObservedObject var devices: DeviceController
  let device: DeviceInfo
  let conversation: Conversation
  @Environment(\.dismiss) private var dismiss
  @State private var models: DeviceModels?
  @State private var saving: DeviceModelOption?
  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: L("chat_options_select_model"))
      ScrollView {
        if let models {
          if models.models.isEmpty {
            OptionGroup { OptionRow(title: L("claudex_no_models")) }.padding(.top, 12)
          } else {
            OptionGroup {
              ForEach(Array(models.models.enumerated()), id: \.element) { index, model in
                let selected = model.id == conversation.model && model.providerId == conversation.providerId
                Button {
                  guard saving == nil else { return }
                  saving = model
                  Task {
                    let ok = await devices.setModel(device.id, conversation.id, model)
                    saving = nil
                    if ok { dismiss() }
                  }
                } label: {
                  OptionRow(title: model.id, selected: selected, position: .at(index, of: models.models.count)) {
                    if saving == model { ClaudeSpinner(size: .xSmall) }
                    else { AppGlyphView(.check).foregroundStyle(Palette.text100).opacity(selected ? 1 : 0) }
                  }
                }
                .buttonStyle(RowPressStyle(radius: Radius.r16)).disabled(saving != nil)
                .accessibilityAddTraits(selected ? .isSelected : [])
              }
            }.padding(.top, 12).padding(.bottom, 24)
          }
        } else {
          ListLoading()
        }
      }
    }
    .background(Palette.bg100)
    .task { models = await devices.models(device.id) ?? DeviceModels(models: [], default: nil) }
  }
}
