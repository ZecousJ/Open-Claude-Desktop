import SwiftUI

/// The Claude spark (the app's existing terracotta mark asset).
struct BrandMark: View {
  var size: CGFloat = 43
  var body: some View {
    Image("BrandMark").resizable().scaledToFit().frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

/// The drawer / welcome logotype. The official one is the "Claude" wordmark image; Claudex shows
/// its own name in the serif at the logotype height (24pt).
struct Logotype: View {
  var height: CGFloat = 24
  var body: some View {
    Text(verbatim: "Claudex").font(Font(TypeStyle.uiFont(family: .serif, size: height, weight: 500)))
      .foregroundStyle(Palette.text100)
      .accessibilityLabel(L("claudex_app_name"))
  }
}

/// Avatar: a circle with the initial(s). The official sizes are 20 / 24 / 32 / 40; the drawer account row uses 44.
struct ClaudeAvatar: View {
  enum Size {
    case xSmall, small, medium, large, account
    var diameter: CGFloat {
      switch self {
      case .xSmall: 20
      case .small: 24
      case .medium: 32
      case .large: 40
      case .account: 44
      }
    }
    var text: TypeStyle { self == .xSmall || self == .small ? .badge : .captionStrong }
  }
  let name: String
  var size: Size = .large
  var body: some View {
    Text(Self.initials(name)).typeStyle(size.text).foregroundStyle(Palette.textSecondary)
      .lineLimit(1).minimumScaleFactor(0.6)
      .frame(width: size.diameter, height: size.diameter)
      .background(Palette.fill10, in: Circle())
      .accessibilityHidden(true)
  }
  static func initials(_ name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = trimmed.first else { return "?" }
    // CJK names show the first character; Latin names the first letters of up to two words.
    if first.unicodeScalars.first.map({ $0.value >= 0x2E80 }) == true { return String(first) }
    let words = trimmed.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "_" || $0 == "@" })
    return words.prefix(2).compactMap(\.first).map { String($0).uppercased() }.joined()
  }
}

/// The home greeting: 43pt spark, 11pt gap, serif 22/400 centred, at most two lines, 28pt side padding; crossfades
/// 300 ms on change.
struct HomeGreeting: View {
  let text: AttributedString
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  init(_ text: String) { self.text = AttributedString(text) }
  init(attributed: AttributedString) { self.text = attributed }
  var body: some View {
    VStack(spacing: 11) {
      BrandMark(size: 43)
      Text(text).typeStyle(.greeting).foregroundStyle(Palette.text100)
        .multilineTextAlignment(.center).lineLimit(2).minimumScaleFactor(0.7)
        .frame(maxWidth: .infinity).padding(.horizontal, 28)
        .id(text)
        .transition(.opacity)
    }
    .animation(reduceMotion ? nil : Motion.headlineCrossfade, value: text)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}
