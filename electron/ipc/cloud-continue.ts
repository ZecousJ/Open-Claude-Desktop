import { z } from "zod";
import type {
  CloudContinuationPlan,
  CloudSavedWork,
  CloudUploadResult,
} from "../../shared/cloud-continue-api";
import type { Conversation } from "../../shared/types";
import type { AppContext, IpcHandle } from "../app/app-context";
import {
  buildSnapshot,
  commonGitDir,
  readCensus,
  readContinuationPlan,
  transportRef,
} from "../cloud/continue-in-cloud";
import {
  CloudPushError,
  transportPreamble,
  uploadForCloud,
} from "../cloud/cloud-upload";
import { localWorkingTree } from "../git/working-tree";

const id = z.string().min(1).max(200);
const continuationOptions = z
  .object({ includeUntracked: z.boolean().optional() })
  .strict()
  .optional();
const uploadOptions = z
  .object({ alreadyUploaded: z.boolean().optional() })
  .strict()
  .optional();

/** The service's push lease for a repository ("owner/name"). */
export type PushLease = (repository: string) => Promise<unknown>;

/** The work a session saved last, kept here (a window never names a commit). */
interface Saved extends CloudSavedWork {
  gitDir: string;
  aheadOfUpstream?: number;
}

/** Why saving stopped, in the dialog's words. */
const blockedWords = {
  operation_in_progress:
    "A git operation is in progress in this folder. Finish or abort it, then check again.",
  conflicts:
    "This folder has unresolved merge conflicts. Resolve them, or ask Claudex to, then check again.",
  too_many_untracked:
    "Your files or origin may have changed, so nothing was moved yet. Check what comes along, then continue.",
} as const;

/**
 * Continue in cloud (shared/cloud-continue-api.ts). The plan and the save
 * read and save the session's own folder on this computer; the upload's
 * credential comes from the service through the cloud router
 * (electron/cloud/cloud-router.ts passes `lease`; a call straight from a
 * window carries no function, so it never uploads on its own).
 */
export function registerCloudContinueHandlers(
  handle: IpcHandle,
  ctx: Pick<AppContext, "store" | "engine">,
) {
  const saved = new Map<string, Saved>();

  /** The session's folder, when it is a Code session on this computer. */
  const localFolder = (conversation: Conversation) =>
    conversation.mode === "code" &&
    !conversation.incognito &&
    conversation.cwd &&
    (!conversation.environment || conversation.environment.kind === "local")
      ? conversation.cwd
      : undefined;

  handle(
    "cloudContinuationPlan",
    async (
      conversationId: unknown,
      options?: unknown,
    ): Promise<CloudContinuationPlan> => {
      const folder = localFolder(
        ctx.store.conversation(id.parse(conversationId)),
      );
      if (!folder) return { kind: "unsupported", reason: "elsewhere" };
      const { includeUntracked } = continuationOptions.parse(options) ?? {};
      return readContinuationPlan(
        localWorkingTree.git,
        folder,
        includeUntracked !== false,
      );
    },
  );

  handle(
    "saveWorkForCloud",
    async (conversationId: unknown, options?: unknown) => {
      const key = id.parse(conversationId);
      const folder = localFolder(ctx.store.conversation(key));
      if (!folder)
        throw new Error("This session can’t be moved to the cloud from here.");
      const { includeUntracked } = continuationOptions.parse(options) ?? {};
      // Read again: the folder may have changed since the dialog opened.
      const census = await readCensus(
        localWorkingTree.git,
        folder,
        includeUntracked !== false,
      );
      if (census.kind === "blocked")
        throw new Error(blockedWords[census.blocker]);
      if (census.kind !== "ready")
        throw new Error("This session can’t be moved to the cloud from here.");
      const work = await buildSnapshot(census.folder);
      const entry: Saved = {
        ...work,
        branch: census.folder.branch,
        repository: census.folder.repository,
        gitDir: await commonGitDir(localWorkingTree.git, folder),
        ...(census.folder.census.aheadOfUpstream !== undefined
          ? { aheadOfUpstream: census.folder.census.aheadOfUpstream }
          : {}),
      };
      saved.set(key, entry);
      const answer: CloudSavedWork = {
        tip: entry.tip,
        snapshot: entry.snapshot,
        branch: entry.branch,
        repository: entry.repository,
      };
      return answer;
    },
  );

  handle(
    "uploadWorkForCloud",
    async (
      conversationId: unknown,
      options?: unknown,
      lease?: unknown,
    ): Promise<CloudUploadResult> => {
      if (typeof lease !== "function")
        throw new Error(
          "Sign in to Claudex and turn on sync with the web, then try again.",
        );
      const key = id.parse(conversationId);
      if (!localFolder(ctx.store.conversation(key)))
        throw new Error("This session can’t be moved to the cloud from here.");
      const work = saved.get(key);
      if (!work)
        throw new Error(
          "Your files or origin may have changed, so nothing was moved yet. Check what comes along, then continue.",
        );
      const { alreadyUploaded } = uploadOptions.parse(options) ?? {};
      try {
        const uploaded = await uploadForCloud({
          gitDir: work.gitDir,
          tip: work.tip,
          snapshot: work.snapshot,
          branch: work.branch,
          repository: work.repository,
          ref: transportRef(key),
          lease: lease as PushLease,
          ...(alreadyUploaded ? { alreadyUploaded } : {}),
        });
        const fromBranch = uploaded.repository.ref === work.branch;
        return {
          ok: true,
          repository: uploaded.repository,
          // A cloud session on the branch as origin has it needs no note.
          ...(fromBranch ? {} : { preamble: transportPreamble(work) }),
          ...(uploaded.unverified ? { unverified: true } : {}),
        };
      } catch (error) {
        if (error instanceof CloudPushError)
          return {
            ok: false,
            failure: error.failure,
            message: error.message,
            ...(error.excerpt ? { excerpt: error.excerpt } : {}),
            ...(error.command ? { command: error.command } : {}),
          };
        throw error;
      }
    },
  );

  handle("writeHandOffNote", (conversationId: unknown) =>
    ctx.engine.writeHandOffNote(id.parse(conversationId)),
  );
}
