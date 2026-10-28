import SwiftUI

/// Sign-in steps after the welcome page. Claudex keeps its own email + password, email code and
/// two-step verification; each step uses the official "magic link sent" page layout.
enum LoginStep: Hashable { case password, emailCode, twoFactor }

/// State and actions shared by the welcome page and its steps.
@MainActor
final class LoginFlow: ObservableObject {
  @Published var email = ""
  @Published var password = ""
  @Published var code = ""
  @Published var useEmailCode = false
  @Published var twoFactorAccount: String?
  @Published var error: String?
  @Published var emailError: String?
  @Published var busy = false
  @Published var options: JSONValue = .null
  @Published var resendAfter = Date.distantPast
  @Published var path: [LoginStep] = []

  var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
  var emailValid: Bool {
    let parts = trimmedEmail.split(separator: "@", omittingEmptySubsequences: false)
    return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !parts[1].hasSuffix(".")
      && !trimmedEmail.contains(" ")
  }
  var emailCodeAvailable: Bool { options["email_code_login"].bool == true }

  /// Welcome page submit: validate, then go to the password or email-code step.
  func submitEmail(_ store: AppStore) async {
    error = nil
    guard emailValid else {
      emailError = L("login_welcome_email_error_invalid_email")
      return
    }
    emailError = nil
    if useEmailCode {
      if await sendCode(store) { path = [.emailCode] }
    } else {
      path = [.password]
    }
  }

  @discardableResult
  func sendCode(_ store: AppStore) async -> Bool {
    guard let session = store.session else { return false }
    busy = true
    error = nil
    defer { busy = false }
    do {
      let seconds = try await session.requestSignInCode(email: trimmedEmail)
      resendAfter = Date().addingTimeInterval(Double(seconds))
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }

  func signIn(_ store: AppStore) async {
    guard let session = store.session, !busy else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      let result: LoginOutcome
      if twoFactorAccount != nil {
        result = try await session.completeTwoFactor(code: code)
      } else if useEmailCode {
        result = try await session.loginWithEmailCode(email: trimmedEmail, code: code)
      } else {
        result = try await session.login(email: trimmedEmail, password: password)
      }
      password = ""
      code = ""
      switch result {
      case .authenticated(let account):
        await store.didLogin(account)
      case .twoFactor(let masked):
        twoFactorAccount = masked
        path.append(.twoFactor)
      }
    } catch {
      self.error = error.localizedDescription
      password = ""
    }
  }

  func cancelTwoFactor(_ store: AppStore) {
    guard twoFactorAccount != nil else { return }
    twoFactorAccount = nil
    code = ""
    if store.account == nil { Task { await store.session?.cancelTwoFactor() } }
  }

  func changeEmail(_ store: AppStore) {
    cancelTwoFactor(store)
    password = ""
    code = ""
    error = nil
    path = []
  }
}

/// The official welcome page: hero mark, serif title, email field with the trailing submit button, legal footer.
/// Google sign-in is left out (the service has none).
struct LoginView: View {
  var allowsDismissal = false
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @StateObject private var flow = LoginFlow()
  @State private var register = false
  @FocusState private var emailFocused: Bool

  var body: some View {
    NavigationStack(path: $flow.path) {
      welcome
        .navigationDestination(for: LoginStep.self) { step in
          LoginStepView(step: step).environmentObject(flow)
        }
    }
    .tint(Palette.text100)
    .sheet(isPresented: $register) { NavigationStack { RegisterView(email: flow.trimmedEmail) } }
    .task {
      // UI regression launches stay offline and signed out; no synthetic account.
      guard !ProcessInfo.processInfo.arguments.contains("-ui-testing") else { return }
      do {
        flow.options = try await store.session?.signInOptions() ?? .null
        if flow.emailCodeAvailable && flow.password.isEmpty { flow.useEmailCode = true }
      } catch { flow.error = error.localizedDescription }
    }
    .onChange(of: flow.path) { _, path in
      if !path.contains(.twoFactor) { flow.cancelTwoFactor(store) }
    }
    .onDisappear {
      flow.password = ""
      flow.code = ""
      if flow.twoFactorAccount != nil && store.account == nil {
        Task { await store.session?.cancelTwoFactor() }
      }
    }
    .interactiveDismissDisabled(flow.busy || !allowsDismissal)
  }

  private var welcome: some View {
    GeometryReader { geometry in
      let keyboard = emailFocused
      let hero = min(geometry.size.width * 0.6, 280)
      ScrollView {
        VStack(spacing: 0) {
          Color.clear.frame(height: 24)
          BrandMark(size: hero * 0.42)
            .frame(width: hero, height: hero * (keyboard ? 0.65 : 1))
            .scaleEffect(keyboard ? 0.65 : 1)
            .accessibilityHidden(true)
          Color.clear.frame(height: 16)
          Text(L("animated_login_welcome_title")).typeStyle(.screenTitle, weight: 300)
            .foregroundStyle(Palette.text100).multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
          if let configurationError = store.configurationError {
            InlineNotice(text: configurationError).padding(.top, 16)
          }
          Color.clear.frame(height: 24)
          emailField
          if let message = flow.emailError ?? flow.error {
            Text(message).typeStyle(.caption).foregroundStyle(Palette.dangerText)
              .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4).padding(.top, 8)
              .accessibilityIdentifier("auth-error")
          }
          if flow.emailCodeAvailable {
            ClaudeLinkButton(
              title: flow.useEmailCode ? L("claudex_login_use_password") : L("claudex_login_use_email_code"),
              style: .caption
            ) {
              flow.useEmailCode.toggle()
              flow.error = nil
            }.padding(.top, 4)
          }
          Spacer(minLength: 24)
          HStack(spacing: 4) {
            Text(L("claudex_login_no_account")).foregroundStyle(Palette.text500)
            Button(L("claudex_login_create_account")) { register = true }
              .foregroundStyle(Palette.accentSecondary100)
              .accessibilityIdentifier("open-registration")
          }.typeStyle(.body).frame(minHeight: 44)
          legal
        }
        .frame(maxWidth: 600)
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, minHeight: geometry.size.height)
      }
      .scrollDismissesKeyboard(.interactively)
      .animation(reduceMotion ? nil : Motion.standard(), value: keyboard)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .toolbar {
      if allowsDismissal {
        ToolbarItem(placement: .cancellationAction) {
          Button(L("generic_button_close")) { dismiss() }.accessibilityIdentifier("close-login")
        }
      }
    }
    .toolbar(allowsDismissal ? .visible : .hidden, for: .navigationBar)
  }

  private var emailField: some View {
    ClaudeTextField(
      placeholder: L("login_welcome_email_placeholder"), text: $flow.email, shape: .rounded,
      identifier: "login-email", focus: $emailFocused
    ) {
      if !flow.email.isEmpty {
        Button {
          Task { await flow.submitEmail(store) }
        } label: {
          Group {
            if flow.busy {
              ClaudeSpinner(size: .xSmall, color: Palette.bg100)
            } else {
              AppGlyphView(.arrowRight, size: 18)
            }
          }
          .foregroundStyle(Palette.bg100)
          .frame(width: 38, height: 38)
          .background(Palette.text100, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(flow.busy || store.session == nil)
        .accessibilityLabel(L("login_welcome_email_submit_a11y"))
        .accessibilityIdentifier("login-continue")
      }
    }
    .textContentType(.username).keyboardType(.emailAddress)
    .textInputAutocapitalization(.never).autocorrectionDisabled()
    .submitLabel(.continue)
    .onSubmit { Task { await flow.submitEmail(store) } }
    .onChange(of: flow.email) { _, _ in flow.emailError = nil }
  }

  @ViewBuilder private var legal: some View {
    let policy = flow.options["privacy_policy_url"].string.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
    Group {
      if let policy {
        Text(
          AttributedString(L("claudex_login_disclaimer")).replacingPolicy(
            L("claudex_login_privacy_policy"), url: policy))
      } else {
        Text(L("claudex_login_password_note"))
      }
    }
    .typeStyle(.body).foregroundStyle(Palette.text500).multilineTextAlignment(.center)
    .tint(Palette.text500)
    .padding(.horizontal, 8).padding(.vertical, 16)
  }
}

private extension AttributedString {
  /// Turns the policy name inside the disclaimer into an underlined link.
  func replacingPolicy(_ name: String, url: URL) -> AttributedString {
    var copy = self
    if let range = copy.range(of: name) {
      copy[range].link = url
      copy[range].underlineStyle = .single
    }
    return copy
  }
}

/// One step after the welcome page, in the official "magic link sent" layout: 52pt top space,
/// a 13pt strong instruction, the field, the account line and "Change email address".
struct LoginStepView: View {
  let step: LoginStep
  @EnvironmentObject private var store: AppStore
  @EnvironmentObject private var flow: LoginFlow
  @FocusState private var focused: Bool

  var body: some View {
    ScrollView {
      VStack(spacing: 0) {
        Color.clear.frame(height: 52)
        VStack(spacing: 12) {
          Text(instruction).typeStyle(.captionStrong).foregroundStyle(Palette.text100)
            .multilineTextAlignment(.center).padding(.bottom, 12)
          field
          if let error = flow.error {
            InlineNotice(text: error, tone: .error).accessibilityIdentifier("auth-error")
          }
          Button {
            Task { await flow.signIn(store) }
          } label: {
            HStack(spacing: 8) {
              if flow.busy { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) }
              Text(L("generic_button_continue"))
            }.frame(maxWidth: .infinity)
          }
          .claudeButton(.primary, size: .large, fullWidth: true)
          .disabled(!canSubmit)
          .accessibilityIdentifier("login-submit")
        }
        Color.clear.frame(height: 24)
        accountLine.padding(.top, 20).padding(.bottom, 12)
        if step == .emailCode { resend }
        if step == .twoFactor {
          ClaudeLinkButton(title: L("claudex_login_other_account")) { flow.changeEmail(store) }
        } else {
          ClaudeLinkButton(title: L("login_magic_link_change_email_button")) { flow.changeEmail(store) }
            .padding(.top, 4)
        }
        if step == .password {
          Text(L("claudex_login_password_note")).typeStyle(.caption).foregroundStyle(Palette.text500)
            .multilineTextAlignment(.center).padding(.top, 16)
        }
        Color.clear.frame(height: 36)
      }
      .frame(maxWidth: 600).padding(.horizontal, 24).frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Palette.bg100.ignoresSafeArea())
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(Palette.bg100, for: .navigationBar)
    .onAppear {
      flow.error = nil
      focused = true
    }
    .onChange(of: flow.code) { _, value in
      let digits = String(value.filter(\.isNumber).prefix(6))
      if digits != value { flow.code = digits }
      if digits.count == 6, step != .password, !flow.busy { Task { await flow.signIn(store) } }
    }
  }

  private var instruction: String {
    switch step {
    case .password: L("claudex_login_password_title")
    case .emailCode: L("login_magic_link_enter_code")
    case .twoFactor: L("claudex_login_two_factor_title")
    }
  }

  private var canSubmit: Bool {
    guard !flow.busy, store.session != nil else { return false }
    return step == .password ? !flow.password.isEmpty : flow.code.count == 6
  }

  @ViewBuilder private var field: some View {
    if step == .password {
      ClaudeTextField(
        L("claudex_login_password_placeholder"), text: $flow.password, secure: true, shape: .rounded,
        identifier: "login-password", focus: $focused
      )
      .textContentType(.password).submitLabel(.go)
      .onSubmit { if canSubmit { Task { await flow.signIn(store) } } }
    } else {
      ClaudeTextField(
        L("login_magic_link_code_placeholder"), text: $flow.code, shape: .rounded,
        identifier: "verification-code", focus: $focused
      )
      .textContentType(.oneTimeCode).keyboardType(.numberPad)
    }
  }

  private var accountLine: some View {
    let format = step == .twoFactor ? L("claudex_login_two_factor_account", "\u{1}") : L("login_magic_link_sent_to", "\u{1}")
    let account = step == .twoFactor ? (flow.twoFactorAccount ?? "") : flow.trimmedEmail
    let parts = format.components(separatedBy: "\u{1}")
    var text = AttributedString(parts.first ?? "")
    var bold = AttributedString(account)
    bold.font = Font(TypeStyle.body.uiFont()).bold()
    text.append(bold)
    if parts.count > 1 { text.append(AttributedString(parts[1])) }
    return Text(text).typeStyle(.body).foregroundStyle(Palette.text100).multilineTextAlignment(.center)
  }

  private var resend: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let remaining = max(0, Int(flow.resendAfter.timeIntervalSince(context.date).rounded(.up)))
      ClaudeLinkButton(
        title: remaining > 0 ? L("claudex_login_resend_in", remaining) : L("claudex_login_resend")
      ) {
        Task { await flow.sendCode(store) }
      }.disabled(remaining > 0 || flow.busy)
    }
  }
}

/// Claudex registration (the official app has no in-app sign-up), in the official field style.
struct RegisterView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @State var email: String
  @State private var password = ""
  @State private var code = ""
  @State private var invitation = ""
  @State private var sent = false
  @State private var busy = false
  @State private var error: String?
  @State private var resendAfter = Date.distantPast
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        ClaudeTextField(L("claudex_register_email"), text: $email, shape: .rounded, identifier: "register-email")
          .textContentType(.username).keyboardType(.emailAddress)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
        ClaudeTextField(L("claudex_register_password"), text: $password, secure: true, shape: .rounded)
          .textContentType(.newPassword)
        ClaudeTextField(placeholder: L("claudex_register_code"), text: $code, shape: .rounded) {
          TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = max(0, Int(resendAfter.timeIntervalSince(context.date).rounded(.up)))
            Button(
              remaining > 0
                ? L("claudex_login_resend_in", remaining) : sent ? L("claudex_login_resend") : L("claudex_register_send_code")
            ) { Task { await sendCode() } }
            .claudeButton(.secondary, size: .small)
            .disabled(busy || remaining > 0 || !email.contains("@"))
          }
        }
        .textContentType(.oneTimeCode).keyboardType(.numberPad)
        if sent {
          Text(L("claudex_register_sent_to", email)).typeStyle(.caption).foregroundStyle(Palette.text500)
        }
        ClaudeTextField(L("claudex_register_invitation"), text: $invitation, shape: .rounded)
          .textInputAutocapitalization(.never)
        if let error { InlineNotice(text: error, tone: .error) }
        Button {
          Task { await create() }
        } label: {
          HStack(spacing: 8) {
            if busy { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) }
            Text(L("claudex_register_submit"))
          }.frame(maxWidth: .infinity)
        }
        .claudeButton(.primary, size: .large, fullWidth: true)
        .disabled(busy || password.isEmpty || !email.contains("@"))
        .padding(.top, 12)
        Text(L("claudex_register_footer")).typeStyle(.caption).foregroundStyle(Palette.text500)
      }
      .padding(24)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .accessibilityIdentifier("registration-form")
    .navigationTitle(sent ? L("claudex_register_verify_title") : L("claudex_register_title"))
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(Palette.bg100, for: .navigationBar)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button(L("generic_button_close")) { dismiss() }.accessibilityIdentifier("close-registration")
      }
    }
    .interactiveDismissDisabled(busy)
    .onDisappear {
      password = ""
      code = ""
    }
  }
  private func sendCode() async {
    busy = true
    defer { busy = false }
    do {
      let wait = try await store.session?.requestVerification(email: email) ?? 0
      sent = true
      resendAfter = .now.addingTimeInterval(Double(wait))
    } catch { self.error = error.localizedDescription }
  }
  private func create() async {
    busy = true
    error = nil
    defer {
      busy = false
      password = ""
    }
    do {
      if case .authenticated(let account) = try await store.session?.register(
        email: email, password: password, verifyCode: code, invitation: invitation)
      {
        await store.didLogin(account)
        dismiss()
      }
    } catch { self.error = error.localizedDescription }
  }
}
