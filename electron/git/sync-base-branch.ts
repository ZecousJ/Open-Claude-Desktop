import type { AppContext } from "../app/app-context";
import { localGit, type Git } from "./code-worktree";
import type { EngineExtension } from "../engine/engine-extensions";
import fs from "node:fs";
import path from "node:path";
import type { SessionWorktree } from "../../shared/types";
import { sessionPullRequest } from "../../shared/pull-request";
import {
  prMonitorQuestion,
  setPrMonitorTool,
  cleanUpWorktreesTool,
  discardKeptWorktreeTool,
  syncBaseNamespace,
  syncBaseTool,
  setupQuestionTool,
  type SyncBaseOutcome,
} from "../../shared/sync-base-branch";
import {
  type HostToolsDeps,
  askOnce,
  validSetupBranch,
  setupQuestion,
  discardKeptWorktree,
  cleanUpWorktrees,
} from "./worktree-tools";
import { result } from "./worktree-tools";

/**
 * Merge the base branch into a worktree session's branch. The base is the
 * repository's default branch on origin when it has one (fetched first), else
 * the branch the main checkout is on. Conflicts stay in the worktree for Claude
 * to resolve; `abort` abandons a merge in progress.
 */

export const syncBaseExtensionId = "sync-base-branch";

const validBranch = (name: string) =>
  /^[A-Za-z0-9._/-]{1,255}$/.test(name) &&
  !name.startsWith("-") &&
  !name.includes("..");

const lastLine = (error: unknown) =>
  String(
    (error as { stderr?: string })?.stderr ||
      (error as Error)?.message ||
      "git failed",
  )
    .trim()
    .split("\n")
    .at(-1);

async function quiet(git: Git, cwd: string, args: string[]) {
  try {
    return (await git(cwd, args)).trim();
  } catch {
    return undefined;
  }
}

/** The base: origin's default branch, else the main checkout's branch. */
async function baseOf(worktree: SessionWorktree, asked: string, git: Git) {
  const cwd = worktree.path;
  const remote = await quiet(git, cwd, ["remote"]);
  const hasOrigin = remote?.split("\n").includes("origin") ?? false;
  if (asked) {
    if (!validBranch(asked)) throw new Error("That branch name isn't valid.");
    return {
      name: asked,
      ref: hasOrigin ? `origin/${asked}` : asked,
      origin: hasOrigin,
    };
  }
  const head = await quiet(git, cwd, [
    "rev-parse",
    "--abbrev-ref",
    "origin/HEAD",
  ]);
  if (hasOrigin && head?.startsWith("origin/") && head !== "origin/HEAD")
    return { name: head.slice("origin/".length), ref: head, origin: true };
  const main = await quiet(git, worktree.repository, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (main && main !== "HEAD" && main !== worktree.branch)
    return { name: main, ref: main, origin: false };
  throw new Error(
    "This session's base branch can't be found. Name it with `base`.",
  );
}

const merging = async (git: Git, cwd: string) =>
  (await quiet(git, cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) !==
  undefined;

const conflicted = async (git: Git, cwd: string) =>
  ((await quiet(git, cwd, ["diff", "--name-only", "--diff-filter=U"])) ?? "")
    .split("\n")
    .filter(Boolean);

export async function syncWithBaseBranch(
  worktree: SessionWorktree,
  {
    action = "merge",
    base = "",
  }: { action?: "merge" | "abort"; base?: string } = {},
  git: Git = localGit,
): Promise<SyncBaseOutcome> {
  const cwd = worktree.path;
  if (action === "abort") {
    if (!(await merging(git, cwd))) return { outcome: "nothing_in_progress" };
    await git(cwd, ["merge", "--abort"]);
    return { outcome: "aborted" };
  }
  const target = await baseOf(worktree, base.trim(), git);
  // Never over uncommitted work (the original refuses too).
  if (
    !(await merging(git, cwd)) &&
    ((await quiet(git, cwd, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ])) ?? "") !== ""
  )
    throw new Error(
      "This session's worktree has uncommitted changes. Commit or stash them, then merge the base branch.",
    );
  if (await merging(git, cwd))
    return {
      outcome: "conflicts",
      base: target.name,
      conflicts: await conflicted(git, cwd),
    };
  if (target.origin)
    try {
      await git(
        cwd,
        ["fetch", "--quiet", "--no-tags", "origin", target.name],
        120_000,
      );
    } catch (error) {
      // Offline: the last fetched base is merged.
      console.warn(
        "claudex: fetch before syncing base failed:",
        lastLine(error),
      );
    }
  if (
    (await quiet(git, cwd, [
      "merge-base",
      "--is-ancestor",
      target.ref,
      "HEAD",
    ])) !== undefined
  )
    return { outcome: "up_to_date", base: target.name };
  try {
    await git(cwd, ["merge", "--no-edit", target.ref], 120_000);
    return { outcome: "merged", base: target.name };
  } catch (error) {
    const files = await conflicted(git, cwd);
    if (files.length)
      return { outcome: "conflicts", base: target.name, conflicts: files };
    throw new Error(`Couldn't merge ${target.name}: ${lastLine(error)}`);
  }
}

export function syncBaseExtension(
  git: Git = localGit,
  deps?: HostToolsDeps,
): EngineExtension {
  return {
    id: syncBaseExtensionId,
    dynamicTools(ctx) {
      if (ctx.mode !== "code") return undefined;
      const local =
        !ctx.conversation.environment ||
        ctx.conversation.environment.kind === "local";
      const repo =
        !!ctx.conversation.cwd &&
        fs.existsSync(path.join(ctx.conversation.cwd, ".git"));
      const setup =
        deps &&
        local &&
        repo &&
        !ctx.conversation.worktree &&
        !ctx.conversation.threadId;
      const tools: {
        type: "function";
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }[] = [];
      if (deps && local)
        tools.push(
          ...(setup
            ? [
                {
                  type: "function" as const,
                  name: setupQuestionTool,
                  description:
                    "Before changing files in a Git repository, ask whether to create a separate branch or stay on the current branch.",
                  inputSchema: {
                    type: "object",
                    properties: { suggested: { type: "string" } },
                    additionalProperties: false,
                  },
                },
              ]
            : []),
          {
            type: "function",
            name: setPrMonitorTool,
            description:
              "Turns auto-fix (Claude fixes failing checks and answers review comments on this session's pull request) and auto-archive (the session is archived once the pull request merges or closes) on or off for this session's pull request. Asks the user first.",
            inputSchema: {
              type: "object",
              properties: {
                auto_fix: { type: "boolean" },
                auto_archive: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
          {
            type: "function",
            name: discardKeptWorktreeTool,
            description:
              "Deletes the worktree an archived Code session left on disk (it had uncommitted changes when it was archived), discarding those changes; its branch stays. Asks the user first.",
            inputSchema: {
              type: "object",
              properties: {
                session_id: {
                  type: "string",
                  description: "The archived session's id",
                },
              },
              required: ["session_id"],
              additionalProperties: false,
            },
          },
          {
            type: "function",
            name: cleanUpWorktreesTool,
            description:
              "Removes the worktrees of Code sessions on this computer inactive for at least `days` days (default 30), discarding uncommitted work in them; the sessions and their branches stay. Asks the user first.",
            inputSchema: {
              type: "object",
              properties: {
                days: {
                  type: "number",
                  minimum: 1,
                  description: "Inactive for at least this many days",
                },
              },
              additionalProperties: false,
            },
          },
        );
      if (!ctx.conversation.worktree && !tools.length) return undefined;
      return [
        {
          type: "namespace",
          name: syncBaseNamespace,
          description: "Tools of the Claudex app on this computer.",
          tools: [
            ...tools,
            ...(ctx.conversation.worktree
              ? [
                  {
                    type: "function" as const,
                    name: syncBaseTool,
                    description:
                      "Fetches the base branch from origin (origin's default branch, or the branch the main checkout is on when there is no origin) and merges it into this session's branch, in its worktree on this computer. Refuses over uncommitted changes. Conflicts are left in the worktree to resolve and commit. With abort=true, abandons the merge in progress and puts the branch back as it was. Nothing is pushed.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        abort: { type: "boolean" },
                        base: {
                          type: "string",
                          description: "Another base branch to merge",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                ]
              : []),
          ],
        },
      ];
    },
    async handleDynamicTool(call) {
      if (call.namespace !== syncBaseNamespace) return undefined;
      const args0 = (call.arguments ?? {}) as Record<string, unknown>;
      if (call.tool === setupQuestionTool && deps) {
        const suggested =
          typeof args0.suggested === "string" &&
          validSetupBranch(args0.suggested)
            ? args0.suggested
            : "claude/changes";
        const reply = await deps.ask(
          call.conversation.id,
          setupQuestion(suggested),
        );
        if (reply?.action !== "accept")
          return result("The user didn't choose a branch.", false);
        const content = reply.content as
          { branch?: { choice?: unknown; name?: unknown } } | undefined;
        const branch = content?.branch;
        if (branch?.choice === "stay") {
          call.changed();
          return result(JSON.stringify({ choice: "stay" }), true);
        }
        if (
          branch?.choice !== "new" ||
          typeof branch.name !== "string" ||
          !validSetupBranch(branch.name)
        )
          return result("That branch name isn't valid.", false);
        // Only in the session's own folder, never wherever the app runs from.
        const cwd = call.conversation.cwd;
        if (!cwd)
          return result(
            "This session has no folder to make a branch in.",
            false,
          );
        try {
          await git(cwd, ["switch", "-c", branch.name]);
          call.changed();
          return result(
            JSON.stringify({ choice: "new", name: branch.name }),
            true,
          );
        } catch (error) {
          return result(
            lastLine(error) || "Couldn't create that branch.",
            false,
          );
        }
      }
      if (call.tool === discardKeptWorktreeTool && deps) {
        if (typeof args0.session_id !== "string")
          return result("'session_id' is required.", false);
        try {
          return await discardKeptWorktree(
            deps,
            call.conversation.id,
            args0.session_id,
            git,
          );
        } catch (error) {
          return result(
            (error as Error).message || "Couldn't discard the worktree.",
            false,
          );
        }
      }
      if (call.tool === setPrMonitorTool && deps) {
        const pr = sessionPullRequest(call.conversation);
        if (!pr)
          return result("This session hasn't opened a pull request.", false);
        const autoFix =
          typeof args0.auto_fix === "boolean" ? args0.auto_fix : undefined;
        const autoArchive =
          typeof args0.auto_archive === "boolean"
            ? args0.auto_archive
            : undefined;
        if (autoFix === undefined && autoArchive === undefined)
          return result("Pass auto_fix, auto_archive or both.", false);
        const reply = await deps.ask(
          call.conversation.id,
          askOnce(prMonitorQuestion(pr.number, { autoFix, autoArchive })),
        );
        if (reply?.action !== "accept")
          return result("The user didn't allow the change.", false);
        if (autoFix !== undefined)
          call.conversation.prAutoFix = {
            ...(call.conversation.prAutoFix ?? {}),
            ci: autoFix,
            comments: autoFix,
          };
        if (autoArchive !== undefined)
          call.conversation.prAutoArchive = autoArchive;
        call.changed();
        return result(
          `Done: ${[
            autoFix !== undefined ? `auto-fix ${autoFix ? "on" : "off"}` : "",
            autoArchive !== undefined
              ? `auto-archive ${autoArchive ? "on" : "off"}`
              : "",
          ]
            .filter(Boolean)
            .join(", ")} for pull request #${pr.number}.`,
          true,
        );
      }
      if (call.tool === cleanUpWorktreesTool && deps) {
        const days =
          typeof args0.days === "number" &&
          Number.isFinite(args0.days) &&
          args0.days >= 1
            ? Math.floor(args0.days)
            : 30;
        try {
          return await cleanUpWorktrees(deps, call.conversation.id, days, git);
        } catch (error) {
          return result(
            (error as Error).message || "Couldn't clean up the worktrees.",
            false,
          );
        }
      }
      if (call.tool !== syncBaseTool) return undefined;
      const worktree = call.conversation.worktree;
      if (!worktree)
        return result("This session doesn't work in its own worktree.", false);
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      try {
        const outcome = await syncWithBaseBranch(
          worktree,
          {
            action: args.abort === true ? "abort" : "merge",
            base: typeof args.base === "string" ? args.base : "",
          },
          git,
        );
        call.changed();
        return result(JSON.stringify(outcome), true);
      } catch (error) {
        return result(
          (error as Error).message || "Couldn't sync the base branch.",
          false,
        );
      }
    },
  };
}

/** Adds the tool to the account's local engine (worktree sessions are local). */
export function registerSyncBaseExtension(
  ctx: Pick<
    AppContext,
    "engine" | "onAccountActivated" | "onAccountDeactivating" | "store"
  >,
) {
  let remove: (() => void) | undefined;
  ctx.onAccountActivated?.(() => {
    remove?.();
    remove = ctx.engine.extensions.has(syncBaseExtensionId)
      ? undefined
      : ctx.engine.extensions.add(
          syncBaseExtension(localGit, {
            conversations: () => {
              try {
                return ctx.store.conversations;
              } catch {
                return [];
              }
            },
            ask: (id, params) => ctx.engine.requestAppApproval(id, params),
          }),
        );
  });
  ctx.onAccountDeactivating?.(() => {
    remove?.();
    remove = undefined;
  });
}
