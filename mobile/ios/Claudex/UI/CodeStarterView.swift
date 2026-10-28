import SwiftUI

/// The Code starter page's body: greeting, "Get started with a prompt", the three suggestion pills, "Something else…"
/// and, under it, the free prompt box. `choice` is a suggestion id, `CodeStarter.other` or nil.
struct CodeStarterView: View {
  let name: String?
  @Binding var choice: String?
  @Binding var draft: String
  let busy: Bool
  @FocusState private var typing: Bool

  private var greeting: String {
    if let name, !name.isEmpty, !name.contains("@") { return L("code_starter_greeting_named", name) }
    return L("code_starter_greeting")
  }

  var body: some View {
    VStack(spacing: 0) {
      HomeGreeting(greeting).padding(.top, 8)
      Text(L("code_starter_subtitle")).typeStyle(.body).foregroundStyle(Palette.text500)
        .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.top, 8).padding(.bottom, 12)
      ForEach(CodeStarter.suggestions) { item in
        pill(emoji: item.emoji, label: L(item.titleKey), id: item.id)
      }
      pill(emoji: "❓", label: L("code_starter_something_else"), id: CodeStarter.other)
      if choice == CodeStarter.other {
        TextField(text: $draft, axis: .vertical) {
          Text(L("code_starter_custom_prompt_hint")).foregroundStyle(Palette.text500)
        }
        .lineLimit(3...8).focused($typing).typeStyle(.body).foregroundStyle(Palette.text100)
        .tint(Palette.accentMain100).disabled(busy)
        .padding(12)
        .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
        .padding(.vertical, 6).accessibilityIdentifier("code-starter-prompt")
      }
    }
    .padding(.horizontal, 20)
  }

  private func pill(emoji: String, label: String, id: String) -> some View {
    let selected = choice == id
    return Button {
      let next = CodeStarter.next(current: choice, tapped: id)
      draft = CodeStarter.draftAfter(draft, choice: next)
      choice = next
      typing = next == CodeStarter.other
    } label: {
      HStack(spacing: 12) {
        Text(emoji).typeStyle(.bodyLarge)
        Text(label).typeStyle(.body).foregroundStyle(selected ? Palette.accentMain100 : Palette.text300)
          .frame(maxWidth: .infinity, alignment: .leading)
        AppGlyphView(.check, size: 22).foregroundStyle(Palette.accentMain100).opacity(selected ? 1 : 0)
      }
      .padding(.horizontal, 18).padding(.vertical, 16)
      .background(selected ? Palette.accentMain100.opacity(0.1) : Palette.bg000, in: Capsule())
      .overlay(Capsule().strokeBorder(selected ? Palette.accentMain100 : Palette.border300, lineWidth: 1))
      .contentShape(Capsule())
    }
    .buttonStyle(.plain).disabled(busy)
    .padding(.vertical, 5)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("code-starter-" + id)
  }
}
