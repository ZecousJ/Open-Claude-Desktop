package com.claudex.core

/**
 * An artifact's versions on the artifact sheet's footer ("Version 2 of 3", Previous / Next, strings
 * `artifact_sheet_footer_*`). The web derives them the same way (src/artifacts/artifact-versions.ts): every turn
 * that writes a generated file keeps a snapshot of it, so a file the agent rewrote has one version per write on the
 * conversation's current branch; a rewrite that changed nothing counts once. The last is the latest.
 */
object ArtifactVersions {
    /** The snapshots of the file at [path], oldest first. A fenced block or a library copy has no path and no history. */
    fun of(turns: List<Turn>, path: String): List<GeneratedFile> {
        if (path.isBlank()) return emptyList()
        val versions = mutableListOf<GeneratedFile>()
        for (turn in turns) for (item in turn.items) for (file in item.generatedFiles) {
            if (file.path != path || file.state != "ready") continue
            // A text snapshot carries its text, a binary one its digest.
            if (if (file.blob) file.digest == null else file.content == null) continue
            if (versions.lastOrNull()?.let { key(it) == key(file) } == true) continue
            versions += file
        }
        return versions
    }
    private fun key(file: GeneratedFile) = file.digest ?: file.content.hashCode().toString()
}

/**
 * The project file "Copy to project" makes of a text artifact: `<title>.<extension>` with the shown version's text.
 * 
 * Mirrors src/artifacts/artifact-project-file.ts.
 */
object ArtifactProjectFile {
    /** Text files and PDFs a project keeps (shared/collections-api.ts knowledgeExtensions). */
    val extensions: Set<String> = ("txt md markdown csv tsv json jsonl yaml yml xml html htm svg mermaid css js mjs cjs ts tsx jsx py java c h cpp hpp " +
        "cs go rs rb php swift kt sh sql toml ini log tex rst pdf").split(' ').toSet()
    private val languageExtensions = mapOf("javascript" to "js", "typescript" to "ts", "python" to "py", "python3" to "py", "ruby" to "rb", "rust" to "rs",
        "golang" to "go", "kotlin" to "kt", "bash" to "sh", "shell" to "sh", "zsh" to "sh", "yml" to "yaml", "c++" to "cpp", "c#" to "cs", "csharp" to "cs",
        "text" to "txt", "plaintext" to "txt", "markdown" to "md")

    /** The name of the file; null when the artifact is not text (a project's files cannot keep it). */
    fun name(title: String, filename: String?, language: String, blob: Boolean = false): String? {
        if (blob) return null
        val own = (filename ?: title).substringAfterLast('.', "").lowercase().takeIf { it in extensions }
        val stripped = if (own != null && title.lowercase().endsWith(".$own")) title.dropLast(own.length + 1) else title
        val base = clean(stripped).ifBlank { "Artifact" }
        return "$base.${own ?: extensionFor(language)}"
    }
    private fun extensionFor(language: String): String {
        val lower = language.lowercase()
        return when (lower) {
            "html" -> "html"
            "svg" -> "svg"
            "jsx", "tsx", "react" -> "tsx"
            "markdown", "md" -> "md"
            "mermaid" -> "mermaid"
            "csv" -> "csv"
            "tsv" -> "tsv"
            else -> (languageExtensions[lower] ?: lower).takeIf { it in extensions } ?: "txt"
        }
    }
    private fun clean(value: String) = value.filterNot { it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() }
        .replace(Regex("\\s+"), " ").trim()
}

/**
 * The message an artifact comment sends to the artifact's chat, word for word the web's (src/app/ArtifactHost.tsx
 * sendArtifactComment): `Comment on artifact "<name>":\n<comment>\n\n<context>`, so the web's transcript shows it as a
 * comment card. The selected text leads the comment as a quote.
 */
object ArtifactComment {
    fun prompt(name: String, comment: String, selection: String, path: String?, digest: String?, content: String): String {
        val title = name.replace('"', '\'').replace(Regex("\\s+"), " ").trim()
        val quote = selection.trim().lines().joinToString("\n") { "> $it" }
        val context = if (!path.isNullOrBlank()) "File: $path\nSnapshot: ${digest.orEmpty()}" else "Artifact content:\n${content.take(100_000)}"
        return "Comment on artifact \"$title\":\n$quote\n\n${comment.trim()}\n\n$context"
    }
}
