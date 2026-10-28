import { z } from "zod";
import type { ArtifactLibrary } from "../artifacts/artifact-library";
import type { AppContext } from "../app/app-context";
import {
  artifactVersion,
  restoredArtifact,
} from "../artifacts/artifact-versions";
import {
  contextSources,
  conversationWorkspace,
} from "../workspace/workspace-fs";
import { registerBlankArtifactHandlers } from "./blank-artifacts";
type Handle = (name: string, fn: (...args: any[]) => any) => void;
export function registerArtifactLibraryHandlers(
  handle: Handle,
  getLibrary: () => ArtifactLibrary,
  onDeleteShare: (identity: string) => void,
  ctx?: AppContext,
) {
  if (ctx) registerBlankArtifactHandlers(handle, ctx);
  handle(
    "restoreArtifactVersion",
    async (rawId: unknown, rawPath: unknown, rawDigest: unknown) => {
      if (!ctx) return false;
      const conversation = ctx.store.conversation(
        z.string().min(1).max(500).parse(rawId),
      );
      const filename = z.string().min(1).max(4096).parse(rawPath);
      const digest = z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .parse(rawDigest);
      if (
        !conversation.cwd ||
        conversation.turns.some((turn) => turn.status === "inProgress")
      )
        return false;
      const root = ctx.store.root;
      ctx.allowedFolder(conversation.cwd, conversation.environment);
      ctx.services.workspaceTrust?.assert({
        mode: conversation.mode,
        conversation,
        cwd: conversation.cwd,
      });
      if (conversation.mode === "cowork") {
        const access = ctx.services.coworkFolders?.access(
          conversation.cwd,
          conversation.id,
          conversation.projectId,
        );
        if (access?.state !== "granted" && access?.state !== "trusted")
          return false;
      }
      const version = artifactVersion(conversation, filename, digest, root);
      if (!version) return false;
      const workspace = conversationWorkspace(
        contextSources(ctx),
        conversation,
      );
      if (!workspace.writeFileInside) return false;
      await workspace.writeFileInside(
        conversation.cwd,
        filename,
        version.bytes,
        () => {
          if (
            ctx.store.root !== root ||
            !ctx.store.conversations.includes(conversation) ||
            conversation.turns.some((turn) => turn.status === "inProgress")
          )
            throw new Error("The request failed.");
          ctx.allowedFolder(conversation.cwd, conversation.environment);
          ctx.services.workspaceTrust?.assert({
            mode: conversation.mode,
            conversation,
            cwd: conversation.cwd!,
          });
          if (conversation.mode === "cowork") {
            const access = ctx.services.coworkFolders?.access(
              conversation.cwd!,
              conversation.id,
              conversation.projectId,
            );
            if (access?.state !== "granted" && access?.state !== "trusted")
              throw new Error("The request failed.");
          }
        },
      );
      if (
        ctx.store.root !== root ||
        !ctx.store.conversations.includes(conversation)
      )
        return false;
      const restored = restoredArtifact(version.file);
      conversation.turns.at(-1)!.items.push({
        id: restored.id,
        type: "fileChange",
        generatedFiles: [restored],
      });
      conversation.updatedAt = restored.capturedAt!;
      ctx.store.flush();
      ctx.push({
        type: "conversation",
        conversation: structuredClone(conversation),
      });
      return true;
    },
  );
  handle("duplicateArtifact", (raw: unknown) => getLibrary().duplicate(raw));
  handle("deleteArtifactCopy", (raw: unknown) => {
    const libraryId = z.string().uuid().parse(raw);
    if (
      !getLibrary()
        .list()
        .copies.some((copy) => copy.libraryId === libraryId)
    )
      throw Error("Artifact copy not found.");
    onDeleteShare(JSON.stringify(["library", libraryId]));
    return getLibrary().deleteCopy(libraryId);
  });
  handle("pinArtifact", (identity: unknown, pinned: unknown) =>
    getLibrary().pin(
      z.string().min(1).max(2_000_200).parse(identity),
      z.boolean().parse(pinned),
    ),
  );
  // Names, open times and comments (shared/artifact-notes.ts); inputs are validated by the store.
  handle("artifactNotes", () => getLibrary().notes.all());
  handle("updateArtifactNote", (key: unknown, patch: unknown) =>
    getLibrary().notes.update(key, patch),
  );
  handle("importArtifactNotes", (notes: unknown) =>
    getLibrary().notes.import(notes),
  );
}
