import type { AppContext } from "../app/app-context";
import { runGh, type GhRunner } from "./github-cli";
import { validRepositoryName } from "../../shared/github-parse";
import { sessionPullRequest } from "../../shared/pull-request";
import { preference } from "../../shared/settings-extras";
import {
  autoFixMessage,
  autoFixNews,
  rememberDelivered,
  type AutoFixComment,
} from "../../shared/pr-autofix";
import type { Conversation } from "../../shared/types";
import { createHash } from "node:crypto";

/**
 * Auto-fix pull requests on this computer: once a minute, each local Code
 * session whose pull request is watched (Conversation.prAutoFix) and that is
 * not working is checked on GitHub with the machine's `gh`; failing checks on
 * the head commit and new comments in open review threads wake it with one
 * message (shared/pr-autofix.ts). What was reported is remembered, so a failure
 * or a comment is sent once. Settings → Auto-fix pull requests turns it on for
 * a session's new pull request.
 */

const intervalMs = 60_000;
/** A session's pull request counts as new for the default within this time. */
const freshMs = 60 * 60_000;

export const autoFixQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state headRefOid
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name conclusion }
        ... on StatusContext { context state }
      } } } } } }
      reviewThreads(first: 100) { nodes {
        isResolved
        comments(last: 20) { nodes { databaseId viewerDidAuthor body path line originalLine author { login } } }
      } }
    }
  }
}`;

type Json = any;
const failed = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

/** What the watcher needs from GitHub's answer; undefined when the request is not open. */
export function autoFixFacts(pull: Json) {
  if (!pull || pull.state !== "OPEN") return undefined;
  const contexts: Json[] =
    pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const failingChecks = [
    ...new Set(
      contexts
        .filter((entry) =>
          failed.has(String(entry?.conclusion ?? entry?.state ?? "")),
        )
        .map((entry) => String(entry?.name ?? entry?.context ?? ""))
        .filter(Boolean),
    ),
  ];
  const comments: AutoFixComment[] = [];
  for (const thread of (pull.reviewThreads?.nodes ?? []) as Json[]) {
    if (thread?.isResolved !== false) continue;
    for (const node of (thread.comments?.nodes ?? []) as Json[])
      if (typeof node?.databaseId === "number" && node.viewerDidAuthor !== true)
        comments.push({
          id: node.databaseId,
          author: String(node.author?.login ?? "someone"),
          ...(typeof node.path === "string" ? { path: node.path } : {}),
          ...(typeof (node.line ?? node.originalLine) === "number"
            ? { line: node.line ?? node.originalLine }
            : {}),
          body: String(node.body ?? ""),
        });
  }
  comments.sort((a, b) => a.id - b.id);
  return {
    headSha: typeof pull.headRefOid === "string" ? pull.headRefOid : undefined,
    failingChecks,
    comments,
  };
}

async function readFacts(repository: string, number: number, run: GhRunner) {
  if (!validRepositoryName(repository)) return undefined;
  const [owner, name] = repository.split("/");
  const result = await run([
    "api",
    "graphql",
    "-f",
    `query=${autoFixQuery}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  if (result.code !== 0) return undefined;
  try {
    return autoFixFacts(
      JSON.parse(result.stdout)?.data?.repository?.pullRequest,
    );
  } catch {
    return undefined;
  }
}

const working = (c: Conversation) => c.turns.at(-1)?.status === "inProgress";

export function startPullRequestAutoFix(
  ctx: Pick<AppContext, "store" | "engine" | "push"> &
    Partial<Pick<AppContext, "services" | "scheduler">>,
  run: GhRunner = runGh,
) {
  // Capture this account's objects; an account switch must never redirect an
  // outstanding read or wake to the next account's store/engine.
  const store = ctx.store,
    engine = ctx.engine;
  const readHosted = ctx.services?.readPullRequestAutoFix?.bind(ctx.services);
  // A scheduled task's "Auto-fix pull requests" covers its runs' sessions.
  const taskAutoFix = (c: Conversation) =>
    !!c.scheduledTaskId &&
    !!ctx.scheduler?.list().find((task) => task.id === c.scheduledTaskId)
      ?.autoFixPullRequests;
  let busy = false;
  let stopped = false;
  const check = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const c of store.conversations) {
        if (stopped) return;
        if (c.mode !== "code" || c.incognito || c.archived) continue;
        if (
          c.environment &&
          c.environment.kind !== "local" &&
          !(c.environment.kind === "space" && readHosted)
        )
          continue;
        const ref = sessionPullRequest(c);
        if (!ref || ref.host !== "github.com") continue;
        // Settings → Auto-fix pull requests, or the scheduled task's own: on
        // for a session's new request.
        if (!c.prAutoFix) {
          const last = c.turns.at(-1);
          const fresh = last && Date.now() - (last.createdAt ?? 0) < freshMs;
          if (
            !fresh ||
            !(preference(store.settings, "prAutoFix") || taskAutoFix(c))
          )
            continue;
          c.prAutoFix = { ci: true, comments: true };
          store.flush();
          ctx.push({ type: "conversation", conversation: structuredClone(c) });
        }
        let autoFix = c.prAutoFix;
        if (!autoFix.ci || working(c)) continue;
        const facts = await (
          readHosted
            ? readHosted(ref.repository, ref.number)
            : readFacts(ref.repository, ref.number, run)
        ).catch(() => undefined);
        if (stopped) return;
        if (
          !facts ||
          working(c) ||
          c.archived ||
          c.incognito ||
          !store.conversations.includes(c)
        )
          continue;
        const currentRef = sessionPullRequest(c);
        if (
          currentRef?.repository !== ref.repository ||
          currentRef.number !== ref.number ||
          currentRef.host !== ref.host
        )
          continue;
        autoFix = c.prAutoFix;
        if (!autoFix?.ci) continue;
        const news = autoFixNews(autoFix, facts);
        const message = autoFixMessage({
          source: readHosted ? "cloud" : "desktop",
          repository: ref.repository,
          number: ref.number,
          failingChecks: news.failing,
          comments: news.comments,
        });
        if (!message) continue;
        const notificationKey = createHash("sha256")
          .update(
            JSON.stringify([
              ref.repository,
              ref.number,
              ...news.keys.slice().sort(),
            ]),
          )
          .digest("hex");
        const accepted = () =>
          c.turns.some(
            (turn) =>
              turn.notificationTrigger === "ci-monitor" &&
              turn.notificationKey === notificationKey &&
              !turn.sendFailed,
          );
        const remember = () => {
          if (stopped || !store.conversations.includes(c) || !c.prAutoFix)
            return;
          c.prAutoFix.delivered = rememberDelivered(c.prAutoFix, news.keys);
          store.flush();
        };
        // A previous dispatch may have been recorded before its acknowledgement
        // was lost. Retry an unaccepted failure without sending that event twice.
        if (accepted()) {
          remember();
          continue;
        }
        try {
          await engine.send({
            conversationId: c.id,
            text: message,
            notificationTrigger: "ci-monitor",
            notificationKey,
            mode: "code",
            attachments: [],
            providerId: c.providerId,
            model: c.model,
          });
          remember();
        } catch (error) {
          if (accepted()) {
            remember();
            continue;
          }
          console.warn(
            "claudex: auto-fix couldn't wake the session:",
            (error as Error).message,
          );
        }
      }
    } catch (error) {
      console.warn(
        "claudex: auto-fix couldn't check pull requests:",
        (error as Error).message,
      );
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
