import type { Conversation } from "../../shared/types";

/**
 * The Code home's Next steps. At most three rows, in the original's order; rows
 * of one kind fold into the first with "and # more". Each can be dismissed: a
 * dismissal holds until what it was about changes (its stamp), and is
 * remembered in this browser.
 */
export type NextStep =
  | {
      id: "waiting-session";
      on?: "question" | "permission";
      sessionId: string;
      title: string;
      stamp: string;
    }
  | { id: "worktree-apart"; folder: string; taken: boolean }
  | { id: "resume-session"; sessionId: string; title: string; stamp: string }
  | {
      id: "pr-ci-failed";
      /** "owner/name#number" */
      pr: string;
      branch: string;
      check?: string;
      stamp: string;
    }
  | {
      id: "pr-review-comments";
      pr: string;
      repository: string;
      number: number;
      count: number;
      title?: string;
      stamp: string;
    }
  | {
      id: "continue-branch";
      folder: string;
      branch: string;
      files: number;
    };

export const nextStepsLimit = 3;
const order: NextStep["id"][] = [
  "waiting-session",
  "worktree-apart",
  "resume-session",
  "pr-ci-failed",
  "pr-review-comments",
  "continue-branch",
];

/** What a dismissal is about: its row, its subject and when that last changed. */
export function dismissalOf(step: NextStep) {
  switch (step.id) {
    case "waiting-session":
    case "resume-session":
      return { row: step.id, subject: step.sessionId, stamp: step.stamp };
    case "worktree-apart":
      return step.taken ? null : { row: step.id, subject: step.folder };
    case "pr-ci-failed":
    case "pr-review-comments":
      return { row: step.id, subject: step.pr, stamp: step.stamp };
    case "continue-branch":
      return {
        row: step.id,
        subject: `${step.folder}\u0000${step.branch}`,
        stamp: String(step.files),
      };
  }
}

/** A short string hash (cyrb53), so the stored keys don't hold paths or titles. */
export function shortHash(text: string) {
  let a = 0xdeadbeef,
    b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a =
    Math.imul(a ^ (a >>> 16), 2246822507) ^
    Math.imul(b ^ (b >>> 13), 3266489909);
  b =
    Math.imul(b ^ (b >>> 16), 2246822507) ^
    Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

export type Dismissals = Record<string, string>;

const keyOf = (d: { row: string; subject?: string }) =>
  d.subject === undefined ? d.row : `${d.row}:${shortHash(d.subject)}`;
const stampOf = (d: { stamp?: string }) =>
  d.stamp === undefined ? "" : shortHash(d.stamp);

export function isDismissed(dismissals: Dismissals, step: NextStep) {
  const d = dismissalOf(step);
  return Boolean(d) && dismissals[keyOf(d!)] === stampOf(d!);
}

/** Records a dismissal, keeping the newest hundred. */
export function dismiss(dismissals: Dismissals, step: NextStep): Dismissals {
  const d = dismissalOf(step);
  if (!d) return dismissals;
  const key = keyOf(d);
  const rest = Object.entries(dismissals)
    .filter(([k]) => k !== key)
    .slice(-99);
  return Object.fromEntries([...rest, [key, stampOf(d)]]);
}

export interface NextStepsInput {
  folder?: string;
  /** The folder is a Git repository on this computer (Worktree can be used). */
  repository: boolean;
  worktreeOn: boolean;
  conversations: readonly Conversation[];
  /** Conversation ids with a request waiting (approvals, questions), newest last. */
  waiting: readonly {
    conversationId: string;
    id: string;
    on?: "question" | "permission";
  }[];
  branch?: { current: string | null; defaultBranch?: string | null };
  uncommittedFiles?: number;
  /** The open pull request of the folder's branch. */
  pullRequest?: {
    repository: string;
    number: number;
    title: string;
    headSha?: string;
    checks: string;
    failingCheck?: string;
    unansweredReviewThreads?: number;
    newestReviewComment?: number;
  } | null;
  now: number;
}

const running = (c: Conversation) =>
  c.turns.some((t) => t.status === "inProgress");

/** Every suggestion that applies, in the original's order. */
export function nextSteps(input: NextStepsInput): NextStep[] {
  const code = input.conversations.filter(
    (c) => c.mode === "code" && !c.archived && !c.incognito,
  );
  const steps: NextStep[] = [];
  // Sessions waiting on the person, most recent first.
  const waitingIds = new Map<
    string,
    { id: string; on?: "question" | "permission" }
  >();
  for (const request of input.waiting)
    waitingIds.set(request.conversationId, request);
  for (const c of [...code].sort((a, b) => b.updatedAt - a.updatedAt))
    if (waitingIds.has(c.id))
      steps.push({
        id: "waiting-session",
        sessionId: c.id,
        title: c.title,
        stamp: waitingIds.get(c.id)!.id,
        on: waitingIds.get(c.id)!.on,
      });
  // Another session runs in the chosen folder: keep the changes apart.
  if (
    input.folder &&
    input.repository &&
    code.some((c) => c.cwd === input.folder && running(c))
  )
    steps.push({
      id: "worktree-apart",
      folder: input.folder,
      taken: input.worktreeOn,
    });
  // The most recent session that stopped on an error (in the chosen folder).
  const failed = code
    .filter(
      (c) =>
        (!input.folder || c.cwd === input.folder) &&
        !running(c) &&
        c.turns.at(-1)?.status === "failed" &&
        input.now - c.updatedAt < 7 * 24 * 3600 * 1000,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (failed)
    steps.push({
      id: "resume-session",
      sessionId: failed.id,
      title: failed.title,
      stamp: failed.turns.at(-1)!.id,
    });
  // The branch's open pull request: failing checks, comments to answer.
  const pr = input.pullRequest;
  const prBranch = input.branch?.current;
  if (pr && prBranch && input.folder) {
    const key = `${pr.repository}#${pr.number}`;
    if (pr.checks === "failed")
      steps.push({
        id: "pr-ci-failed",
        pr: key,
        branch: prBranch,
        ...(pr.failingCheck ? { check: pr.failingCheck } : {}),
        stamp: `${pr.headSha ?? ""}:${pr.failingCheck ?? ""}`,
      });
    if ((pr.unansweredReviewThreads ?? 0) > 0)
      steps.push({
        id: "pr-review-comments",
        pr: key,
        repository: pr.repository,
        number: pr.number,
        count: pr.unansweredReviewThreads!,
        ...(pr.title ? { title: pr.title } : {}),
        stamp: String(pr.newestReviewComment ?? ""),
      });
  }
  // Work left uncommitted on a branch other than the default one.
  const branch = input.branch?.current;
  if (
    input.folder &&
    !input.worktreeOn &&
    branch &&
    input.branch?.defaultBranch &&
    branch !== input.branch.defaultBranch &&
    (input.uncommittedFiles ?? 0) > 0
  )
    steps.push({
      id: "continue-branch",
      folder: input.folder,
      branch,
      files: input.uncommittedFiles!,
    });
  return steps;
}

/** The rows shown: one per kind (with how many more of it), at most three. */
export function shownSteps(steps: readonly NextStep[], dismissals: Dismissals) {
  const groups = new Map<NextStep["id"], { first: NextStep; more: number }>();
  for (const step of steps) {
    if (isDismissed(dismissals, step)) continue;
    const group = groups.get(step.id);
    if (group) group.more += 1;
    else groups.set(step.id, { first: step, more: 0 });
  }
  return [...groups.values()]
    .sort((a, b) => order.indexOf(a.first.id) - order.indexOf(b.first.id))
    .slice(0, nextStepsLimit);
}
