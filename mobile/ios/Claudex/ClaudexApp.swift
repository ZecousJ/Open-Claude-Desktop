import SwiftUI

@main
struct ClaudexApp: App {
  @StateObject private var store = AppStore()
  @Environment(\.scenePhase) private var scenePhase
  @AppStorage("appearance") private var appearance = "system"
  init() {
    // The Core words its own errors and default file names through the app's string catalogue (CoreText.swift).
    CoreText.install { key, arguments in L10n.catalog.string(key, arguments) }
  }
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(store).tint(Palette.text100)
        .toggleStyle(.claude)
        .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
        .task { CJKSerif.prefetch(); await store.boot() }
        .onChange(of: scenePhase) { _, phase in store.lifecycle(active: phase == .active) }
    }
  }
}
struct RootView: View {
  @EnvironmentObject private var store: AppStore
  var body: some View {
    Group {
      switch store.authenticationDestination {
      case .restoring:
        // The launch screen held (Info.plist UILaunchScreen: LaunchMark on LaunchBackground,
        // the official bg100) while the saved sign-in comes back, with no words.
        BrandMark(size: 65).frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Palette.bg100).ignoresSafeArea().accessibilityIdentifier("session-restoring")
      case .login:
        LoginView().accessibilityIdentifier("authentication-entry")
      case .chat:
        MainShell()
      }
    }
    .background(Palette.bg100.ignoresSafeArea())
    .overlay(alignment: .top) { ErrorSnackbar() }
    .snackbarHost()
  }
}

/// The global error, shown as the official error snackbar instead of an alert. It closes by
/// itself after 10 s or with its dismiss button; either clears `store.errorMessage`.
private struct ErrorSnackbar: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    ZStack {
      if let message = store.errorMessage {
        SnackbarView(
          item: Snackbars.Item(message: message, kind: .warning),
          onDismiss: { store.errorMessage = nil }
        )
        .padding(.horizontal, Spacing.l).padding(.top, 4)
        .transition(.move(edge: .top).combined(with: .opacity))
        .task(id: message) {
          try? await Task.sleep(for: .seconds(10))
          if !Task.isCancelled, store.errorMessage == message { store.errorMessage = nil }
        }
        .accessibilityIdentifier("error-snackbar")
      }
    }
    .animation(reduceMotion ? nil : Motion.easeOut(0.25), value: store.errorMessage)
  }
}

/// Signed-in layout: the destination's navigation stack under the official modal drawer
/// (opened only from the menu button, closed by the scrim, a swipe or choosing a row).
struct MainShell: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.layoutDirection) private var direction
  @State private var drag: CGFloat = 0
  var body: some View {
    GeometryReader { geometry in
      let width = min(360, geometry.size.width)
      let open = store.sidebarPresented
      let offset = open ? min(0, drag) : -width
      ZStack(alignment: .leading) {
        NavigationStack(path: $store.chatPath) {
          sectionView
            .navigationDestination(for: ChatRoute.self) { route in
              switch route {
              case .history: AllChatsView()
              case .conversation(let id): ChatView(conversationID: id)
              }
            }
        }
        .id(store.section).disabled(open).accessibilityHidden(open)
        Button {
          store.sidebarPresented = false
        } label: {
          Palette.scrim.opacity(open ? max(0, 1 + offset / width) : 0).ignoresSafeArea()
        }
        .buttonStyle(.plain)
        .allowsHitTesting(open).accessibilityHidden(!open)
        .accessibilityLabel(L("close_drawer")).accessibilityIdentifier("close-sidebar")
        SidebarView()
          .frame(width: width).frame(maxHeight: .infinity)
          .background(
            UnevenRoundedRectangle(bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous)
              .fill(Palette.bg200).ignoresSafeArea())
          .offset(x: offset)
          .gesture(
            DragGesture(minimumDistance: 12)
              .onChanged { value in drag = direction == .rightToLeft ? -value.translation.width : value.translation.width }
              .onEnded { value in
                let distance = direction == .rightToLeft ? -value.predictedEndTranslation.width : value.predictedEndTranslation.width
                if distance < -width * 0.4 { store.sidebarPresented = false }
                withAnimation(reduceMotion ? nil : Motion.spring) { drag = 0 }
              }
          )
          .disabled(!open).accessibilityHidden(!open).zIndex(1)
          .accessibilityAddTraits(.isModal)
      }
      .animation(reduceMotion ? nil : Motion.spring, value: open)
    }
    .id(store.account?.email ?? "signed-out")
  }
  @ViewBuilder private var sectionView: some View {
    switch store.section {
    case .chat: ConversationHome()
    case .projects: WorkView()
    case .code: CodeWorkspaceView().sidebarToolbar()
    case .library: ArtifactLibraryView().sidebarToolbar()
    case .cowork: CoworkView().sidebarToolbar()
    case .schedules: SchedulesView()
    case .api: APIGroupsView().sidebarToolbar()
    case .status: ServiceStatusView().sidebarToolbar()
    case .personalization: PersonalizationView().sidebarToolbar()
    case .settings: SettingsView().sidebarToolbar()
    }
  }
}
