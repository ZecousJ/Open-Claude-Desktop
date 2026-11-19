import { z } from "zod";
import {
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  officialCodePrMonitorActionMaxBytes,
  officialCodePrMonitorBatchSize,
  officialCodePrMonitorStatusMaxBytes,
  type OfficialCodePrMonitorOperation,
} from "../../shared/official-code-pr-monitor";
import { parsePullRequestUrl } from "../../shared/pull-request";
import {
  pullRequestIsLive,
  repositoryFullName,
} from "../../shared/session-git";
import type { Conversation, SessionPullRequest } from "../../shared/types";
import type { StoreTransport } from "./cloud-store";
import { LinkRequestError } from "./control-link";
import { pullRequestState } from "./session-git";
import type { WebAppContext } from "./web-app-context";

const repoName = z
  .string()
  .max(200)
  .regex(/^[\w.-]+\/[\w.-]+$/);
const branchName = z.string().min(1).max(255);
const sessionId = z.string().regex(/^(?:session|cse)_[a-f0-9]{32}$/);
const pullNumber = z.number().int().positive();
const githubCloud = z.literal(0).optional();
const statusInput = z.strictObject({
  repo_branches: z
    .array(
      z.strictObject({
        repo: repoName,
        branch: branchName,
        session_id: sessionId.optional(),
        ghe_configuration_id: githubCloud,
      }),
    )
    .max(officialCodePrMonitorBatchSize),
  discover_session_prs: z.boolean().optional(),
  session_ids: z
    .array(sessionId)
    .max(officialCodePrMonitorBatchSize)
    .optional(),
  session_id: sessionId.optional(),
  include_ci_status: z.boolean().optional(),
  include_review_decision: z.boolean().optional(),
});
const actionInput = z.strictObject({
  repo: repoName,
  session_id: sessionId,
  pr_number: pullNumber,
  ghe_configuration_id: githubCloud,
});
const muteInput = actionInput.extend({ muted: z.boolean() });
const githubPR = z.object({
  number: pullNumber,
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  draft: z.boolean().optional(),
  title: z.string().optional(),
  head_ref: branchName,
  head_repository: repoName.optional(),
  head_sha: z.string().optional(),
  base_ref: branchName.optional(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  mergeable: z.boolean().nullish(),
  mergeable_state: z.string().optional(),
});
const githubCheck = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullish(),
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    context: z.string(),
    state: z.string(),
  }),
]);
const githubStatus = z.object({
  headRefOid: z.string(),
  reviewDecision: z.string().nullish(),
  autoMergeRequest: z.object({ enabledAt: z.string() }).nullish(),
  commits: z.object({
    nodes: z.array(z.object({
      commit: z.object({
        statusCheckRollup: z.object({
          contexts: z.object({ nodes: z.array(githubCheck) }),
        }).nullish(),
      }),
    })),
  }).optional(),
});
const githubBranch = z.object({ exists: z.boolean() });
const githubBranchPull = z.object({ number: pullNumber.optional() });
const githubForkBases = z.array(z.union([repoName, z.literal("")]));

interface SessionBranch {
  conversation: Conversation;
  repo: string;
  branch: string;
}
interface BranchQuery extends SessionBranch {
  id: string;
  requestedRepo: string;
  requestedId?: string;
  gheConfigurationId?: 0;
  discovery: boolean;
}
type GitHubRead = (
  repo: string,
  action: string,
  args?: object,
) => Promise<unknown>;
type PRDetails = Awaited<ReturnType<typeof readPR>>;
const sameRepo = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();
const githubRepo = (url: string) =>
  URL.parse(url)?.origin === "https://github.com"
    ? repositoryFullName(url)
    : undefined;
const gitBranch = (branch: string | undefined) =>
  branch?.replace(/^refs\/heads\//, "");
const result = (status: number, data: unknown) => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(data)),
});
const failure = (status: number, message: string) =>
  result(status, { error: { message } });

class PrMonitorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sessionBranches(conversation: Conversation): SessionBranch[] {
  const primary =
    conversation.repository && githubRepo(conversation.repository.url);
  const current = gitBranch(conversation.branch);
  const branches = new Map<string, SessionBranch>();
  if (primary && current)
    branches.set(primary.toLowerCase(), {
      conversation,
      repo: primary,
      branch: current,
    });
  for (const source of conversation.sessionRepositories ?? []) {
    const repo = githubRepo(source.url);
    const branch = gitBranch(
      source.outcome?.branch ?? source.branch ?? source.ref,
    );
    if (repo && branch && !branches.has(repo.toLowerCase()))
      branches.set(repo.toLowerCase(), { conversation, repo, branch });
  }
  return [...branches.values()];
}

function pullRequestMatches(
  source: SessionBranch,
  pr: Pick<SessionPullRequest, "headRef" | "headRepository" | "repository">,
) {
  return (
    pr.headRef === source.branch &&
    sameRepo(pr.headRepository ?? pr.repository, source.repo)
  );
}

function trackedRequest(
  source: SessionBranch,
  repo = source.repo,
): SessionPullRequest | undefined {
  const matches = (source.conversation.pullRequests ?? []).filter(
    (pr) =>
      pullRequestMatches(source, pr) &&
      (sameRepo(repo, source.repo) || sameRepo(repo, pr.repository)),
  );
  matches.reverse();
  return matches.find(pullRequestIsLive) ?? matches[0];
}

function readGithub(transport: StoreTransport, userId: number): GitHubRead {
  return (repo, action, args) =>
    transport.request("github.api", userId, {
      url: `https://github.com/${repo}`,
      action,
      ...args,
    });
}

async function readPR(
  github: GitHubRead,
  source: SessionBranch,
  repo: string,
  number: number,
  tracked?: SessionPullRequest,
) {
  const api = githubPR.parse(await github(repo, "pr.get", { number }));
  const address = parsePullRequestUrl(api.html_url);
  if (
    !address ||
    address.host !== "github.com" ||
    api.number !== number ||
    address.number !== number ||
    !sameRepo(address.repository, repo)
  )
    throw new PrMonitorError(
      502,
      "GitHub returned an unexpected pull request.",
    );
  const state = pullRequestState(api);
  const headRepository =
    api.head_repository ??
    (!pullRequestIsLive({ state })
      ? (tracked?.headRepository ?? tracked?.repository)
      : undefined);
  if (
    !headRepository ||
    !pullRequestMatches(source, {
      headRef: api.head_ref,
      repository: address.repository,
      headRepository,
    })
  )
    return;
  const pr: Omit<SessionPullRequest, "checkedAt"> = {
    repository: address.repository,
    number,
    url: address.url,
    title: api.title,
    state,
    headRef: api.head_ref,
    headRepository,
    baseRef: api.base_ref,
  };
  return { pr, api };
}

async function findPR(
  github: GitHubRead,
  query: BranchQuery,
): Promise<PRDetails> {
  const tracked = trackedRequest(query, query.requestedRepo);
  const previous =
    tracked &&
    (await readPR(github, query, tracked.repository, tracked.number, tracked));
  if (previous && pullRequestIsLive(previous.pr)) return previous;
  const find = async (repo: string) => {
    const { number } = githubBranchPull.parse(
      await github(repo, "pr.byHead", {
        head: query.branch,
        ...(!sameRepo(repo, query.repo) && { headRepository: query.repo }),
      }),
    );
    return number === undefined
      ? undefined
      : number === previous?.pr.number && sameRepo(repo, previous.pr.repository)
        ? previous
        : readPR(github, query, repo, number);
  };
  if (!sameRepo(query.requestedRepo, query.repo))
    return (await find(query.requestedRepo)) ?? previous;
  const direct = await find(query.repo);
  if (direct && pullRequestIsLive(direct.pr)) return direct;
  let settled = direct ?? previous;
  const forks = githubForkBases.parse(
    await github(query.repo, "repository.forkBases"),
  );
  for (const base of new Set(
    forks.filter((repo) => repo && !sameRepo(repo, query.repo)),
  )) {
    const fork = await find(base);
    if (fork && pullRequestIsLive(fork.pr)) return fork;
    settled ??= fork;
  }
  return settled;
}

function savedRequest(
  rows: SessionPullRequest[],
  fact: Omit<SessionPullRequest, "checkedAt">,
  at: number,
): SessionPullRequest[] {
  const index = rows.findIndex(
    (pr) =>
      pr.number === fact.number && sameRepo(pr.repository, fact.repository),
  );
  const last = rows[index];
  if (
    last &&
    last.url === fact.url &&
    last.state === fact.state &&
    last.title === fact.title &&
    last.baseRef === fact.baseRef &&
    last.headRef === fact.headRef &&
    last.headRepository === fact.headRepository
  )
    return rows;
  const next = { ...last, ...fact, checkedAt: at };
  return index >= 0
    ? rows.map((row, i) => (i === index ? next : row))
    : [...rows, next].slice(-20);
}

function sourceCurrent(source: SessionBranch) {
  return sessionBranches(source.conversation).some(
    (branch) =>
      sameRepo(branch.repo, source.repo) && branch.branch === source.branch,
  );
}

function ownedSessions(ctx: WebAppContext, owner: string) {
  return new Map(
    ctx.store.conversations.flatMap((conversation) =>
      isOwnedCloudCodeSession(conversation, owner) &&
      (!conversation.sessionAuthors ||
        conversation.sessionAuthors.viewerAccountUuid === owner)
        ? [[cloudCodeSessionKey(conversation, owner), conversation] as const]
        : [],
    ),
  );
}

function branchQueries(
  input: z.infer<typeof statusInput>,
  sessions: Map<string, Conversation>,
) {
  const session = (id: string) => {
    const conversation = sessions.get(id.split("_")[1]);
    if (!conversation) throw new PrMonitorError(404, "Code session not found.");
    return conversation;
  };
  const queries: BranchQuery[] = [];
  const ids = [
    ...new Set([
      ...(input.session_ids ?? []),
      ...(input.session_id ? [input.session_id] : []),
    ]),
  ];
  for (const id of ids) session(id);
  const match = (source: SessionBranch, repo: string, branch: string) =>
    source.branch === branch &&
    (sameRepo(source.repo, repo) || trackedRequest(source, repo) !== undefined);
  for (const row of input.repo_branches) {
    let id = row.session_id ?? input.session_id;
    if (!id && ids.length === 1) id = ids[0];
    const candidates = id
      ? sessionBranches(session(id))
      : [...sessions.values()].flatMap(sessionBranches);
    const sources = candidates.filter((source) =>
      match(source, row.repo, row.branch),
    );
    if (sources.length !== 1)
      throw new PrMonitorError(404, "Code session branch not found.");
    const [source] = sources;
    if (!id) {
      id = [...sessions].find(
        ([, conversation]) => conversation === source.conversation,
      )?.[0];
      if (!id) throw new PrMonitorError(404, "Code session not found.");
      id = "session_" + id;
    }
    queries.push({
      ...source,
      id,
      requestedRepo: row.repo,
      requestedId: row.session_id,
      gheConfigurationId: row.ghe_configuration_id,
      discovery: false,
    });
  }
  if (input.discover_session_prs) {
    for (const id of ids) {
      for (const source of sessionBranches(session(id))) {
        if (
          !queries.some(
            (query) =>
              query.conversation === source.conversation &&
              query.branch === source.branch &&
              sameRepo(query.repo, source.repo),
          )
        ) {
          queries.push({
            ...source,
            id,
            requestedRepo: source.repo,
            discovery: true,
          });
        }
      }
    }
  }
  return queries;
}

async function readStatuses(
  ctx: WebAppContext,
  input: z.infer<typeof statusInput>,
  sessions: Map<string, Conversation>,
  github: GitHubRead,
  current: () => boolean,
) {
  const store = ctx.store;
  const queries = branchQueries(input, sessions);
  const includeCiStatus = input.include_ci_status ?? false;
  const includeReviewDecision = input.include_review_decision ?? includeCiStatus;
  const checked = await Promise.all(
    queries.map(async (query) => {
      const details = await findPR(github, query);
      if (query.discovery && !details) return;
      const [exists, status] = await Promise.all([
        github(query.repo, "repository.branchExists", {
          branch: query.branch,
        }).then((response) => githubBranch.parse(response).exists),
        (includeCiStatus || includeReviewDecision) && details
          ? github(details.pr.repository, "pr.hostedStatus", {
              number: details.pr.number,
              includeCiStatus,
              includeReviewDecision,
            }).then((response) => githubStatus.parse(response))
          : undefined,
      ]);
      return { query, details, exists, status };
    }),
  );
  const visible = checked.filter((row) => row !== undefined);
  if (
    !current() ||
    visible.some(
      ({ query }) =>
        !store.conversations.includes(query.conversation) ||
        !sourceCurrent(query),
    )
  )
    return failure(
      409,
      "The Code session changed during the pull request read.",
    );

  for (const conversation of new Set(
    visible.map(({ query }) => query.conversation),
  )) {
    const previous = conversation.pullRequests;
    const rows = visible.filter(
      ({ query }) => query.conversation === conversation,
    );
    let next = previous ?? [];
    const at = Date.now();
    for (const { details } of rows)
      if (details) next = savedRequest(next, details.pr, at);
    if (next.some((row, i) => row !== previous?.[i])) {
      const valid = () =>
        current() &&
        store.conversations.includes(conversation) &&
        conversation.pullRequests === previous &&
        rows.every(({ query }) => sourceCurrent(query));
      if (
        await store.commitOfficialCodeMutation(
          conversation,
          { pullRequests: next },
          valid,
        )
      )
        ctx.push({
          type: "conversation",
          conversation: structuredClone(conversation),
        });
    }
  }
  if (!current()) return failure(409, "The account activation changed.");
  return result(200, {
    branch_statuses: visible.map(({ query, exists, details, status }) => {
      const tracked =
        details &&
        query.conversation.pullRequests?.find(
          (pr) =>
            pr.number === details.pr.number &&
            sameRepo(pr.repository, details.pr.repository),
        );
      return {
        repo: query.requestedRepo,
        branch: query.branch,
        session_id: query.id,
        request_session_id: query.requestedId,
        ghe_configuration_id: query.gheConfigurationId,
        branch_exists: exists,
        has_session_binding: Boolean(
          tracked?.autoFix?.ci &&
          !tracked.dismissed &&
          pullRequestIsLive(tracked),
        ),
        address_comments_muted: tracked?.autoFix?.comments === false,
        pull_request: details && {
          number: details.pr.number,
          url: details.pr.url,
          state: details.pr.state,
          title: details.pr.title,
          base_ref: details.pr.baseRef,
          head_sha: status?.headRefOid ?? details.api.head_sha,
          additions: details.api.additions,
          deletions: details.api.deletions,
          mergeable:
            details.api.mergeable == null
              ? undefined
              : details.api.mergeable
                ? "MERGEABLE"
                : "CONFLICTING",
          merge_state_status: details.api.mergeable_state,
          review_decision: status?.reviewDecision,
          auto_merge_enabled: status && !!status.autoMergeRequest,
          checks: status?.commits?.nodes.flatMap(({ commit }) =>
            (commit.statusCheckRollup?.contexts.nodes ?? []).map((node) =>
              node.__typename === "CheckRun"
                ? { typename: node.__typename, name: node.name, status: node.status, conclusion: node.conclusion }
                : { typename: node.__typename, name: node.context, state: node.state },
            )),
        },
        upstream_repo:
          details && !sameRepo(details.pr.repository, query.repo)
            ? details.pr.repository
            : undefined,
      };
    }),
  });
}

async function updateWatch(
  ctx: WebAppContext,
  operation: Exclude<OfficialCodePrMonitorOperation, "status">,
  input: z.infer<typeof actionInput> | z.infer<typeof muteInput>,
  conversation: Conversation,
  github: GitHubRead,
  current: () => boolean,
) {
  if (conversation.archived) return failure(404, "Code session not found.");
  const store = ctx.store;
  const previous = conversation.pullRequests;
  const matches = sessionBranches(conversation).flatMap((source) => {
    const found = trackedRequest(source, input.repo);
    return found?.number === input.pr_number ? [{ source, found }] : [];
  });
  if (matches.length !== 1)
    return failure(404, "Current session pull request not found.");
  const [{ source, found }] = matches;
  const valid = () =>
    current() &&
    store.conversations.includes(conversation) &&
    !conversation.archived &&
    sourceCurrent(source) &&
    conversation.pullRequests === previous;
  const details = await readPR(
    github,
    source,
    found.repository,
    found.number,
    found,
  );
  if (!valid())
    return failure(
      409,
      "The Code session changed during the pull request read.",
    );
  if (!details || !pullRequestIsLive(details.pr) || found.dismissed)
    return failure(404, "Current session pull request not found.");
  const watch = found.autoFix;
  if (operation === "mute" && !watch?.ci)
    return failure(
      409,
      "Enable PR auto-fix before changing comment notifications.",
    );
  const autoFix = {
    ...watch,
    ci: operation !== "unsubscribe",
    comments: "muted" in input ? !input.muted : (watch?.comments ?? true),
  };
  if (watch?.ci === autoFix.ci && watch.comments === autoFix.comments)
    return result(200, {});
  const next = (previous ?? []).map((pr) =>
    pr === found
      ? {
          ...pr,
          ...details.pr,
          checkedAt: Date.now(),
          autoFix,
        }
      : pr,
  );
  if (
    await store.commitOfficialCodeMutation(
      conversation,
      { pullRequests: next },
      valid,
    )
  )
    ctx.push({
      type: "conversation",
      conversation: structuredClone(conversation),
    });
  return current()
    ? result(200, {})
    : failure(409, "The account activation changed.");
}

export async function officialCodePrMonitor(
  ctx: WebAppContext,
  operation: OfficialCodePrMonitorOperation,
  request: Record<string, unknown>,
  current: () => boolean,
) {
  const owner = ctx.activeAccount?.id;
  if (
    !owner ||
    typeof request.codeOrganizationId !== "string" ||
    request.codeOrganizationId.toLowerCase() !== organizationUuid(owner)
  )
    return failure(403, "Organization not found.");
  if (!current()) return failure(409, "The account activation changed.");
  const { body, contentType, bodySegments } = request;
  const limit =
    operation === "status"
      ? officialCodePrMonitorStatusMaxBytes
      : officialCodePrMonitorActionMaxBytes;
  if (body instanceof Uint8Array && body.byteLength > limit)
    return failure(413, "The pull request request is too large.");
  let payload: unknown;
  try {
    if (
      !(body instanceof Uint8Array) ||
      bodySegments !== undefined ||
      typeof contentType !== "string" ||
      !/^application\/json(?:\s*;|$)/i.test(contentType)
    )
      throw Error();
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch {
    return failure(400, "Invalid pull request request.");
  }
  const sessions = ownedSessions(ctx, owner);
  const transport = ctx.runtime?.transport;
  if (!transport) return failure(503, "GitHub is unavailable.");
  const github = readGithub(transport, ctx.userId);
  try {
    if (operation === "status") {
      const parsed = statusInput.safeParse(payload);
      return parsed.success
        ? await readStatuses(ctx, parsed.data, sessions, github, current)
        : failure(400, "Invalid branch status request.");
    }
    const parsed = (operation === "mute" ? muteInput : actionInput).safeParse(
      payload,
    );
    if (!parsed.success)
      return failure(400, "Invalid pull request subscription request.");
    const conversation = sessions.get(parsed.data.session_id.split("_")[1]);
    if (!conversation) return failure(404, "Code session not found.");
    return await updateWatch(
      ctx,
      operation,
      parsed.data,
      conversation,
      github,
      current,
    );
  } catch (error) {
    if (!current()) return failure(409, "The account activation changed.");
    if (error instanceof PrMonitorError)
      return failure(error.status, error.message);
    if (error instanceof z.ZodError)
      return failure(502, "GitHub returned an invalid pull request response.");
    if (error instanceof LinkRequestError) {
      if (error.code === "CLAUDEX_GITHUB_NOT_CONNECTED")
        return failure(403, "Connect your GitHub account first.");
      if (error.code === "CLAUDEX_GITHUB_NO_ACCESS")
        return failure(403, "GitHub denied access to the repository.");
    }
    return failure(
      503,
      operation === "status"
        ? "Pull request status is unavailable."
        : "The pull request subscription could not be saved.",
    );
  }
}
