import Foundation

/// An artifact's versions on the artifact sheet's footer ("Version 2 of 3", Previous / Next, strings
/// `artifact_sheet_footer_*`). The web derives them the same way (src/artifacts/artifact-versions.ts): every turn that
/// writes a generated file keeps a snapshot of it, so a file the agent rewrote has one version per write on the
/// conversation's current branch; a rewrite that changed nothing counts once. The last is the latest.
public enum ArtifactVersions {
    /// The snapshots of the file at `path`, oldest first. A fenced block or a library copy has no path and no history.
    public static func of(turns: [Turn], path: String) -> [GeneratedFile] {
        guard !path.isEmpty else { return [] }
        var versions: [GeneratedFile] = []
        for turn in turns {
            for item in turn.items {
                for file in item.generatedFiles where file.path == path && file.isReady {
                    // A text snapshot carries its text, a binary one its digest.
                    if file.blob == true ? file.digest == nil : file.content == nil { continue }
                    if let last = versions.last, key(last) == key(file) { continue }
                    versions.append(file)
                }
            }
        }
        return versions
    }
    private static func key(_ file: GeneratedFile) -> String { file.digest ?? String((file.content ?? "").hashValue) }
}

/// The project file "Copy to project" makes of a text artifact: `<title>.<extension>` with the shown version's text.
/// Mirrors src/artifacts/artifact-project-file.ts.
public enum ArtifactProjectFile {
    /// Text files and PDFs a project keeps (shared/collections-api.ts knowledgeExtensions).
    public static let extensions: Set<String> = Set(
        ("txt md markdown csv tsv json jsonl yaml yml xml html htm svg mermaid css js mjs cjs ts tsx jsx py java c h cpp hpp "
            + "cs go rs rb php swift kt sh sql toml ini log tex rst pdf").split(separator: " ").map(String.init))
    private static let languageExtensions: [String: String] = [
        "javascript": "js", "typescript": "ts", "python": "py", "python3": "py", "ruby": "rb", "rust": "rs", "golang": "go",
        "kotlin": "kt", "bash": "sh", "shell": "sh", "zsh": "sh", "yml": "yaml", "c++": "cpp", "c#": "cs", "csharp": "cs",
        "text": "txt", "plaintext": "txt", "markdown": "md",
    ]

    /// The name of the file; nil when the artifact is not text (a project's files cannot keep it).
    public static func name(title: String, filename: String?, language: String, blob: Bool = false) -> String? {
        if blob { return nil }
        let source = filename ?? title
        let own = (source as NSString).pathExtension.lowercased()
        let kept = extensions.contains(own) ? own : nil
        let stripped = kept != nil && title.lowercased().hasSuffix("." + own) ? String(title.dropLast(own.count + 1)) : title
        let base = clean(stripped)
        return (base.isEmpty ? "Artifact" : base) + "." + (kept ?? extensionFor(language))
    }
    private static func extensionFor(_ language: String) -> String {
        let lower = language.lowercased()
        switch lower {
        case "html": return "html"
        case "svg": return "svg"
        case "jsx", "tsx", "react": return "tsx"
        case "markdown", "md": return "md"
        case "mermaid": return "mermaid"
        case "csv": return "csv"
        case "tsv": return "tsv"
        default:
            let mapped = languageExtensions[lower] ?? lower
            return extensions.contains(mapped) ? mapped : "txt"
        }
    }
    private static func clean(_ value: String) -> String {
        let kept = value.unicodeScalars.filter { $0.properties.generalCategory != .control && $0.properties.generalCategory != .format }
        return String(String.UnicodeScalarView(kept)).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}

/// The message an artifact comment sends to the artifact's chat, word for word the web's (src/app/ArtifactHost.tsx
/// sendArtifactComment): `Comment on artifact "<name>":\n<comment>\n\n<context>`, so the web's transcript shows it as a
/// comment card. The selected text leads the comment as a quote.
public enum ArtifactComment {
    public static func prompt(name: String, comment: String, selection: String, path: String?, digest: String?, content: String) -> String {
        let title = name.replacingOccurrences(of: "\"", with: "'").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let quote = selection.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n")
        let context: String
        if let path, !path.isEmpty { context = "File: \(path)\nSnapshot: \(digest ?? "")" }
        else { context = "Artifact content:\n" + String(content.prefix(100_000)) }
        return "Comment on artifact \"\(title)\":\n\(quote)\n\n\(comment.trimmingCharacters(in: .whitespacesAndNewlines))\n\n\(context)"
    }
}
