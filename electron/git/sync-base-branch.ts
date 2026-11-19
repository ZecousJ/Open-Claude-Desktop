import type { AppContext } from "../app/app-context";
import { localGit, type Git } from "./code-worktree";
import type {
  DynamicToolCall,
  EngineExtension,
} from "../engine/engine-extensions";
import fs from "node:fs";
import path from "node:path";
import type {
  Conversation,
  SessionPullRequest,
  SessionWorktree,
} from "../../shared/types";
import { validRepositoryName } from "../../shared/github-parse";
import {
  parsePullRequestUrl,
  sessionPullRequest,
  type PullRequestRef,
} from "../../shared/pull-request";
import {
  bindPrTool,
  prMonitorQuestion,
  setPrMonitorTool,
  unbindPrTool,
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
import { githubRepositoryName } from "./git-branch";
import { getPullRequest, runGh, type GhRunner } from "./github-cli";

/**
 * Merge the base branch into a worktree session's branch (live claude.ai
 * bundle, 2026-10-15: the host tool sync_with_base_branch, rows "Merged base
 * branch", "Merge left conflicts to resolve", "Branch already up to date",
 * "Abandoned merge", "No merge to abandon"). The base is the repository's
 * default branch on origin when it has one (fetched first), else the branch
 * the main checkout is on. Conflicts stay in the worktree for Claude to
 * resolve; `abort` abandons a merge in progress.
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

const localCode = (c: Conversation) =>
  c.mode === "code" &&
  !c.cloudHosted &&
  !c.cloudEnvironmentId &&
  !c.linkedToComputer &&
  (!c.environment || c.environment.kind === "local");

const canChangePr = (c: Conversation) =>
  localCode(c) &&
  !c.incognito &&
  !c.archived &&
  c.worktree?.state !== "deleted";

const prChangeCurrent = (call: DynamicToolCall, deps: HostToolsDeps) => {
  const c = call.conversation;
  const previous = c.pullRequests;
  return () =>
    canChangePr(c) &&
    deps.conversations().includes(c) &&
    (!call.turn || call.turn.status === "inProgress") &&
    c.pullRequests === previous;
};

function githubPullRequestRef(url: unknown) {
  if (typeof url !== "string") return undefined;
  const ref = parsePullRequestUrl(url);
  return ref?.host === "github.com" &&
    validRepositoryName(ref.repository) &&
    Number.isSafeInteger(ref.number) &&
    ref.number > 0 &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/i.test(ref.url)
    ? ref
    : undefined;
}

const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

const samePullRequest = (a: PullRequestRef, b: PullRequestRef) =>
  a.host === b.host &&
  a.number === b.number &&
  sameRepository(a.repository, b.repository);

const isOpenPr = (pr: Pick<SessionPullRequest, "state">) =>
  pr.state !== "merged" && pr.state !== "closed";

const bindingMatches = (
  binding: SessionPullRequest,
  target: PullRequestRef,
) => {
  const ref = githubPullRequestRef(binding.url);
  return !!ref && samePullRequest(ref, target);
};

async function repoHeldBySessions(
  c: Conversation,
  repository: string,
  sessions: Conversation[],
  git: Git,
) {
  if (
    sessions.some(
      (session) =>
        localCode(session) &&
        !session.incognito &&
        session.pullRequests?.some(
          (row) =>
            githubPullRequestRef(row.url) &&
            sameRepository(row.repository, repository),
        ),
    )
  )
    return true;
  const folders = new Set([
    c.worktree?.path ?? c.cwd,
    ...(c.additionalFolders ?? []),
    ...(c.additionalWorktrees ?? []).flatMap((tree) =>
      tree.folders.map((folder) => folder.cwd),
    ),
  ]);
  const origins = await Promise.all(
    [...folders].flatMap((cwd) =>
      cwd ? [quiet(git, cwd, ["remote", "get-url", "origin"])] : [],
    ),
  );
  return origins.some((origin) => {
    const name = origin && githubRepositoryName(origin);
    return !!name && sameRepository(name, repository);
  });
}

const prUrlField = {
  type: "string",
  description:
    "The pull request URL, e.g. https://github.com/owner/repo/pull/123.",
};

const prUrlInput = {
  type: "object",
  properties: { url: prUrlField },
  required: ["url"],
  additionalProperties: false,
};

async function changePrBinding(
  call: DynamicToolCall,
  url: unknown,
  deps: HostToolsDeps,
  git: Git,
  run: GhRunner,
) {
  const c = call.conversation;
  const previous = c.pullRequests ?? [];
  const current = prChangeCurrent(call, deps);
  const unavailable =
    "The Code session or its pull requests changed. Try again.";
  if (!current()) return result(unavailable, false);
  const target = githubPullRequestRef(url);
  if (!target) return result("Pass a github.com pull request URL.", false);
  const binding = previous.find((row) => bindingMatches(row, target));
  const name = `${target.repository}#${target.number}`;
  if (call.tool === unbindPrTool) {
    if (!binding || binding.dismissed)
      return result(`${name} is not bound to this session.`, false);
    const reply = await deps.ask(
      c.id,
      askOnce(`Dismiss ${name} from this session's pull requests?`),
    );
    if (reply?.action !== "accept")
      return result("The user didn't allow the change.", false);
    if (!current()) return result(unavailable, false);
    c.pullRequests = previous.map((row) =>
      row === binding ? { ...row, dismissed: true } : row,
    );
    call.changed();
    return result(
      `Dismissed ${name}. The app will stop watching it in this session. Use bind_pr to restore it.`,
      true,
    );
  }
  if (
    !(await repoHeldBySessions(c, target.repository, deps.conversations(), git))
  )
    return result(
      `${target.repository} must be the origin of a checkout in this session or have a pull request already bound in your sessions.`,
      false,
    );
  if (!current()) return result(unavailable, false);
  if (binding && !binding.dismissed)
    return result(`${name} is already bound to this session.`, true);

  const { pullRequest } = await getPullRequest(
    target.repository,
    target.number,
    (args, limit) => run([...args, "--hostname", "github.com"], limit),
  );
  const verified = githubPullRequestRef(pullRequest?.url);
  if (!current()) return result(unavailable, false);
  if (
    !pullRequest ||
    !verified ||
    !samePullRequest(verified, target) ||
    pullRequest.number !== target.number ||
    !pullRequest.headRef ||
    (pullRequest.state !== "open" && pullRequest.state !== "draft")
  )
    return result(
      `Could not read ${name} as an open pull request with the local GitHub sign-in.`,
      false,
    );

  const action = binding?.dismissed ? "Restore" : "Bind";
  const reply = await deps.ask(
    c.id,
    askOnce(`${action} ${name} in this session's pull requests?`),
  );
  if (reply?.action !== "accept")
    return result("The user didn't allow the change.", false);
  if (!current()) return result(unavailable, false);
  const next: SessionPullRequest = {
    ...binding,
    repository: verified.repository,
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequest.title,
    headRef: pullRequest.headRef,
    headRepository: pullRequest.headRepository,
    baseRef: pullRequest.baseRef,
    own: pullRequest.viewerIsAuthor,
    createdAt: pullRequest.createdAt,
    state: pullRequest.state,
    checkedAt: Date.now(),
    ...(binding && {
      dismissed: false,
      autoFix: { ...binding.autoFix, ci: false, comments: false },
    }),
  };
  c.pullRequests = binding
    ? previous.map((row) => (row === binding ? next : row))
    : [...previous, next];
  call.changed();
  return result(
    `${binding ? "Restored" : "Bound"} ${name} to this session.`,
    true,
  );
}

export function syncBaseExtension(
  git: Git = localGit,
  deps?: HostToolsDeps,
  run: GhRunner = runGh,
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
                url: prUrlField,
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
      if (deps && canChangePr(ctx.conversation))
        tools.push(
          {
            type: "function",
            name: bindPrTool,
            description:
              "Bind an open github.com pull request to this session by URL or restore a dismissed one. Its repository must be this session's checkout origin or already have a pull request bound in your sessions. Asks the user first.",
            inputSchema: prUrlInput,
          },
          {
            type: "function",
            name: unbindPrTool,
            description:
              "Dismiss a bound pull request by URL and stop monitoring it in this session. Asks the user first.",
            inputSchema: prUrlInput,
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
      if (deps && (call.tool === bindPrTool || call.tool === unbindPrTool))
        return changePrBinding(call, args0.url, deps, git, run);
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
        const c = call.conversation;
        const previous = c.pullRequests ?? [];
        const current = prChangeCurrent(call, deps);
        if (!current())
          return result("The Code session is no longer available.", false);
        const legacy = sessionPullRequest(c);
        const target =
          args0.url === undefined ? legacy : githubPullRequestRef(args0.url);
        if (args0.url !== undefined && !target)
          return result("Pass a github.com pull request URL.", false);
        const selected =
          target && previous.find((row) => bindingMatches(row, target));
        const visible = previous.filter(
          (row) => !row.dismissed && githubPullRequestRef(row.url),
        );
        const binding =
          selected ??
          (args0.url === undefined
            ? (visible.filter(isOpenPr).at(-1) ?? visible.at(-1))
            : undefined);
        const legacyMatches =
          legacy && target && samePullRequest(legacy, target);
        const pr =
          binding ?? (!previous.length && legacyMatches ? legacy : undefined);
        if (!pr || binding?.dismissed)
          return result(
            "No matching pull request is bound to this session.",
            false,
          );
        const autoFix =
          typeof args0.auto_fix === "boolean" ? args0.auto_fix : undefined;
        const autoArchive =
          typeof args0.auto_archive === "boolean"
            ? args0.auto_archive
            : undefined;
        if (autoFix === undefined && autoArchive === undefined)
          return result("Pass auto_fix, auto_archive or both.", false);
        const taggedBinding =
          binding && legacy && bindingMatches(binding, legacy);
        const watch =
          binding?.autoFix ?? (taggedBinding ? c.prAutoFix : undefined);
        const openedHere =
          binding?.own && (binding.openedBySession || taggedBinding);
        if (
          autoFix &&
          binding &&
          (!isOpenPr(binding) || (!watch?.ci && !openedHere))
        )
          return result(
            "Auto-fix can only be enabled here for an open pull request this session opened.",
            false,
          );
        const reply = await deps.ask(
          c.id,
          askOnce(prMonitorQuestion(pr.number, { autoFix, autoArchive })),
        );
        if (reply?.action !== "accept")
          return result("The user didn't allow the change.", false);
        if (!current())
          return result(
            "The Code session or its pull requests changed. Try again.",
            false,
          );
        if (autoFix !== undefined) {
          if (binding) {
            c.pullRequests = previous.map((row) =>
              row === binding
                ? {
                    ...row,
                    autoFix: { ...watch, ci: autoFix, comments: autoFix },
                  }
                : row,
            );
          } else {
            c.prAutoFix = { ...c.prAutoFix, ci: autoFix, comments: autoFix };
          }
        }
        if (autoArchive !== undefined) {
          c.prAutoArchive = autoArchive;
          if (autoArchive) delete c.codeAutoArchiveExempt;
        }
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
    | "engine"
    | "onAccountActivated"
    | "onAccountDeactivating"
    | "store"
    | "accountActivationIdentity"
    | "accountRetiring"
  >,
) {
  let remove: (() => void) | undefined;
  ctx.onAccountActivated?.((account) => {
    remove?.();
    const { store, engine, accountActivationIdentity } = ctx;
    const current = () =>
      !ctx.accountRetiring &&
      ctx.accountActivationIdentity === accountActivationIdentity;
    remove = engine.extensions.has(syncBaseExtensionId)
      ? undefined
      : engine.extensions.add(
          syncBaseExtension(localGit, {
            conversations: () =>
              current()
                ? store.conversations.filter(
                    (c) =>
                      !c.sessionAuthors ||
                      (c.sessionAuthors.ownerAccountUuid === account.id &&
                        c.sessionAuthors.viewerAccountUuid === account.id),
                  )
                : [],
            ask: async (id, params) =>
              current() ? engine.requestAppApproval(id, params) : undefined,
          }),
        );
  });
  ctx.onAccountDeactivating?.(() => {
    remove?.();
    remove = undefined;
  });
}
