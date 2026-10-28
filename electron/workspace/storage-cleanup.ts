import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import type {
  StorageCleanupKind,
  StorageCleanupPreviewResult,
  StorageCleanupResult,
} from "../../shared/settings-desktop-api";
import {
  cleanupEligible,
  conversationAttachments,
  conversationSpace,
  conversationThreads,
  dayMs,
  DiskMeasure,
  freedBytes,
  lastActivityAt,
  rolloutIndex,
  screenshotFolder,
  type RolloutFile,
} from "./storage-usage";

/**
 * Settings → System → Storage → Free up space… and Clean up inactive sessions…:
 * delete the conversations with no activity for 30, 60 or 90 days, with what
 * only they use. A preview lists them and hands out a token; running checks
 * each one again and leaves alone any that became active, got pinned, started
 * running or whose history changed on this computer since (copied or restored).
 * The person's own folders are never touched: Cowork's chosen folders, Code's
 * project folders and the shared workspace stay as they are.
 */

/** A preview can be confirmed for ten minutes. */
export const planLifetimeMs = 10 * 60 * 1000;
/** Titles the preview lists, and how long each may be (I5i, L5i). */
const exampleCount = 5;
const exampleLength = 80;

export interface CleanupHost {
  /** The signed-in account's profile folder. */
  readonly root: string;
  conversations(): readonly Conversation[];
  /** Deletes one conversation for good (`removeConversation`); throws to leave it. */
  remove(conversation: Conversation, rollouts: string[]): Promise<void>;
  /** All deletions are done: tidy what no conversation uses any more. */
  finished?(): void;
  /** Removes a Code session's worktree, its uncommitted work with it (the branch stays). */
  removeWorktree?(conversation: Conversation): Promise<void>;
  now?(): number;
}

interface Plan {
  token: string;
  kind: StorageCleanupKind;
  days: number;
  root: string;
  ids: string[];
  createdAt: number;
}

/** A title as the preview lists it: trimmed, at most 80 characters (H5i). */
export function exampleTitle(title: string): string {
  const text = title.slice(0, 640).trim();
  const characters = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (part) => part.segment,
  );
  return characters.length > exampleLength
    ? `${characters.slice(0, exampleLength - 1).join("")}…`
    : text;
}

/** A failure because another program has the files open. */
export const inUseMarker = "[conversation-files-in-use]";
const inUseCodes = new Set(["EBUSY", "EPERM", "EACCES"]);

/** A local Code session whose worktree folder is still there. */
const hasWorktreeOnDisk = (c: Conversation) =>
  c.mode === "code" &&
  !!c.worktree &&
  (!c.environment || c.environment.kind === "local") &&
  existsSync(c.worktree.path);

export class StorageCleanup {
  private plan?: Plan;
  private running?: { cancelled: boolean };
  constructor(private readonly host: CleanupHost) {}

  private now() {
    return this.host.now?.() ?? Date.now();
  }

  /** What deleting the conversations inactive for `days` days would free. */
  async preview(
    kind: StorageCleanupKind,
    days: number,
  ): Promise<StorageCleanupPreviewResult> {
    const now = this.now();
    const all = this.host.conversations();
    const candidates = all
      .filter((c) => cleanupEligible(c, kind, days, now))
      .sort((a, b) => lastActivityAt(b) - lastActivityAt(a));
    const measure = new DiskMeasure();
    const index = await rolloutIndex(
      path.join(this.host.root, "codex-home"),
      measure,
    );
    const space = await conversationSpace(this.host.root, all, measure, index);
    // Inactive by the record, and nothing of it changed here since either.
    const cutoff = now - days * dayMs;
    const verified = candidates.filter((c) =>
      (space.rollouts.get(c.id) ?? []).every((file) => file.changedAt < cutoff),
    );
    const ids = verified.map((c) => c.id);
    const token = randomUUID();
    this.plan = {
      token,
      kind,
      days,
      root: this.host.root,
      // The oldest goes first (k7i reverses the newest-first list).
      ids: [...ids].reverse(),
      createdAt: now,
    };
    return {
      preview: {
        token,
        kind,
        olderThanDays: days,
        count: ids.length,
        chatCount: verified.filter((c) => c.mode === "chat").length,
        bytes: freedBytes(space, new Set(ids)),
        examples: verified
          .map((c) => ({
            title: exampleTitle(c.title ?? ""),
            bytes: freedBytes(space, new Set([c.id])),
          }))
          .filter((example) => example.title.length > 0)
          .slice(0, exampleCount),
        unverifiedCount: candidates.length - verified.length,
        ...(kind === "code"
          ? { worktreeCount: verified.filter(hasWorktreeOnDisk).length }
          : {}),
      },
    };
  }

  /** The plan a token names, once; none when it expired or was replaced. */
  private take(token: string): Plan | undefined {
    const plan = this.plan;
    if (
      !plan ||
      plan.token !== token ||
      plan.root !== this.host.root ||
      this.now() - plan.createdAt > planLifetimeMs
    )
      return undefined;
    this.plan = undefined;
    return plan;
  }

  /**
   * Deletes what the preview listed, one conversation at a time;
   * `onProgress` hears how many were reached.
   */
  async run(
    token: string,
    options: { deleteSessions?: boolean },
    onProgress: (done: number, total: number) => void = () => {},
  ): Promise<StorageCleanupResult> {
    const result: StorageCleanupResult = {
      deletedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      failedInUseCount: 0,
      cancelled: false,
    };
    if (this.running) return { ...result, errorCode: "already-running" };
    const plan = this.take(token);
    if (!plan) return { ...result, errorCode: "expired" };
    // Clean up inactive sessions removes the sessions' worktrees unless it
    // is asked to delete the sessions too (which takes the worktrees along).
    if (plan.kind === "code" && !options.deleteSessions) {
      const removeWorktree = this.host.removeWorktree;
      const targets = plan.ids
        .map((id) => this.host.conversations().find((c) => c.id === id))
        .filter((c): c is Conversation => !!c && hasWorktreeOnDisk(c));
      result.worktreesRemoved = 0;
      onProgress(0, targets.length);
      for (const [index, conversation] of targets.entries()) {
        if (!removeWorktree) break;
        try {
          await removeWorktree(conversation);
          result.worktreesRemoved++;
        } catch {
          result.failedCount++;
        }
        onProgress(index + 1, targets.length);
      }
      return result;
    }
    const running = { cancelled: false };
    this.running = running;
    try {
      const index = await rolloutIndex(path.join(plan.root, "codex-home"));
      const total = plan.ids.length;
      let reached = 0;
      onProgress(0, total);
      for (const id of plan.ids) {
        if (running.cancelled) break;
        const now = this.now();
        const conversation = this.host.conversations().find((c) => c.id === id);
        if (
          !conversation ||
          this.host.root !== plan.root ||
          !cleanupEligible(conversation, plan.kind, plan.days, now)
        )
          result.skippedCount++;
        else {
          const files = await currentFiles(
            conversationThreads(conversation).flatMap(
              (thread) => index.get(thread) ?? [],
            ),
          );
          if (files.some((file) => file.changedAt >= now - plan.days * dayMs))
            result.skippedCount++;
          else
            try {
              await this.host.remove(
                conversation,
                files.map((file) => file.path),
              );
              result.deletedCount++;
            } catch (error) {
              result.failedCount++;
              if (String((error as Error)?.message).includes(inUseMarker))
                result.failedInUseCount++;
              console.warn(
                "Storage cleanup: couldn't delete a conversation:",
                error instanceof Error ? error.message : String(error),
              );
            }
        }
        reached++;
        try {
          onProgress(reached, total);
        } catch {
          // A window that went away misses the progress.
        }
      }
      result.cancelled = running.cancelled;
    } finally {
      this.running = undefined;
      if (result.deletedCount) this.host.finished?.();
    }
    return result;
  }

  /** Stops the running cleanup after the conversation it is deleting. */
  cancel() {
    if (this.running) this.running.cancelled = true;
  }
}

/** The history files as they are now (gone ones dropped, change times fresh). */
async function currentFiles(files: RolloutFile[]): Promise<RolloutFile[]> {
  const current: RolloutFile[] = [];
  for (const file of files)
    try {
      const stat = await fs.lstat(file.path);
      current.push({ ...file, bytes: stat.size, changedAt: stat.ctimeMs });
    } catch {
      // Gone already.
    }
  return current;
}

export interface RemoveContext {
  readonly root: string;
  readonly store: { conversations: Conversation[]; flush(): void };
  /** The local engine's connection, when it runs. */
  rpc?: { call(method: string, params: unknown): Promise<unknown> };
  closeTerminals?(conversationId: string): Promise<void>;
  /** Forgets everything else kept about it (feedback, folder grants, computer use). */
  forget?(conversationId: string): void | Promise<void>;
  /** Attachment files a window still holds (a draft's), which stay. */
  attachmentsInUse?(): Iterable<string>;
}

/** The thread a history file belongs to, from its name. */
const rolloutThread = (file: string) =>
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    .exec(path.basename(file))?.[1]
    ?.toLowerCase();

/**
 * Deletes a conversation with its files (deleteSessionFully in the live
 * bundle): its history files first, all or none, so a conversation whose
 * files are in use is left as it was; then its record, the attachment
 * copies no other conversation uses and its screenshots.
 */
export async function removeConversation(
  ctx: RemoveContext,
  conversation: Conversation,
  rollouts: string[],
): Promise<void> {
  const history = path.resolve(ctx.root, "codex-home");
  for (const file of rollouts)
    if (!path.resolve(file).startsWith(history + path.sep))
      throw Error("A history file is outside the account's folder.");
  // A thread another conversation also shows stays with it.
  const others = ctx.store.conversations.filter(
    (c) => c.id !== conversation.id,
  );
  const sharedThreads = new Set(others.flatMap(conversationThreads));
  const own = rollouts.filter(
    (file) => !sharedThreads.has(rolloutThread(file) ?? ""),
  );
  // Moved aside first: a file another program has open stops the whole
  // conversation, and the ones already moved go back.
  const moved: string[] = [];
  try {
    for (const file of own) {
      await fs.rename(file, `${file}.deleting`);
      moved.push(file);
    }
  } catch (error) {
    for (const file of moved)
      await fs.rename(`${file}.deleting`, file).catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw Error("A history file changed while deleting.");
    throw Error(
      `${inUseCodes.has(code ?? "") ? `${inUseMarker} ` : ""}${(error as Error).message}`,
    );
  }
  for (const file of moved) await fs.rm(`${file}.deleting`, { force: true });
  const threads = [
    conversation.threadId,
    ...(conversation.savedBranches ?? []).map((branch) => branch.threadId),
  ].filter(
    (id): id is string =>
      typeof id === "string" && !!id && !sharedThreads.has(id.toLowerCase()),
  );
  if (ctx.rpc)
    for (const threadId of new Set(threads)) {
      // Unloaded if it was loaded, and recorded as gone (its file is).
      await ctx.rpc.call("thread/unsubscribe", { threadId }).catch(() => {});
      await ctx.rpc.call("thread/archive", { threadId }).catch(() => {});
    }
  await ctx.closeTerminals?.(conversation.id);
  ctx.store.conversations = ctx.store.conversations.filter(
    (c) => c.id !== conversation.id,
  );
  ctx.store.flush();
  const stillUsed = new Set(
    ctx.store.conversations.flatMap((c) =>
      conversationAttachments(ctx.root, c),
    ),
  );
  const attachments = path.resolve(ctx.root, "attachments");
  for (const file of ctx.attachmentsInUse?.() ?? [])
    stillUsed.add(
      path.relative(attachments, path.resolve(file)).split(path.sep)[0],
    );
  for (const name of conversationAttachments(ctx.root, conversation))
    if (!stillUsed.has(name))
      await fs
        .rm(path.join(ctx.root, "attachments", name), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
  // The screenshot store's own folder names (computer-use/screenshots.ts).
  if (/^[A-Za-z0-9_-]{1,128}$/.test(conversation.id))
    await fs
      .rm(path.join(screenshotFolder(ctx.root), conversation.id), {
        recursive: true,
        force: true,
      })
      .catch(() => {});
  await ctx.forget?.(conversation.id);
}
