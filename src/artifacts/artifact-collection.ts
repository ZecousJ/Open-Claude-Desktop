import type {
  ArtifactLibraryState,
  ArtifactShareInfo,
  Conversation,
} from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
import { artifactsIn } from "../ui/ArtifactTypes";
import { generatedArtifact } from "./generatedArtifact";
import { latestGeneratedFiles } from "../../shared/generated-files";
import { blankConversationArtifact } from "./blank-artifact-model";
import { artifactIdentity } from "./artifact-metadata";
import { isDeviceExecutionCopy } from "../../shared/chat-devices-api";

/** The library combines live conversation sources and independent account copies. */
export function collectArtifacts(
  conversations: Conversation[],
  shares: ArtifactShareInfo[],
  library: ArtifactLibraryState,
): Artifact[] {
  const sources = conversations
    .filter((c) => !isDeviceExecutionCopy(c))
    .flatMap((c) => [
      ...[blankConversationArtifact(c)].filter((value): value is Artifact =>
        Boolean(value),
      ),
      ...c.turns.flatMap((t) =>
        t.items
          .filter((i) => i.type === "agentMessage")
          .flatMap((i) =>
            artifactsIn(i.text ?? "", i.id).map((a) => ({
              ...a,
              conversationId: c.id,
              projectId: c.projectId,
              sharedWithYou: Boolean(
                c.sessionAuthors &&
                c.sessionAuthors.ownerAccountUuid !==
                  c.sessionAuthors.viewerAccountUuid,
              ),
              name: `${c.title} · ${a.language}`,
            })),
          ),
      ),
      ...[...latestGeneratedFiles(c.turns).values()].flatMap((file) => {
        // Binary files open from their conversation only: the library's
        // actions (share, duplicate, export, copy) work on text.
        if (
          c.blankArtifact &&
          file.path.replaceAll("\\", "/") ===
            `${c.cwd?.replaceAll("\\", "/")}/${c.blankArtifact.file}`
        )
          return [];
        const a = generatedArtifact(file);
        return a && !a.blob
          ? [
              {
                ...a,
                conversationId: c.id,
                projectId: c.projectId,
                sharedWithYou: Boolean(
                  c.sessionAuthors &&
                  c.sessionAuthors.ownerAccountUuid !==
                    c.sessionAuthors.viewerAccountUuid,
                ),
              },
            ]
          : [];
      }),
    ]);
  const copies: Artifact[] = library.copies.map((copy) => ({
    id: copy.libraryId,
    libraryId: copy.libraryId,
    name: copy.name,
    language: copy.language,
    content: copy.content,
    conversationId: copy.originConversationId,
    updatedAt: copy.createdAt,
    sharedWithYou: Boolean(copy.sharedArtifactToken),
  }));
  const pinOrder = new Map(
    library.pinned.map((identity, index) => [identity, index]),
  );
  const pinned = new Set(library.pinned);
  // Every artifact is listed: the old share popover's "Show in Artifacts list"
  // switch is gone with it, so an artifact it hid shows again. `shares` is kept
  // for the callers.
  void shares;
  return [...sources, ...copies]
    .map((artifact) => ({
      ...artifact,
      pinned: pinned.has(artifactIdentity(artifact)),
    }))
    .sort((a, b) => {
      const left = pinOrder.get(artifactIdentity(a)),
        right = pinOrder.get(artifactIdentity(b));
      return left === undefined
        ? right === undefined
          ? 0
          : 1
        : right === undefined
          ? -1
          : left - right;
    });
}
