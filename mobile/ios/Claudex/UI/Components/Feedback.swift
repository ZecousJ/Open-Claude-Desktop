import SwiftUI

// MARK: Spinner

enum SpinnerSize {
  case xxSmall, icon, xSmall, small, medium, large
  var diameter: CGFloat {
    switch self {
    case .xxSmall: 12
    case .icon: 16
    case .xSmall: 18
    case .small: 24
    case .medium: 32
    case .large: 48
    }
  }
  var stroke: CGFloat {
    switch self {
    case .xxSmall: 1.5
    case .icon: 1
    case .xSmall, .small: 2
    case .medium: 3
    case .large: 4
    }
  }
  var padding: CGFloat { self == .icon ? 2 : 0 }
}

/// Material circular indeterminate indicator with the Claude sizes; `accentMain100` by default.
/// With Reduce Motion on it draws a still ring, like the official app.
struct ClaudeSpinner: View {
  var size: SpinnerSize = .medium
  var color: Color = Palette.accentMain100
  /// 0…1 for a determinate ring (track `border200`); nil spins.
  var progress: Double?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var spinning = false
  var body: some View {
    let ring = size.diameter - size.padding * 2
    ZStack {
      if let progress {
        Circle().stroke(Palette.border200, lineWidth: size.stroke)
        Circle().trim(from: 0, to: max(0, min(1, progress)))
          .stroke(color, style: StrokeStyle(lineWidth: size.stroke, lineCap: .round))
          .rotationEffect(.degrees(-90))
      } else {
        Circle().trim(from: 0, to: reduceMotion ? 0.75 : 0.72)
          .stroke(color, style: StrokeStyle(lineWidth: size.stroke, lineCap: .round))
          .rotationEffect(.degrees(spinning ? 360 : 0))
          .animation(
            reduceMotion ? nil : .linear(duration: 1.333).repeatForever(autoreverses: false), value: spinning)
          .onAppear { spinning = true }
      }
    }
    .frame(width: ring, height: ring).padding(size.padding)
    .accessibilityElement().accessibilityLabel(L("usage_meter_row_loading"))
  }
}

/// The plain loading state: a centred spinner, no plumbing words.
struct LoadingState: View {
  var body: some View {
    ClaudeSpinner(size: .medium).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

// MARK: Snackbars and pill toasts

@MainActor
final class Snackbars: ObservableObject {
  static let shared = Snackbars()

  enum Kind { case warning, success }
  struct Item: Identifiable, Equatable {
    let id = UUID()
    var title: String?
    var message: String
    var kind: Kind
    var actionTitle: String?
    static func == (a: Item, b: Item) -> Bool { a.id == b.id }
  }

  @Published private(set) var snackbar: Item?
  @Published private(set) var toast: String?
  private var action: (() -> Void)?
  private var snackbarTimer: Task<Void, Never>?
  private var toastTimer: Task<Void, Never>?

  /// Error / status snackbar with an optional text action and a dismiss button.
  /// Stays 10 s (Material "long"), or until dismissed.
  func show(
    _ message: String, title: String? = nil, kind: Kind = .warning, action: (title: String, run: () -> Void)? = nil
  ) {
    snackbar = Item(title: title, message: message, kind: kind, actionTitle: action?.title)
    self.action = action?.run
    snackbarTimer?.cancel()
    snackbarTimer = Task { [weak self] in
      try? await Task.sleep(for: .seconds(10))
      guard !Task.isCancelled else { return }
      self?.dismissSnackbar()
    }
  }
  /// Small pill toast ("Copied to clipboard"), 4 s (Material "short").
  func toast(_ text: String) {
    toast = text
    toastTimer?.cancel()
    toastTimer = Task { [weak self] in
      try? await Task.sleep(for: .seconds(4))
      guard !Task.isCancelled else { return }
      self?.toast = nil
    }
  }
  func dismissSnackbar() {
    snackbar = nil
    action = nil
  }
  func runAction() {
    let run = action
    dismissSnackbar()
    run?()
  }
}

/// The error / status snackbar surface.
struct SnackbarView: View {
  let item: Snackbars.Item
  var onAction: () -> Void = {}
  var onDismiss: () -> Void = {}
  @Environment(\.dynamicTypeSize) private var dynamicType
  var body: some View {
    let wraps = dynamicType >= .accessibility1
    HStack(alignment: .center, spacing: 0) {
      AppGlyphView(item.kind == .warning ? .warning : .check, size: 20).foregroundStyle(Palette.text300)
        .padding(.trailing, 10)
      VStack(alignment: .leading, spacing: 4) {
        if let title = item.title { Text(title).typeStyle(.captionStrong) }
        Text(item.message).typeStyle(.caption).fixedSize(horizontal: false, vertical: true)
        if wraps, let actionTitle = item.actionTitle { actionButton(actionTitle) }
      }.foregroundStyle(Palette.text100).frame(maxWidth: .infinity, alignment: .leading)
      if !wraps, let actionTitle = item.actionTitle { actionButton(actionTitle).padding(.leading, 8) }
      Button(action: onDismiss) {
        AppGlyphView(.x, size: 20).frame(width: 40, height: 40)
      }.buttonStyle(.plain).foregroundStyle(Palette.text300)
        .accessibilityLabel(L("generic_button_content_description_dismiss"))
        .padding(.leading, 6)
    }
    .padding(.leading, 14).padding(.trailing, 4).padding(.vertical, 12)
    .frame(minHeight: 55)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r14, style: .continuous).strokeBorder(Palette.border200, lineWidth: 0.5))
    .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
    .frame(maxWidth: Spacing.snackbarMaxWidth)
    .accessibilityElement(children: .contain)
  }
  private func actionButton(_ title: String) -> some View {
    Button(title, action: onAction).buttonStyle(.plain).typeStyle(.captionStrong)
      .foregroundStyle(Palette.accentSecondary100).frame(minHeight: 32)
  }
}

/// The pill toast surface.
struct PillToastView: View {
  let text: String
  var body: some View {
    Text(text).typeStyle(.caption).foregroundStyle(Palette.text100)
      .padding(.horizontal, 14).frame(minHeight: 32)
      .background(Palette.pillToastFill, in: Capsule())
      .background(Palette.bg100, in: Capsule())
      .overlay(Capsule().strokeBorder(Palette.pillToastBorder, lineWidth: 0.5))
  }
}

/// Hosts the shared snackbar and toast at the bottom of the screen. Apply once, at the root.
struct SnackbarHost: ViewModifier {
  @ObservedObject var center = Snackbars.shared
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func body(content: Content) -> some View {
    content.overlay(alignment: .bottom) {
      VStack(spacing: 8) {
        if let toast = center.toast {
          PillToastView(text: toast).transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
        if let item = center.snackbar {
          SnackbarView(item: item, onAction: center.runAction, onDismiss: center.dismissSnackbar)
            .padding(.horizontal, Spacing.l)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .id(item.id)
        }
      }
      .padding(.bottom, 12)
      .animation(reduceMotion ? nil : Motion.easeOut(0.25), value: center.snackbar)
      .animation(reduceMotion ? nil : Motion.easeOut(0.25), value: center.toast)
    }
  }
}

extension View {
  func snackbarHost() -> some View { modifier(SnackbarHost()) }
}
