import { createContext } from "react";
import type { Artifact } from "../ui/components";
import type {
  ArtifactShareInfo,
  ArtifactLibraryState,
} from "../../shared/types";

// What the transcript, panes and pages share about artifacts, apart from the
// card itself (ArtifactCard.tsx loads lazily with its sheet glyphs).
export const ArtifactSelection = createContext<Artifact | undefined>(undefined);
export const ArtifactShareContext = createContext<ArtifactShareInfo[]>([]);
export const ArtifactLibraryContext = createContext<ArtifactLibraryState>({
  version: 1,
  copies: [],
  pinned: [],
});
export function sameArtifact(a: Artifact, b: Artifact) {
  if (a.libraryId || b.libraryId)
    return Boolean(a.libraryId && a.libraryId === b.libraryId);
  if (
    a.conversationId &&
    b.conversationId &&
    a.conversationId !== b.conversationId
  )
    return false;
  return a.sourcePath && b.sourcePath
    ? a.sourcePath === b.sourcePath
    : a.id === b.id || (a.content === b.content && a.name === b.name);
}
