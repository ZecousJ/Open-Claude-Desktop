import SwiftUI

/// "Select mode": the cloud Code permission modes the service offers, each a row with icon, title (strong when
/// selected), description and the selected check. Bypass asks for confirmation first. Only modes the service lists
/// are shown; nothing is synthesized from defaults.
struct PermissionModeSheet: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingBypassContext: Int?
  @State private var error: String?
  private var form: CloudPermissionForm { store.codePermissionForm }
  private var blocked: Bool {
    form.availability != .ready || store.account == nil || store.isSending || store.hasRunningTask
  }

  static func title(_ mode: CloudPermissionMode) -> String {
    switch mode {
    case .manual: L("ccr_permission_mode_ask_title")
    case .acceptEdits: L("ccr_permission_mode_act_title")
    case .plan: L("ccr_permission_mode_plan_title")
    case .auto: L("ccr_permission_mode_auto_title")
    case .bypass: L("ccr_mode_bypass")
    }
  }
  static func detail(_ mode: CloudPermissionMode) -> String {
    switch mode {
    case .manual: L("ccr_permission_mode_ask_description")
    case .acceptEdits: L("ccr_permission_mode_act_description")
    case .plan: L("ccr_permission_mode_plan_description")
    case .auto: L("ccr_permission_mode_auto_description")
    case .bypass: L("claudex_permission_mode_bypass_description")
    }
  }
  static func icon(_ mode: CloudPermissionMode?) -> AppGlyph {
    switch mode {
    case .manual: .hand
    case .acceptEdits: .code
    case .plan: .scroll
    case .auto, .bypass: .lightning
    case nil: .hand
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: L("ccr_permission_mode_title"))
      Text(L("ccr_permission_mode_subtitle")).typeStyle(.body).foregroundStyle(Palette.text500)
        .padding(.horizontal, 24).padding(.bottom, 8)
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          if form.availability == .loading || form.availability == .changing {
            ListLoading()
          }
          ForEach(form.modes, id: \.rawValue) { mode in
            row(mode)
          }
          VStack(alignment: .leading, spacing: 8) {
            if form.modes.contains(.bypass) && form.bypassDisabled {
              note(L("claudex_permission_bypass_off"))
            }
            if store.hasRunningTask { note(L("claudex_permission_running_task")) }
            if form.availability == .unavailable || form.availability == .invalid {
              note(L("claudex_permission_unavailable"))
            }
            if let error { InlineNotice(text: error, tone: .error) }
            if let environment = store.snapshot?.host?["cloud"]["environments"].array?.first(where: { $0["isDefault"].bool == true }) {
              note(L("claudex_permission_environment", networkTitle(environment["network"].string)))
            }
          }.padding(.horizontal, 24).padding(.top, 12)
        }.padding(.bottom, 24)
      }
    }
    .claudeSheetChrome([.medium, .large])
    .alert(
      L("claudex_permission_bypass_confirm_title"),
      isPresented: Binding(get: { confirmingBypassContext != nil }, set: { if !$0 { confirmingBypassContext = nil } })
    ) {
      Button(L("generic_button_cancel"), role: .cancel) { confirmingBypassContext = nil }
      Button(L("generic_button_continue"), role: .destructive) {
        let context = confirmingBypassContext
        confirmingBypassContext = nil
        if context == store.codePermissionContextID { Task { await save(.bypass, confirmed: true, context: context) } }
      }
    } message: {
      Text(L("claudex_permission_bypass_confirm_body"))
    }
    .onChange(of: store.codePermissionContextID) { _, _ in
      confirmingBypassContext = nil
      error = nil
    }
  }

  private func row(_ mode: CloudPermissionMode) -> some View {
    let selected = form.selected == mode
    return Button { choose(mode) } label: {
      HStack(alignment: .top, spacing: 12) {
        AppGlyphView(Self.icon(mode)).foregroundStyle(Palette.text100)
        VStack(alignment: .leading, spacing: 2) {
          Text(Self.title(mode)).typeStyle(selected ? .bodyLargeStrong : .bodyLarge).foregroundStyle(Palette.text100)
          Text(Self.detail(mode)).typeStyle(.body).foregroundStyle(Palette.text500)
            .fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
        if selected { AppGlyphView(.check, size: 20).foregroundStyle(Palette.text100) }
      }
      .padding(.horizontal, 24).padding(.vertical, 12).contentShape(Rectangle())
    }
    .buttonStyle(RowPressStyle())
    .disabled(blocked || !form.canSelect(mode))
    .opacity(blocked || !form.canSelect(mode) ? (selected ? 1 : 0.38) : 1)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("permission-mode-" + mode.rawValue)
  }

  private func note(_ text: String) -> some View {
    Text(text).typeStyle(.caption).foregroundStyle(Palette.text500).fixedSize(horizontal: false, vertical: true)
  }

  private func choose(_ mode: CloudPermissionMode) {
    guard !blocked, form.canSelect(mode), mode != form.selected else { return }
    error = nil
    if mode == .bypass {
      confirmingBypassContext = store.codePermissionContextID
    } else {
      let context = store.codePermissionContextID
      Task { await save(mode, context: context) }
    }
  }

  private func networkTitle(_ value: String?) -> String {
    switch value {
    case "trusted": L("ccr_onboarding_network_trusted")
    case "full": L("ccr_onboarding_network_full")
    case "none": L("ccr_onboarding_network_none")
    default: L("claudex_environment_network_managed")
    }
  }

  private func save(_ mode: CloudPermissionMode, confirmed: Bool = false, context: Int?) async {
    guard context == store.codePermissionContextID else { return }
    let success = await store.setCodePermission(mode, confirmed: confirmed)
    guard context == store.codePermissionContextID else { return }
    if success { dismiss() } else { error = store.errorMessage ?? L("ccr_permission_mode_apply_failed") }
  }
}

/// The earlier name of the permission picker.
typealias CloudPermissionView = PermissionModeSheet
