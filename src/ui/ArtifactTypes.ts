export interface Artifact {
  /** Live editor backed by the owning conversation’s real workspace file. */
  blankArtifact?: import("../../shared/blank-artifacts").BlankArtifact;
  libraryId?: string;
  pinned?: boolean;
  shareRequest?: string;
  updatedAt?: number;
  surface?: "file" | "artifact";
  filename?: string;
  sourcePath?: string;
  sourceDigest?: string;
  id: string;
  name: string;
  language: string;
  content: string;
  conversationId?: string;
  projectId?: string;
  sharedWithYou?: boolean;
  /** Binary snapshot kept in the profile under `sourceDigest`; `content` is empty. */
  blob?: boolean;
  mime?: string;
  bytes?: number;
  /**
   * The file is past what a snapshot keeps: `content` is empty, `bytes` its
   * size when known. The viewer shows its too-large card.
   */
  contentOmitted?: boolean;
  /** The agent is rewriting the file: the panel shows its generating state. */
  generating?: boolean;
  /**
   * An earlier version picked in the version switcher: what the panel
   * shows, not the file's latest, so nothing publishes or syncs from it.
   */
  versionPinned?: boolean;
}
export function artifactsIn(text: string, prefix: string): Artifact[] {
  return [...text.matchAll(/```([\w+.-]*)[^\n]*\n([\s\S]*?)```/g)].map(
    (m, i) => ({
      id: `${prefix}-${i}`,
      name: `${["html", "svg", "jsx", "tsx", "react", "mermaid"].includes(m[1]) ? "Preview" : "Code"} ${i + 1}`,
      language: m[1] || "text",
      content: m[2],
    }),
  );
}
