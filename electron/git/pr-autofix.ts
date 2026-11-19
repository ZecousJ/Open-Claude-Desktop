import type { AppContext } from "../app/app-context";
import { runGh, type GhRunner } from "./github-cli";
import { validRepositoryName } from "../../shared/github-parse";
import { parsePullRequestUrl, sessionPullRequest, sessionPullRequests, type PullRequestRef } from "../../shared/pull-request";
import { preference } from "../../shared/settings-extras";
import { codeEffortLevels } from "../../shared/code-effort";
import {
  autoFixMessage,
  autoFixNews,
  rememberDelivered,
  type AutoFixComment,
  type PullRequestAutoFix,
} from "../../shared/pr-autofix";
import type { Conversation, SessionPullRequest } from "../../shared/types";
import { readDesktopArchivePullRequests } from "../conversations/auto-archive-pull-requests";
import { createHash } from "node:crypto";

/**
 * Auto-fix pull requests on this computer (the live desktop's AutoFixEngine,
 * 2026-10-15): once a minute, each local Code session whose pull request is
 * watched (Conversation.prAutoFix) and that is not working is checked on
 * GitHub with the machine's `gh`; failing checks on the head commit and new
 * comments in open review threads wake it with one message
 * (shared/pr-autofix.ts). What was reported is remembered, so a failure or
 * a comment is sent once. Settings → Auto-fix pull requests turns it on for
 * a session's new pull request.
 */

const intervalMs = 60_000;
/** A session's pull request counts as new for the default within this time. */
const freshMs = 60 * 60_000;
const ownPrFreshMs = 15 * 60_000;

export const autoFixQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state headRefOid mergeable
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name conclusion }
        ... on StatusContext { context state }
      } } } } } }
      reviewThreads(first: 100) { nodes {
        isResolved
        comments(last: 20) { nodes { databaseId viewerDidAuthor authorAssociation body path line originalLine author { login } } }
      } }
      comments(last: 20) { nodes { databaseId viewerDidAuthor authorAssociation body author { login } } }
      reviews(last: 20) { nodes { databaseId viewerDidAuthor authorAssociation state body author { login } } }
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
const trustedAuthors = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

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
  const add = (node: Json, kind?: AutoFixComment["kind"]) => {
    if (typeof node?.databaseId !== "number" || node.viewerDidAuthor === true ||
        !trustedAuthors.has(node.authorAssociation) || typeof node.body !== "string" || !node.body.trim()) return;
    comments.push({
      id: node.databaseId,
      ...(kind && { kind }),
      author: String(node.author?.login ?? "someone"),
      ...(typeof node.path === "string" ? { path: node.path } : {}),
      ...(typeof (node.line ?? node.originalLine) === "number" ? { line: node.line ?? node.originalLine } : {}),
      body: node.body,
    });
  };
  for (const thread of (pull.reviewThreads?.nodes ?? []) as Json[]) {
    if (thread?.isResolved !== false) continue;
    for (const node of (thread.comments?.nodes ?? []) as Json[]) add(node);
  }
  for (const node of (pull.comments?.nodes ?? []) as Json[]) add(node, "issue");
  for (const node of (pull.reviews?.nodes ?? []) as Json[])
    if (node.state !== "PENDING" && node.state !== "DISMISSED") add(node, "review");
  comments.sort((a, b) => a.id - b.id);
  return {
    headSha: typeof pull.headRefOid === "string" ? pull.headRefOid : undefined,
    failingChecks,
    comments,
    ...(pull.mergeable === "CONFLICTING" && { conflicts: true }),
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
  const current = (c: Conversation) =>
    !stopped && ctx.store === store && ctx.engine === engine &&
    store.conversations.includes(c) && c.mode === "code" && !c.incognito && !c.archived &&
    !c.linkedToComputer && !c.cloudHosted;
  const live = (pr: SessionPullRequest) =>
    !pr.dismissed && pr.state !== "closed" && pr.state !== "merged";
  const same = (a: SessionPullRequest, b: SessionPullRequest) =>
    a.url.toLowerCase() === b.url.toLowerCase();
  const saveRows = async (c: Conversation, previous: Conversation["pullRequests"],
    patch: { pullRequests: SessionPullRequest[]; prAutoFixArm?: undefined }) => {
    const unchanged = () => current(c) && c.pullRequests === previous;
    if (!unchanged()) return;
    await store.persistChatMetadata(c, patch, unchanged);
    ctx.push({ type: "conversation", conversation: structuredClone(c) });
  };

  const refreshIntent = async (c: Conversation) => {
    const previous = c.pullRequests;
    const legacyRef = c.prAutoFix && sessionPullRequest(c);
    const legacy = legacyRef && previous?.find(pr =>
      !pr.autoFix && live(pr) && pr.url.toLowerCase() === legacyRef.url.toLowerCase());
    if (legacy && previous && c.prAutoFix) {
      const watch = c.prAutoFix;
      await saveRows(c, previous, { pullRequests: previous.map(pr =>
        pr === legacy ? { ...pr, autoFix: watch } : pr,
      ) });
      return;
    }
    const arm = c.prAutoFixArm;
    const activeArm = arm && arm.expiresAt > Date.now() ? arm : undefined;
    const auto = c.prAutoFixOwnPrs ?? (preference(store.settings, "prAutoFix") || taskAutoFix(c));
    if (!activeArm && !auto) return;
    const available = readHosted ? previous :
      await readDesktopArchivePullRequests(c).catch(() => undefined);
    if (!current(c) || c.prAutoFixArm !== arm || c.pullRequests !== previous || !available) return;
    const reported = new Set(sessionPullRequests(c).map(ref => ref.url.toLowerCase()));
    const eligible = available.find(pr => live(pr) && !pr.autoFix && pr.own === true &&
      (pr.openedBySession || reported.has(pr.url.toLowerCase())) &&
      (activeArm ? pr.headRef === activeArm.branch :
        pr.createdAt !== undefined && Date.now() - pr.createdAt <= ownPrFreshMs));
    if (!eligible) return;
    const next = [...(previous ?? [])];
    const at = next.findIndex(pr => same(pr, eligible));
    const watched = { ...eligible, autoFix: { ci: true, comments: true } };
    if (at < 0) next.push(watched);
    else next[at] = { ...next[at], ...watched };
    await saveRows(c, previous, {
      pullRequests: next,
      ...(activeArm && { prAutoFixArm: undefined }),
    });
  };

  const deliver = async (c: Conversation, ref: PullRequestRef,
    readWatch: () => PullRequestAutoFix | undefined,
    remember: (watch: PullRequestAutoFix, keys: string[]) => Promise<void>) => {
    const facts = await (readHosted
      ? readHosted(ref.repository, ref.number)
      : readFacts(ref.repository, ref.number, run)).catch(() => undefined);
    if (!facts || !current(c) || working(c)) return;
    const watch = readWatch();
    if (!watch?.ci) return;
    const news = autoFixNews(watch, facts);
    const message = autoFixMessage({
      source: readHosted ? "cloud" : "desktop",
      repository: ref.repository,
      number: ref.number,
      failingChecks: news.failing,
      comments: news.comments,
      conflicts: news.conflicts,
    });
    if (!message) return;
    const notificationKey = createHash("sha256")
      .update(JSON.stringify([ref.repository, ref.number, ...news.keys.slice().sort()]))
      .digest("hex");
    const accepted = () => c.turns.some(turn =>
      turn.notificationTrigger === "ci-monitor" &&
      turn.notificationKey === notificationKey && !turn.sendFailed);
    const offered = engine.modelEfforts?.(c.providerId, c.model);
    const effort = offered?.length
      ? [c.effort, store.settings.codeEffort].find(level => level && offered.includes(level)) ??
        codeEffortLevels.find(level => offered.includes(level))
      : c.effort;
    try {
      const outcome = !accepted() ? await engine.send({
        conversationId: c.id,
        text: message,
        notificationTrigger: "ci-monitor",
        notificationKey,
        mode: "code",
        attachments: [],
        providerId: c.providerId,
        model: c.model,
        effort,
      }) : undefined;
      const sent = outcome?.turns.filter(turn => turn.notificationKey === notificationKey).at(-1);
      if (sent?.sendFailed) return;
    } catch (error) {
      if (!accepted()) throw error;
    }
    if (current(c)) await remember(watch, news.keys);
  };

  const check = async () => {
    if (busy || stopped) return;
    busy = true;
    const delivered = new Set<string>();
    try {
      for (const c of store.conversations) {
        if (stopped) return;
        if (!current(c) || (c.environment && c.environment.kind !== "local" &&
          !(c.environment.kind === "space" && readHosted))) continue;
        try {
          await refreshIntent(c);
          if (!current(c) || working(c)) continue;
          if (c.pullRequests?.length) {
            for (const pr of c.pullRequests) {
              if (!live(pr) || !pr.autoFix?.ci) continue;
              const ref = parsePullRequestUrl(pr.url);
              const key = pr.url.toLowerCase();
              if (ref?.host !== "github.com" || delivered.has(key)) continue;
              delivered.add(key);
              const readWatch = () => {
                const latest = c.pullRequests?.find(row => same(row, pr));
                return latest && live(latest) ? latest.autoFix : undefined;
              };
              await deliver(c, ref, readWatch, async (watch, keys) => {
                const previous = c.pullRequests;
                if (!previous || readWatch() !== watch) return;
                await saveRows(c, previous, { pullRequests: previous.map(row =>
                  same(row, pr) ? { ...row, autoFix: { ...watch, delivered: rememberDelivered(watch, keys) } } : row,
                ) });
              });
              if (working(c)) break;
            }
            continue;
          }
          const ref = sessionPullRequest(c);
          if (!ref || ref.host !== "github.com" || delivered.has(ref.url.toLowerCase())) continue;
          if (!c.prAutoFix) {
            const last = c.turns.at(-1);
            if (!last || Date.now() - (last.createdAt ?? 0) >= freshMs ||
              !(preference(store.settings, "prAutoFix") || taskAutoFix(c))) continue;
            c.prAutoFix = { ci: true, comments: true };
            store.flush();
            ctx.push({ type: "conversation", conversation: structuredClone(c) });
          }
          if (!c.prAutoFix.ci) continue;
          delivered.add(ref.url.toLowerCase());
          const readWatch = () => sessionPullRequest(c)?.url === ref.url ? c.prAutoFix : undefined;
          await deliver(c, ref, readWatch, async (watch, keys) => {
            if (readWatch() !== watch) return;
            watch.delivered = rememberDelivered(watch, keys);
            store.flush();
          });
        } catch (error) {
          console.warn("claudex: auto-fix couldn't check pull requests:", error instanceof Error ? error.message : String(error));
        }
      }
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
