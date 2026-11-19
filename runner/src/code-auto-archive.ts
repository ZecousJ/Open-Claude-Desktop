import { isOwnedCloudCodeSession } from "../../electron/official-ui/api/code-session-ownership";
import { webHost } from "../../shared/host";
import {
  pullRequestIsLive,
  repositoryFullName,
} from "../../shared/session-git";
import { sessionPullRequests } from "../../shared/pull-request";
import { preference } from "../../shared/settings-extras";
import type { Conversation, SessionPullRequest } from "../../shared/types";
import { autoArchiveOfficialCodeSession } from "./official-code-mutation";
import { readSessionPullRequest, recordPullRequest } from "./session-git";
import type { WebAppContext } from "./web-app-context";

const pollMs = 5 * 60_000;

const prKey = (pr: { repository: string; number: number }) =>
  `${pr.repository.toLowerCase()}#${pr.number}`;

function outputBranches(conversation: Conversation) {
  return (conversation.sessionRepositories ?? []).flatMap((repo) => {
    const branch = repo.outcome?.branch;
    const repository = repositoryFullName(repo.url);
    return repository &&
      branch &&
      branch !== repo.ref &&
      URL.parse(repo.url)?.hostname === "github.com"
      ? [{ url: repo.url, branch, repository }]
      : [];
  });
}

function taggedRequests(conversation: Conversation) {
  const fork = conversation.forkedFrom;
  const boundary = fork
    ? conversation.turns.findIndex((turn) => turn.id === fork.turnId)
    : -1;
  if (fork && boundary < 0) return [];
  const refs = sessionPullRequests(
    fork ? { turns: conversation.turns.slice(boundary + 1) } : conversation,
  );
  const repositories = [
    conversation.repository?.fullName,
    ...(conversation.sessionRepositories ?? []).map((repo) =>
      repositoryFullName(repo.url),
    ),
  ];
  return refs.filter(
    (ref) =>
      ref.host === "github.com" &&
      repositories.some(
        (name) => name?.toLowerCase() === ref.repository.toLowerCase(),
      ),
  );
}

export class CodeAutoArchive {
  private dueAt?: number;
  private polling?: Promise<void>;

  get checking() {
    return this.polling !== undefined;
  }

  constructor(private readonly ctx: WebAppContext) {}

  private enabled(conversation: Conversation, owner: string) {
    return (
      !this.ctx.accountRetiring &&
      (this.ctx.runtime.host ?? webHost).capabilities.cloudCode &&
      isOwnedCloudCodeSession(conversation, owner) &&
      conversation.environment?.kind === "space" &&
      !conversation.codeAutoArchiveExempt &&
      (conversation.prAutoArchive ??
        preference(this.ctx.store.settings, "prAutoArchive"))
    );
  }

  private candidate(conversation: Conversation, owner: string) {
    return (
      !conversation.archived &&
      this.enabled(conversation, owner) &&
      (conversation.pullRequests?.length ||
        outputBranches(conversation).length ||
        taggedRequests(conversation).length)
    );
  }

  private schedule(at: number, restore = false) {
    const owner = this.ctx.activeAccount?.id;
    const due =
      owner &&
      this.ctx.store.conversations.some((c) => this.candidate(c, owner))
        ? at
        : undefined;
    if (!restore && due === this.dueAt) return;
    this.ctx.runtime.wakeCodeArchive?.(this.ctx.userId, due);
    this.dueAt = due;
  }

  start() {
    const schedule = () => this.schedule(Date.now());
    this.ctx.onSettingsChanged(schedule);
    this.ctx.onEvent((event) => {
      const owner = this.ctx.activeAccount?.id;
      if (
        !this.dueAt &&
        !this.polling &&
        owner &&
        event.type === "conversation" &&
        this.candidate(event.conversation, owner)
      )
        schedule();
    });
    this.schedule(Date.now(), true);
  }

  stop() {
    this.ctx.runtime.wakeCodeArchive?.(this.ctx.userId, undefined);
    this.dueAt = undefined;
  }

  check(): Promise<void> | undefined {
    if (this.polling) return this.polling;
    if (
      this.dueAt == null ||
      this.dueAt > Date.now() ||
      this.ctx.accountRetiring
    )
      return;
    const activation = this.ctx.officialSessionIdentity();
    this.polling = Promise.resolve()
      .then(() => this.reconcile())
      .finally(() => {
        this.polling = undefined;
        if (
          !this.ctx.accountRetiring &&
          this.ctx.officialSessionIdentity() === activation
        )
          this.schedule(Date.now() + pollMs);
      });
    return this.polling;
  }

  private async reconcile() {
    const ctx = this.ctx;
    const { store, activeAccount } = ctx;
    if (!activeAccount) return;
    const owner = activeAccount.id;
    const activation = ctx.officialSessionIdentity();
    const { transport } = ctx.runtime;
    for (const conversation of store.conversations) {
      if (ctx.accountRetiring || ctx.officialSessionIdentity() !== activation)
        return;
      if (!this.candidate(conversation, owner)) continue;
      const current = () =>
        ctx.store === store &&
        ctx.officialSessionIdentity() === activation &&
        ctx.activeAccount?.id === owner &&
        store.conversations.includes(conversation) &&
        this.enabled(conversation, owner);
      try {
        const tracked = conversation.pullRequests;
        const sources = conversation.sessionRepositories;
        const before = new Map((tracked ?? []).map((pr) => [prKey(pr), pr]));
        const requests = new Map<string, Omit<SessionPullRequest, "checkedAt">>(
          before,
        );
        let complete = true;
        const read = async (ref: {
          url: string;
          repository: string;
          number: number;
        }) => {
          if (!current()) return;
          const pr = await readSessionPullRequest(transport, ctx.userId, ref);
          if (
            !pr ||
            pr.repository.toLowerCase() !== ref.repository.toLowerCase()
          )
            complete = false;
          else requests.set(prKey(pr), pr);
          return pr;
        };
        for (const pr of before.values()) {
          if (pr.state !== "merged") await read(pr);
        }
        for (const ref of taggedRequests(conversation)) {
          if (!requests.has(prKey(ref))) await read(ref);
        }
        for (const output of outputBranches(conversation)) {
          if (!current()) break;
          const bound = [...requests.values()].some(
            (pr) =>
              pullRequestIsLive(pr) &&
              pr.repository.toLowerCase() === output.repository.toLowerCase() &&
              pr.headRef === output.branch,
          );
          if (bound) continue;
          const match = await transport.request("github.api", ctx.userId, {
            url: output.url,
            action: "pr.byHead",
            head: output.branch,
          });
          const number =
            match && typeof match === "object" && "number" in match
              ? match.number
              : undefined;
          if (typeof number === "number") {
            const ref = { ...output, number };
            const found = requests.get(prKey(ref)) ?? (await read(ref));
            if (found?.headRef !== output.branch) complete = false;
          }
        }
        if (
          !current() ||
          conversation.archived ||
          conversation.sessionRepositories !== sources ||
          conversation.pullRequests !== tracked
        )
          continue;
        let changed = false;
        for (const [key, pr] of requests) {
          const old = before.get(key);
          if (
            old &&
            pr.state === old.state &&
            pr.title === old.title &&
            pr.headRef === old.headRef
          )
            continue;
          changed = true;
          recordPullRequest(conversation, pr);
        }
        if (changed) {
          store.flush();
          ctx.push({
            type: "conversation",
            conversation: structuredClone(conversation),
          });
        }
        const pulls = [...requests.values()];
        if (
          complete &&
          pulls.some((pr) => pr.state === "merged") &&
          !pulls.some(pullRequestIsLive)
        ) {
          const confirmed = conversation.pullRequests;
          await autoArchiveOfficialCodeSession(
            ctx,
            owner,
            conversation,
            () =>
              current() &&
              conversation.pullRequests === confirmed &&
              conversation.sessionRepositories === sources,
          );
        }
      } catch (error) {
        ctx.log(
          `claudex-runner: Code auto-archive check failed for ${conversation.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
