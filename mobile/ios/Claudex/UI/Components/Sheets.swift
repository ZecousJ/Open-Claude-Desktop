import SwiftUI

// MARK: Bottom sheet

/// The 36 × 5 drag handle in `border300` (touch box 48 × 16).
struct SheetGrabber: View {
  var body: some View {
    Capsule().fill(Palette.border300).frame(width: 36, height: 5)
      .padding(.horizontal, 6).padding(.vertical, 5.5)
      .frame(width: 48, height: 16)
      .accessibilityLabel(L("sheet_grabber_description"))
  }
}

/// Official sheet chrome: 44pt top corners, `bg100` container, `text100` content and the
/// official grabber. Content gets the 24pt gutter via `SheetScaffold` or its own padding.
struct ClaudeSheetChrome: ViewModifier {
  var detents: Set<PresentationDetent>
  var background: Color = Palette.bg100
  func body(content: Content) -> some View {
    content
      .foregroundStyle(Palette.text100)
      .safeAreaInset(edge: .top, spacing: 0) {
        SheetGrabber().frame(maxWidth: .infinity).padding(.top, 2)
      }
      .presentationDetents(detents)
      .presentationDragIndicator(.hidden)
      .presentationCornerRadius(Radius.sheet)
      .presentationBackground(background)
  }
}

extension View {
  /// Use inside `.sheet { … }` content: `SomeView().claudeSheetChrome()`.
  func claudeSheetChrome(_ detents: Set<PresentationDetent> = [.medium, .large], background: Color = Palette.bg100)
    -> some View
  {
    modifier(ClaudeSheetChrome(detents: detents, background: background))
  }

  /// A bottom sheet in the official style.
  func claudeSheet<Content: View>(
    isPresented: Binding<Bool>, detents: Set<PresentationDetent> = [.medium, .large],
    @ViewBuilder content: @escaping () -> Content
  ) -> some View {
    sheet(isPresented: isPresented) { content().claudeSheetChrome(detents) }
  }

  func claudeSheet<Item: Identifiable, Content: View>(
    item: Binding<Item?>, detents: Set<PresentationDetent> = [.medium, .large],
    @ViewBuilder content: @escaping (Item) -> Content
  ) -> some View {
    sheet(item: item) { content($0).claudeSheetChrome(detents) }
  }
}

/// Sheet header row: optional title (max 2 lines, heading) and the close button
/// (16 h / 5 v padding, 8pt spacing).
struct SheetHeader: View {
  let title: String
  var showsClose = true
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    HStack(spacing: 8) {
      if showsClose {
        Button { dismiss() } label: {
          AppGlyphView(.x).frame(width: 44, height: 44)
        }.buttonStyle(IconPressStyle()).foregroundStyle(Palette.text100)
          .accessibilityLabel(L("close_sheet")).accessibilityIdentifier("close-sheet")
      }
      Text(title).typeStyle(.bodyLargeStrong).lineLimit(2).frame(maxWidth: .infinity)
        .multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
      if showsClose { Color.clear.frame(width: 44, height: 44).accessibilityHidden(true) }
    }.padding(.horizontal, 16).padding(.vertical, 5)
  }
}

// MARK: Dialog

/// The official content dialog: `dialogSurface`, 12pt corners, 10 % hairline, 24pt padding,
/// 20pt title, 15pt `textSecondary` body, buttons below a 16pt gap.
///
/// Simple confirmations use the native iOS alert (system-level control, owner decision
/// 2026-10-12) with the official texts; use this card for dialogs with custom content.
struct ClaudeDialogCard<Actions: View>: View {
  let title: String
  var message: String?
  @ViewBuilder var actions: () -> Actions
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title).typeStyle(.dialogTitle).foregroundStyle(Palette.textPrimary)
      if let message {
        Text(message).typeStyle(.body).foregroundStyle(Palette.textSecondary).padding(.top, 4)
      }
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        actions()
      }.padding(.top, message == nil ? 12 + 16 : 16)
    }
    .padding(24)
    .frame(maxWidth: Spacing.dialogMaxWidth, alignment: .leading)
    .background(Palette.dialogSurface, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.borderDefault, lineWidth: 1))
    .dialogShadow(dark: scheme == .dark)
    .padding(16)
  }
}

private struct ClaudeDialogPresenter<Card: View>: ViewModifier {
  @Binding var isPresented: Bool
  @ViewBuilder var card: () -> Card
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var covered = false
  @State private var shown = false
  func body(content: Content) -> some View {
    content
      .fullScreenCover(isPresented: $covered) {
        ZStack {
          Palette.dialogScrim.ignoresSafeArea().opacity(shown ? 1 : 0)
            .onTapGesture { isPresented = false }
            .accessibilityLabel(L("generic_button_close"))
          card().scaleEffect(shown || reduceMotion ? 1 : 0.98).opacity(shown ? 1 : 0)
        }
        .presentationBackground(.clear)
        .onAppear { withAnimation(reduceMotion ? nil : Motion.easeOut) { shown = true } }
      }
      .onChange(of: isPresented) { _, presented in
        if presented {
          // The cover itself never slides; the card fades and scales in (200 ms ease-out).
          var transaction = Transaction()
          transaction.disablesAnimations = true
          withTransaction(transaction) { covered = true }
        } else {
          withAnimation(reduceMotion ? nil : Motion.easeOut) { shown = false }
          Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 0 : 200))
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { covered = false }
          }
        }
      }
  }
}

extension View {
  /// Presents `ClaudeDialogCard` over a 40 % (light) / 50 % (dark) scrim; tap outside dismisses.
  func claudeDialog<Card: View>(isPresented: Binding<Bool>, @ViewBuilder card: @escaping () -> Card) -> some View {
    modifier(ClaudeDialogPresenter(isPresented: isPresented, card: card))
  }
}
