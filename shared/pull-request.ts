/**
 * Pull requests of a Code session. The row's Create PR does not call GitHub
 * itself: for a session that works in a folder it sends Claude a prompt wrapped
 * in `<create-pr-command>` (shown in the transcript as `/create-pr`), and
 * Claude commits, pushes and opens the pull request, then names its address in
 * a `<pr-created>` tag. The row binds to that address and reads the request's
 * state from GitHub (shared/github-api.ts).
 *
 * These are pure helpers shared by the window and the main process: the prompts
 * and finding the pull request a session made. How the transcript shows them is
 * shared/pr-display.ts.
 */
import type { Conversation } from "./types";

export const createPrTag = "create-pr-command";
const createPrOpen = `<${createPrTag}>`;
const createPrClose = `</${createPrTag}>`;

/** What the prompt of Create PR needs to know about the session's branch. */
export interface CreatePrTarget {
  /** "owner/name"; empty when the folder has no GitHub remote. */
  repository?: string;
  branch: string;
  baseBranch?: string;
  cwd?: string;
  draft?: boolean;
  /**
   * The session works in a cloud sandbox that cannot reach GitHub itself:
   * Claude pushes and opens the request with its GitHub tools instead of
   * `git push` and `gh`.
   */
  cloud?: boolean;
}

/** A base branch worth naming: another branch with a plain name. */
export function usableBaseBranch(
  target: Pick<CreatePrTarget, "baseBranch" | "branch">,
) {
  const base = target.baseBranch;
  return base && base !== target.branch && /^[\w./-]+$/.test(base)
    ? base
    : undefined;
}

const readyStep =
  "Open the PR with `gh pr create`. Do not pass `--draft`: the user chose “Create PR”, not “Create draft PR”, for this request, and that explicit choice overrides any saved memory, standing instruction, or earlier plan to open it as a draft.";
const draftStep =
  "Open the PR as a draft with `gh pr create --draft`. The user chose “Create draft PR” for this request, so keep `--draft` even if you would otherwise open it ready for review.";
const cloudReadyStep =
  "Open the PR with the github create_pull_request tool, with `draft` false: the user chose “Create PR”, not “Create draft PR”, for this request.";
const cloudDraftStep =
  "Open the PR with the github create_pull_request tool, with `draft` true: the user chose “Create draft PR” for this request, so keep it a draft.";

/** The message Create PR sends. */
export function createPrPrompt(target: CreatePrTarget) {
  const kind = target.draft ? "as a draft" : "ready for review (not a draft)";
  const open = target.cloud
    ? target.draft
      ? cloudDraftStep
      : cloudReadyStep
    : target.draft
      ? draftStep
      : readyStep;
  const push = target.cloud
    ? "Push the branch with the github push tool."
    : "Push the branch to the remote.";
  const base = usableBaseBranch(target);
  const lines = [
    "## Overview",
    "",
    `Create a pull request for the changes in this session, ${kind}.`,
    "",
    "## Steps",
    "",
    "1. Check for uncommitted changes. If any exist, stage and commit them with a message that describes what changed and why.",
    `2. ${push}`,
    `3. ${open} ${
      target.cloud
        ? "When the target below names a base branch, pass it as `base`; otherwise leave `base` off."
        : "When the target below names a base branch and that branch exists on origin (`git ls-remote --heads origin <base>`), pass it with `--base`; otherwise leave `--base` off and let gh infer it."
    } Write a title that summarizes the change and a body that covers what changed, why, and anything a reviewer should know. If the repo has a PR template, follow it.`,
    "4. Report the PR URL when done. Wrap the URL in a `<pr-created>` tag on its own line so the UI can render a live status card, like this: `<pr-created>https://github.com/owner/repo/pull/123</pr-created>`",
    "",
    "If a PR already exists for this branch, push any new commits and report the existing URL wrapped in the same `<pr-created>` tag instead of creating a duplicate, and leave that PR's draft or ready state as it is.",
    "",
    "## Target",
    "",
    ...(target.repository ? [`Repository: ${target.repository}`] : []),
    `Branch: ${target.branch}`,
    ...(base ? [`Base branch: ${base}`] : []),
    ...(target.cwd && !target.cloud
      ? [`Working directory: ${target.cwd}`]
      : []),
  ];
  return `${createPrOpen}\n${lines.join("\n")}\n${createPrClose}`;
}

/** Commit changes (a folder without a GitHub remote): a plain message. */
export const commitPrompt =
  "Commit the working tree changes with a sensible message.";

const prCreated = /<pr-created>\s*(https?:\/\/[^\s<]+?)\s*<\/pr-created>/gi;

/** A pull request address on a host. */
export interface PullRequestRef {
  url: string;
  host: string;
  /** "owner/name" */
  repository: string;
  number: number;
}

const pullAddress = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;

export function parsePullRequestUrl(url: string): PullRequestRef | undefined {
  const match = pullAddress.exec(url.trim());
  if (!match) return undefined;
  return {
    url: url.trim(),
    host: match[1].toLowerCase(),
    repository: `${match[2]}/${match[3]}`,
    number: Number(match[4]),
  };
}

/** The pull requests a reply tagged with `<pr-created>`, in order. */
export function taggedPullRequests(text: string): PullRequestRef[] {
  if (!text.includes("<pr-created>")) return [];
  const found: PullRequestRef[] = [];
  for (const match of text.matchAll(prCreated)) {
    const ref = parsePullRequestUrl(match[1]);
    if (ref) found.push(ref);
  }
  return found;
}

const bareGithubPull =
  /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+(?![\w/#])/g;

/** The pull requests a reply names: tagged ones, else github.com links. */
export function pullRequestsIn(text: string): PullRequestRef[] {
  const found: PullRequestRef[] = [];
  for (const match of text.matchAll(prCreated)) {
    const ref = parsePullRequestUrl(match[1]);
    if (ref) found.push(ref);
  }
  if (!found.length) {
    const seen = new Set<string>();
    for (const match of text.matchAll(bareGithubPull)) {
      if (seen.has(match[0])) continue;
      seen.add(match[0]);
      const ref = parsePullRequestUrl(match[0]);
      if (ref) found.push(ref);
    }
  }
  return found;
}

/**
 * The pull request the session most recently made: the last one a reply of
 * Claude's tagged with `<pr-created>`. Plain links are not taken as the
 * session's own (a reply may mention any pull request).
 */
export function sessionPullRequest(
  conversation: Pick<Conversation, "turns">,
): PullRequestRef | undefined {
  for (let t = conversation.turns.length - 1; t >= 0; t--) {
    const items = conversation.turns[t].items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== "agentMessage" || !item.text) continue;
      const tagged = [...item.text.matchAll(prCreated)];
      for (let k = tagged.length - 1; k >= 0; k--) {
        const ref = parsePullRequestUrl(tagged[k][1]);
        if (ref) return ref;
      }
    }
  }
  return undefined;
}

/**
 * Every pull request the session made (each `<pr-created>` tag of Claude's
 * replies), newest first, each once.
 */
export function sessionPullRequests(
  conversation: Pick<Conversation, "turns">,
): PullRequestRef[] {
  const found: PullRequestRef[] = [];
  const seen = new Set<string>();
  for (let t = conversation.turns.length - 1; t >= 0; t--) {
    const items = conversation.turns[t].items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== "agentMessage" || !item.text) continue;
      const tagged = [...item.text.matchAll(prCreated)];
      for (let k = tagged.length - 1; k >= 0; k--) {
        const ref = parsePullRequestUrl(tagged[k][1]);
        const key = ref && `${ref.repository.toLowerCase()}#${ref.number}`;
        if (ref && key && !seen.has(key)) {
          seen.add(key);
          found.push(ref);
        }
      }
    }
  }
  return found;
}

/**
 * GitHub's compare page for a branch (Manually create PR): the pull
 * request's form opens there, filled with the commits.
 */
export function compareUrl(input: {
  repository: string;
  branch: string;
  baseBranch?: string;
}) {
  const [owner, name] = input.repository.split("/");
  if (!owner || !name) return undefined;
  const part = (value: string) =>
    value.split("/").map(encodeURIComponent).join("/");
  const base = usableBaseBranch(input);
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${
    base ? `${part(base)}...` : ""
  }${part(input.branch)}?expand=1`;
}
