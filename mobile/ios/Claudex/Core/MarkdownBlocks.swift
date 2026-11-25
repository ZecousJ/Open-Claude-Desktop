import Foundation

/// Non-executing block rendering; unsupported syntax remains selectable source.
public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String), heading(Int, String), code(language: String, source: String)
    case list(marker: String, text: String, depth: Int), quote(String), rule
    case table(header: [String], rows: [[String]])
    case image(alt: String, destination: String), math(String)
}
public enum MarkdownBlocks {
    public static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = [], paragraph: [String] = [], i = 0
        func flush() { if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] } }
        while i < lines.count {
            let line = lines[i], trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flush(); i += 1; continue }
            if let fence = fenceStart(trimmed) {
                flush(); var body: [String] = []; i += 1
                while i < lines.count {
                    let next = lines[i].trimmingCharacters(in: .whitespaces)
                    if next.count >= fence.count && next.allSatisfy({ $0 == fence.character }) { i += 1; break }
                    body.append(lines[i]); i += 1
                }
                blocks.append(.code(language: fence.language, source: body.joined(separator: "\n"))); continue
            }
            if trimmed == "$$" || trimmed == "\\[" {
                flush(); let end = trimmed == "$$" ? "$$" : "\\]"; var body: [String] = []; i += 1
                while i < lines.count && lines[i].trimmingCharacters(in: .whitespaces) != end { body.append(lines[i]); i += 1 }
                if i < lines.count { i += 1 }; blocks.append(.math(body.joined(separator: "\n"))); continue
            }
            if trimmed.hasPrefix("$$"), trimmed.hasSuffix("$$"), trimmed.count > 4 {
                flush(); blocks.append(.math(String(trimmed.dropFirst(2).dropLast(2)))); i += 1; continue
            }
            if let heading = captures("^(#{1,6})[ \\t]+(.+?)\\s*#*\\s*$", trimmed) {
                flush(); blocks.append(.heading(heading[0].count, heading[1])); i += 1; continue
            }
            if i + 1 < lines.count, let level = setext(lines[i + 1]), !trimmed.contains("|") {
                flush(); blocks.append(.heading(level, trimmed)); i += 2; continue
            }
            if ["---", "***", "___"].contains(trimmed.replacingOccurrences(of: " ", with: "")) { flush(); blocks.append(.rule); i += 1; continue }
            if let image = captures("^!\\[([^\\]]*)\\]\\(([^\\s]+)(?:[ \\t]+[\"'][^\"']*[\"'])?\\)$", trimmed) {
                flush(); blocks.append(.image(alt: image[0], destination: image[1])); i += 1; continue
            }
            if trimmed.hasPrefix(">") {
                flush(); var quote: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    quote.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces)); i += 1
                }
                blocks.append(.quote(quote.joined(separator: "\n"))); continue
            }
            if let list = captures("^([ \\t]*)([-+*]|[0-9]+[.)])[ \\t]+(.+)$", line) {
                flush(); let depth = min(6, list[0].replacingOccurrences(of: "\t", with: "    ").count / 2)
                let marker = ["-", "+", "*"].contains(list[1]) ? "•" : list[1]
                var body = list[2]; i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty,
                    lines[i].prefix(while: { $0 == " " }).count > list[0].count,
                    captures("^[ \\t]*([-+*]|[0-9]+[.)])[ \\t]+", lines[i]) == nil {
                    body += "\n" + lines[i].trimmingCharacters(in: .whitespaces); i += 1
                }
                blocks.append(.list(marker: marker, text: body, depth: depth)); continue
            }
            if i + 1 < lines.count, trimmed.contains("|"), isTableSeparator(lines[i + 1]) {
                flush(); let header = cells(line); var rows: [[String]] = []; i += 2
                while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    let row = cells(lines[i]); rows.append(Array((row + Array(repeating: "", count: header.count)).prefix(header.count))); i += 1
                }
                blocks.append(.table(header: header, rows: rows)); continue
            }
            paragraph.append(line); i += 1
        }
        flush(); return blocks
    }
    private static func captures(_ pattern: String, _ text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern), let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<match.numberOfRanges).map { Range(match.range(at: $0), in: text).map { String(text[$0]) } ?? "" }
    }
    private static func fenceStart(_ text: String) -> (character: Character, count: Int, language: String)? {
        guard let character = text.first, character == "`" || character == "~" else { return nil }
        let count = text.prefix(while: { $0 == character }).count
        guard count >= 3 else { return nil }
        return (character, count, String(text.dropFirst(count)).trimmingCharacters(in: .whitespaces).components(separatedBy: .whitespaces).first ?? "")
    }
    private static func setext(_ text: String) -> Int? {
        let value = text.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return nil }
        if value.allSatisfy({ $0 == "=" }) { return 1 }
        if value.allSatisfy({ $0 == "-" }) { return 2 }
        return nil
    }
    static func cells(_ text: String) -> [String] {
        var value = text.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }; if value.hasSuffix("|"), !value.hasSuffix("\\|") { value.removeLast() }
        var result: [String] = [], cell = "", escaped = false, inCode = false
        for character in value {
            if escaped { cell.append(character); escaped = false; continue }
            if character == "\\" { escaped = true; continue }
            if character == "`" { inCode.toggle() }
            if character == "|" && !inCode { result.append(cell.trimmingCharacters(in: .whitespaces)); cell = "" } else { cell.append(character) }
        }
        if escaped { cell.append("\\") }; result.append(cell.trimmingCharacters(in: .whitespaces)); return result
    }
    private static func isTableSeparator(_ text: String) -> Bool {
        let values = cells(text)
        return !values.isEmpty && values.allSatisfy { captures("^:?-{3,}:?$", $0) != nil }
    }
}
public enum SafeContentURL {
    /// Only explicit HTTPS navigation. No executable/custom schemes or embedded credentials.
    public static func link(_ value: String) -> URL? {
        guard !value.contains(where: { $0.isWhitespace || $0.asciiValue.map { $0 < 32 || $0 == 127 } == true }),
              let url = URL(string: value), url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil else { return nil }
        return url
    }
}
