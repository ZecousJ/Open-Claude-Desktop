import { type Git } from "./code-worktree";
import type { DynamicToolResult } from "../engine/engine-extensions";
import fs from "node:fs";
import type { Conversation } from "../../shared/types";
import { discardSessionWorktree, worktreeChanges } from "./code-worktree";
import {
  syncBaseNamespace,
  setupQuestionServer,
} from "../../shared/sync-base-branch";

/** What the host tools that touch other sessions need from the app. */
export interface HostToolsDeps {
  /** The account's conversations now. */
  conversations(): Conversation[];
  /** Asks the person in the conversation (an approval card); the answer. */
  ask(
    conversationId: string,
    params: Record<string, unknown>,
  ): Promise<{ action?: string; content?: unknown } | undefined>;
}

/** A local Code session whose worktree folder is still on disk. */
const onDisk = (c: Conversation) =>
  c.mode === "code" &&
  !!c.worktree &&
  (!c.environment || c.environment.kind === "local") &&
  fs.existsSync(c.worktree.path);

export const askOnce = (message: string) => ({
  serverName: syncBaseNamespace,
  mode: "form",
  message,
  requestedSchema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["once"], enumNames: ["Allow"] },
    },
    required: ["decision"],
  },
});

export const validSetupBranch = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name) &&
  !name.includes("..") &&
  name
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        !part.startsWith(".") &&
        !part.endsWith(".") &&
        !part.endsWith(".lock"),
    );

export const setupQuestion = (suggested: string) => ({
  serverName: setupQuestionServer,
  mode: "form",
  message: "Work on a separate branch?",
  setupQuestion: "branch",
  suggested,
});

/**
 * discard_kept_worktree: an archived session's worktree left on disk with its
 * uncommitted work is deleted after the person allows it; the branch stays.
 */
export async function discardKeptWorktree(
  deps: HostToolsDeps,
  from: string,
  sessionId: string,
  git: Git,
): Promise<DynamicToolResult> {
  const target = deps.conversations().find((c) => c.id === sessionId);
  if (!target || !target.archived || !onDisk(target))
    return result(
      "That session has no kept worktree: it isn't archived, or its worktree is already gone.",
      false,
    );
  const changes = await worktreeChanges(target.worktree!, git);
  const detail =
    typeof changes === "number" && changes > 0
      ? `Deletes the worktree this archived session left on disk and discards ${changes === 1 ? "1 uncommitted change" : `${changes} uncommitted changes`}.`
      : "Deletes the worktree this archived session left on disk and discards what is uncommitted in it.";
  const reply = await deps.ask(
    from,
    askOnce(
      `Allow Claudex to discard the kept worktree of “${target.title}”?\n${detail} The branch stays.`,
    ),
  );
  if (reply?.action !== "accept")
    return result("The user didn't allow discarding the worktree.", false);
  await discardSessionWorktree(target.worktree!, git);
  return result(
    `Discarded the worktree of “${target.title}” (${target.worktree!.path}). Its branch ${target.worktree!.branch} stays.`,
    true,
  );
}

/**
 * clean_up_worktrees: removes the worktrees of Code sessions inactive for at
 * least `days` days (not running, not this session), discarding uncommitted
 * work in them, after the person allows it.
 */
export async function cleanUpWorktrees(
  deps: HostToolsDeps,
  from: string,
  days: number,
  git: Git,
  now = Date.now(),
): Promise<DynamicToolResult> {
  const cutoff = now - days * 864e5;
  const stale = deps
    .conversations()
    .filter(
      (c) =>
        c.id !== from &&
        onDisk(c) &&
        c.updatedAt < cutoff &&
        !c.turns.some((t) => t.status === "inProgress"),
    );
  if (!stale.length)
    return result(
      `No Code session inactive for ${days} days has a worktree on disk.`,
      true,
    );
  const reply = await deps.ask(
    from,
    askOnce(
      `Allow Claudex to remove the worktrees of Code sessions inactive for ${days} days?\nRemoves ${stale.length === 1 ? "1 worktree" : `${stale.length} worktrees`}; uncommitted work in them is discarded. Their branches and the sessions stay.`,
    ),
  );
  if (reply?.action !== "accept")
    return result("The user didn't allow the cleanup.", false);
  const failed: string[] = [];
  for (const c of stale)
    try {
      await discardSessionWorktree(c.worktree!, git);
    } catch {
      failed.push(c.title);
    }
  return result(
    `Removed ${stale.length - failed.length} of ${stale.length} worktrees.${failed.length ? ` Couldn't remove: ${failed.join(", ")}.` : ""}`,
    failed.length === 0,
  );
}

export const result = (text: string, success: boolean): DynamicToolResult => ({
  contentItems: [{ type: "inputText", text }],
  success,
});
