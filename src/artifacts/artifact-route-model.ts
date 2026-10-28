import type { Artifact } from "../ui/ArtifactTypes";
import { artifactNoteKey } from "../../shared/artifact-notes";

/** Account-local identity, never a share token or an access grant.
 * Keep contents, names and filesystem paths out of browser addresses.
 * Source files retain their address when rewritten; copies have their own ID. */
export function artifactRouteId(artifact: Artifact) {
  return artifactNoteKey(
    JSON.stringify(
      artifact.libraryId
        ? ["library", artifact.libraryId]
        : [
            "conversation",
            artifact.conversationId ?? "",
            artifact.sourcePath ?? artifact.id,
          ],
    ),
  );
}

export const artifactRoutePath = (artifact: Artifact) =>
  `/artifact/${artifactRouteId(artifact)}`;

export function findRoutedArtifact(artifacts: Artifact[], id: string) {
  const matches = artifacts.filter(
    (artifact) => artifactRouteId(artifact) === id,
  );
  // A collision or ambiguous source must never resolve to an arbitrary record.
  return matches.length === 1 ? matches[0] : undefined;
}
