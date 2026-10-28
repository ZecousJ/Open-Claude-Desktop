import { blankConversationArtifact } from "./blank-artifact-model";
import type { Snapshot } from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
import { collectArtifacts } from "./artifact-collection";
import { artifactRouteId, findRoutedArtifact } from "./artifact-route-model";
/** A URL selects only metadata already owned by this account and conversation.
 * Resolving a candidate never performs file I/O or discovers another account. */
export function resolvePairedArtifact(
  snapshot: Pick<
    Snapshot,
    "conversations" | "artifactLibrary" | "artifactShares"
  >,
  conversationId: string,
  id: string,
): Artifact | undefined {
  const conversation = snapshot.conversations.find(
    (value) =>
      value.id === conversationId && !value.incognito && value.mode !== "code",
  );
  if (!conversation) return;
  const candidates = collectArtifacts(
    [conversation],
    snapshot.artifactShares ?? [],
    snapshot.artifactLibrary,
  ).filter((value) => value.conversationId === conversationId);
  const artifact = findRoutedArtifact(candidates, id);
  return artifact ? { ...artifact, surface: "artifact" } : undefined;
}
export function pairedArtifactRouteId(
  artifact: Artifact | undefined,
  conversationId: string | undefined,
) {
  return artifact?.surface === "artifact" &&
    conversationId &&
    artifact.conversationId === conversationId
    ? artifactRouteId(artifact)
    : undefined;
}

/** Only a stored origin binding restores by default; never guess among a
 * conversation's generated files or an unrelated library copy. */
export function originPairedArtifact(
  snapshot: Pick<Snapshot, "conversations">,
  conversationId: string,
) {
  const conversation = snapshot.conversations.find(
    (value) =>
      value.id === conversationId && !value.incognito && value.mode !== "code",
  );
  return conversation ? blankConversationArtifact(conversation) : undefined;
}
