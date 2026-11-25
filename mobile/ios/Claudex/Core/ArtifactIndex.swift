import Foundation

public enum ArtifactIndex {
    /// Static HTML/SVG previews use a separate script-free, network-free WebView.
    public static func staticPreviewLanguage(language: String, name: String, mime: String? = nil) -> String? {
        let language = language.lowercased()
        let mime = (mime ?? "").split(separator: ";").first.map(String.init)?.lowercased() ?? ""
        if ["html", "htm", "text/html"].contains(language) || mime == "text/html" { return "html" }
        if ["svg", "image/svg+xml"].contains(language) || mime == "image/svg+xml" { return "svg" }
        guard ["", "text", "plaintext", "unknown"].contains(language) else { return nil }
        switch (name as NSString).pathExtension.lowercased() {
        case "html", "htm": return "html"
        case "svg": return "svg"
        default: return nil
        }
    }
    /// Later snapshots replace earlier paths, including unavailable/deleted states.
    public static func latestGeneratedFiles(_ conversation: Conversation) -> [GeneratedFile] {
        var latest: [String: GeneratedFile] = [:]
        for turn in conversation.turns { for item in turn.items { for file in item.generatedFiles { latest[file.path] = file } } }
        return latest.values.sorted { $0.path < $1.path }
    }

    public static func identity(_ values: [String]) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]
        return (try? encoder.encode(values)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
    /// Matches shared ArtifactTypes.ts; only assistant agentMessage content is indexed.
    public static func fencedArtifacts(_ item: TranscriptItem, conversation: Conversation) -> [JSONValue] {
        guard item.type == "agentMessage", let text = item.text,
              let expression = try? NSRegularExpression(pattern: "```([A-Za-z0-9_+.-]*)[^\\n]*\\n([\\s\\S]*?)```") else { return [] }
        return expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).enumerated().compactMap { index, match in
            guard let languageRange = Range(match.range(at: 1), in: text), let contentRange = Range(match.range(at: 2), in: text) else { return nil }
            let language = String(text[languageRange]), content = String(text[contentRange])
            return .object(["libraryId": .string("inline:" + conversation.id + ":" + item.id + ":" + String(index)), "name": .string(conversation.title + " · " + (language.isEmpty ? "text" : language)), "language": .string(language.isEmpty ? "text" : language), "content": .string(content), "originConversationId": .string(conversation.id), "identity": .string(identity([conversation.id, content]))])
        }
    }
}
