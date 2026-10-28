import SwiftUI

/// App-wide string lookup. Use the official resource name as the key:
///
///     Text(L("nav_drawer_item_chats"))                    // 对话
///     L("account_options_button_description", name)       // %1$@ arguments
///     L10n.plural("nav_drawer_pinned_show_all", count: 7) // 显示全部 7 个
///
/// Add every new key to both `Resources/Strings/en.strings` (English) and
/// `Resources/Strings/zh-Hans.strings` (our Chinese). `StringCatalogTests` fails when a key or a placeholder exists
/// in only one of them.
enum L10n {
  static let languageKey = "ui-language"
  static let defaultLanguage = "zh-Hans"

  static let catalog: StringCatalog = {
    let directory = Bundle.main.bundleURL.appendingPathComponent("Strings")
    let requested = UserDefaults.standard.string(forKey: languageKey) ?? defaultLanguage
    let language = ["en", "zh-Hans"].contains(requested) ? requested : defaultLanguage
    let english = StringCatalog.load(language: "en", directory: directory)
    let table = language == "en" ? english : StringCatalog.load(language: language, directory: directory)
    return StringCatalog(language: language, table: table, fallback: english)
  }()
}

/// Looks up a catalogue string by its official resource name.
func L(_ key: String) -> String { L10n.catalog.string(key) }
/// Looks up and formats a catalogue string (`%1$@`, `%1$d` placeholders).
func L(_ key: String, _ arguments: CVarArg...) -> String { L10n.catalog.string(key, arguments) }

extension L10n {
  static func plural(_ key: String, count: Int, _ arguments: CVarArg...) -> String {
    catalog.plural(key, count: count, arguments)
  }
}
