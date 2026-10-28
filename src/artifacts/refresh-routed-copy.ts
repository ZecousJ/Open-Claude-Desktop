import type { ArtifactLibraryState, SavedArtifact } from "../../shared/types";

/** Refresh only the still-imported copy; preserve concurrent pins/other copies. */
export function mergeRoutedCopy(
  current: ArtifactLibraryState,
  libraryId: string,
  token: string,
  artifact: SavedArtifact,
): ArtifactLibraryState {
  if (
    !artifact ||
    artifact.libraryId !== libraryId ||
    typeof artifact.name !== "string" ||
    typeof artifact.language !== "string" ||
    typeof artifact.content !== "string"
  )
    return current;
  const copy = current.copies.find((value) => value.libraryId === libraryId);
  if (!copy || copy.sharedArtifactToken !== token) return current;
  return {
    ...current,
    copies: current.copies.map((value) =>
      value === copy
        ? {
            ...copy,
            name: artifact.name,
            language: artifact.language,
            content: artifact.content,
          }
        : value,
    ),
  };
}
