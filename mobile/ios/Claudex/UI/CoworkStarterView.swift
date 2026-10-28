import SwiftUI

/// Cowork's first-use page: shown in place of the task list until "Get started" is tapped once. A scrolling column
/// with 32pt sides: a 137pt hero, 24pt below it the serif 28 title, 24pt, three benefit rows (24pt glyph, 16pt gap,
/// 15/400 text) spaced 24pt; the full-width button sits at the bottom, 16pt from the edges, at most 580pt wide. The
/// hero is the Claudex mark on a neutral panel.
struct CoworkStarterView: View {
  @EnvironmentObject private var store: AppStore
  let onStart: () -> Void
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        ZStack { BrandMark(size: 56) }
          .frame(maxWidth: .infinity).frame(height: 137)
          .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
          .accessibilityHidden(true)
        Text(L("cowork_starter_title")).typeStyle(.serifLarge).foregroundStyle(Palette.text100)
          .fixedSize(horizontal: false, vertical: true).padding(.top, 24)
          .accessibilityAddTraits(.isHeader)
        VStack(alignment: .leading, spacing: 24) {
          benefit(.mobilePhone, L("cowork_starter_benefit_start_from_phone"))
          benefit(.computer, L("cowork_starter_benefit_check_in_anywhere"))
          benefit(.lightning, L("cowork_starter_benefit_works_in_background"))
        }.padding(.top, 24)
      }
      .frame(maxWidth: 580, alignment: .leading)
      .padding(.horizontal, 32).padding(.top, 12).padding(.bottom, 24)
      .frame(maxWidth: .infinity)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(L("cowork_starter_title"), serif: false)
    .safeAreaInset(edge: .bottom) {
      Button(L("cowork_starter_get_started"), action: onStart)
        .claudeButton(.primary, size: .large, fullWidth: true)
        .frame(maxWidth: 580).padding(16).frame(maxWidth: .infinity)
        .background(Palette.bg100)
        .accessibilityIdentifier("cowork-starter-start")
    }
    .onAppear {
      store.activeConversationID = nil
      store.mode = .cowork
    }
  }
  private func benefit(_ icon: AppGlyph, _ text: String) -> some View {
    HStack(spacing: 16) {
      AppGlyphView(icon, size: 24).foregroundStyle(Palette.text300)
      Text(text).typeStyle(.body).foregroundStyle(Palette.text300)
        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
    }
  }
}
