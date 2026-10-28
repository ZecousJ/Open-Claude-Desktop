import type { Artifact } from "../ui/ArtifactTypes";

/** How an artifact is shown in the panel. */
export type ArtifactKind =
  | "html"
  | "svg"
  | "react"
  | "markdown"
  | "mermaid"
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "csv"
  | "code"
  | "file";

type Source = Pick<Artifact, "language" | "name"> &
  Partial<Pick<Artifact, "filename" | "mime" | "blob" | "contentOmitted">>;

export function extensionOf(name: string) {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
}

export function artifactKind(a: Source): ArtifactKind {
  const extension = extensionOf(a.filename ?? a.name);
  // Nothing to render: the viewer's file card says why.
  if (a.contentOmitted) return "file";
  if (a.blob) {
    if (a.mime?.startsWith("image/")) return "image";
    if (a.mime === "application/pdf") return "pdf";
    // A saved file without its type goes by its extension.
    if (!a.mime || a.mime === "application/octet-stream") {
      if (/^(png|jpe?g|gif|webp|bmp|avif)$/.test(extension)) return "image";
      if (extension === "pdf") return "pdf";
    }
    if (extension === "docx") return "docx";
    if (extension === "xlsx") return "xlsx";
    if (extension === "pptx") return "pptx";
    return "file";
  }
  switch (a.language.toLowerCase()) {
    case "html":
      return "html";
    case "svg":
      return "svg";
    case "jsx":
    case "tsx":
    case "react":
      return "react";
    case "markdown":
    case "md":
      return "markdown";
    case "mermaid":
      return "mermaid";
    case "csv":
    case "tsv":
      return "csv";
  }
  if (extension === "csv" || extension === "tsv") return "csv";
  return "code";
}

export function canExportDocument(artifact: Source & { generating?: boolean }) {
  return (
    !artifact.generating &&
    !artifact.contentOmitted &&
    ["markdown", "docx"].includes(artifactKind(artifact))
  );
}

export function canExportPresentation(
  artifact: Source & { content: string; generating?: boolean },
) {
  if (artifact.generating || artifact.contentOmitted) return false;
  const kind = artifactKind(artifact);
  return (
    kind === "pptx" ||
    (!artifact.blob &&
      ((kind === "markdown" &&
        /presentation|slides|deck/i.test(artifact.name)) ||
        (kind === "html" &&
          /data-slide|class=["'][^"']*\bslide\b/i.test(artifact.content))))
  );
}

/** Rendered inside the sandboxed preview frame. */
export const frameKinds: ReadonlySet<ArtifactKind> = new Set([
  "html",
  "svg",
  "react",
  "mermaid",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
]);
/** Kinds that have a rendered view besides their source. */
export const previewKinds: ReadonlySet<ArtifactKind> = new Set([
  ...frameKinds,
  "markdown",
  "image",
  "csv",
]);
/** Binary files keep their bytes; only text kinds have a Code view. */
export function hasSource(kind: ArtifactKind) {
  return !["image", "pdf", "docx", "xlsx", "pptx", "file"].includes(kind);
}
/**
 * The panel's views of one kind: a rendered preview (a file card for types
 * without one), the numbered source, or both behind the Preview/Code toggle.
 */
export function artifactViews(kind: ArtifactKind) {
  return {
    preview: previewKinds.has(kind) || kind === "file",
    source: hasSource(kind),
  };
}

/** Short type label for cards and the file viewer title ("HTML", "PDF"…). */
export function kindLabel(a: Source) {
  const extension = extensionOf(a.filename ?? "");
  if (extension) return extension.toUpperCase();
  const kind = artifactKind(a);
  if (kind === "react") return "React";
  if (kind === "mermaid") return "Mermaid";
  if (kind === "markdown") return "Markdown";
  return a.language.toUpperCase();
}
