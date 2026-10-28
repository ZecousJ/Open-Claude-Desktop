import Foundation

/// The app's string catalogues: `Resources/Strings/en.strings` holds the English copy and
/// `Resources/Strings/zh-Hans.strings` the Simplified Chinese. Keys match the Android app's resource names.
/// Claudex-only copy uses a `claudex_` prefix.
///
/// Format: standard `.strings` (`"key" = "value";`), iOS placeholders (`%1$@`, `%1$d`). Plurals are `key#one` /
/// `key#other` entries; Chinese only needs `key#other`.
///
/// The catalogues are plain bundle resources rather than `.lproj` localisations, so the system keeps the app's
/// development region (zh-Hans) for its own controls and the UI is Chinese by default on every device. `ui-language`
/// in UserDefaults (or `-ui-language en` as a launch argument) switches the catalogue for review.
public struct StringCatalog: Sendable {
  public let language: String
  private let table: [String: String]
  private let fallback: [String: String]

  public init(language: String, table: [String: String], fallback: [String: String] = [:]) {
    self.language = language
    self.table = table
    self.fallback = fallback
  }

  /// Parses `.strings` source text.
  public static func parse(_ source: String) -> [String: String] {
    guard let data = source.data(using: .utf8),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
      let dictionary = plist as? [String: String]
    else { return [:] }
    return dictionary
  }

  public static func load(language: String, directory: URL) -> [String: String] {
    let url = directory.appendingPathComponent(language + ".strings")
    guard let source = try? String(contentsOf: url, encoding: .utf8) else { return [:] }
    return parse(source)
  }

  public func has(_ key: String) -> Bool { table[key] != nil || fallback[key] != nil }

  /// The text for `key`; falls back to English, then to the key itself.
  public func string(_ key: String) -> String {
    table[key] ?? fallback[key] ?? key
  }

  public func string(_ key: String, _ arguments: [CVarArg]) -> String {
    let format = string(key)
    guard !arguments.isEmpty else { return format }
    return String(format: format, locale: Locale(identifier: language), arguments: arguments)
  }

  /// Plural lookup: English uses `#one` for 1 and `#other` otherwise; Chinese has one form.
  public func plural(_ key: String, count: Int, _ arguments: [CVarArg] = []) -> String {
    let form = language.hasPrefix("en") && count == 1 ? "one" : "other"
    let candidates = [key + "#" + form, key + "#other", key]
    let format = candidates.lazy.compactMap { table[$0] ?? fallback[$0] }.first ?? key
    let args = arguments.isEmpty ? [count] : arguments
    return String(format: format, locale: Locale(identifier: language), arguments: args)
  }

  /// `%1$@`-style placeholders in a value, used to check that both catalogues agree.
  public static func placeholders(_ value: String) -> [String] {
    let pattern = try! NSRegularExpression(pattern: "%(?:\\d+\\$)?[@dDuUxXfeEgGcCsSp]|%%")
    let range = NSRange(value.startIndex..., in: value)
    return pattern.matches(in: value, range: range).compactMap {
      Range($0.range, in: value).map { String(value[$0]) }
    }.filter { $0 != "%%" }.sorted()
  }
}
