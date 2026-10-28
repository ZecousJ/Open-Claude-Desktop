import { knowledgeExtensions } from "../../shared/collections-api";
import type { Artifact } from "../ui/ArtifactTypes";
import { cleanArtifactName } from "./artifact-name";
import { artifactKind, extensionOf } from "./artifact-kind";

/** The extension a code artifact's language is saved with. */
const languageExtensions: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  python3: "py",
  ruby: "rb",
  rust: "rs",
  golang: "go",
  kotlin: "kt",
  bash: "sh",
  shell: "sh",
  zsh: "sh",
  yml: "yaml",
  "c++": "cpp",
  "c#": "cs",
  csharp: "cs",
  text: "txt",
  plaintext: "txt",
  markdown: "md",
};

/** The extension the artifact's own file name ends in, when a project keeps it. */
function ownExtension(artifact: Artifact) {
  const own = extensionOf(artifact.filename ?? artifact.name);
  return knowledgeExtensions.includes(own) ? own : "";
}

/**
 * The extension the original gives each kind of artifact when it adds one to a
 * project.
 */
function extensionFor(artifact: Artifact) {
  const own = ownExtension(artifact);
  if (own) return own;
  switch (artifactKind(artifact)) {
    case "html":
      return "html";
    case "svg":
      return "svg";
    case "react":
      return "tsx";
    case "markdown":
      return "md";
    case "mermaid":
      return "mermaid";
    case "csv":
      return artifact.language.toLowerCase() === "tsv" ? "tsv" : "csv";
  }
  const language = artifact.language.toLowerCase();
  const mapped = languageExtensions[language] ?? language;
  return knowledgeExtensions.includes(mapped) ? mapped : "txt";
}

/**
 * The file a text artifact becomes in its project: "<title>.<extension>"
 * with the shown version's text. Null for anything that is not text (a
 * picture, a Word or Excel file), which a project's files cannot keep as the
 * original keeps them (it copies the artifact's text).
 */
export function artifactProjectFile(
  artifact: Artifact,
): { name: string; data: Uint8Array } | null {
  if (artifact.blob) return null;
  const own = ownExtension(artifact);
  const base =
    cleanArtifactName(
      own && artifact.name.toLowerCase().endsWith(`.${own}`)
        ? artifact.name.slice(0, -(own.length + 1))
        : artifact.name,
    ) || "Artifact";
  return {
    name: `${base}.${extensionFor(artifact)}`,
    data: new TextEncoder().encode(artifact.content),
  };
}
