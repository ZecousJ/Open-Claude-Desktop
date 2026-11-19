import { z } from "zod";
import { beginCodeSessionLifecycle } from "../../electron/conversations/code-lifecycle-guard";
import {
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { officialCodePullRequestCreateMaxBytes } from "../../shared/official-code-pull-requests";
import type { RepositoryRef } from "../../shared/host";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import type { Conversation } from "../../shared/types";
import { LinkRequestError } from "./control-link";
import {
  createGitHubPullRequest,
  findOpenGitHubPullRequest,
  gitHubPullRequestMetadata,
  type GitHubPullRequest,
} from "./github-pull-requests";
import { persistSessionPullRequest } from "./session-git";
import type { WebAppContext } from "./web-app-context";

const repositoryName = /^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/i;
const createBody = z.strictObject({
  repo: z.string().regex(repositoryName),
  head: z.string().min(1).max(295),
  base: z.string().min(1).max(255),
  title: z
    .string()
    .trim()
    .refine((title) => Buffer.byteLength(title) <= 256)
    .optional(),
  body: z
    .string()
    .refine((body) => Buffer.byteLength(body) <= 65536)
    .optional(),
  draft: z.boolean(),
  session_id: z.string().regex(/^(?:session|cse)_[0-9a-f]{32}$/),
  ghe_configuration_id: z.number().int().positive().nullish(),
});

const githubErrorDetails = z.object({ status: z.string() });
const forkBases = z.array(z.string());

type CreateInput = z.infer<typeof createBody>;

function json(status: number, body: unknown): OfficialUiReadResponse {
  return {
    status,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function officialCodePullRequestError(
  status: number,
  message: string,
  code?: string,
) {
  const type =
    status === 403
      ? "permission_error"
      : status === 404
        ? "not_found_error"
        : status >= 500
          ? "api_error"
          : "invalid_request_error";
  return json(status, {
    type: "error",
    error: { type, message, ...(code && { details: { error_code: code } }) },
  });
}

function knownGitHubFailure(error: unknown) {
  if (!(error instanceof LinkRequestError)) return;
  switch (error.code) {
    case "CLAUDEX_GITHUB_REFUSED": {
      const status = Number(
        githubErrorDetails.safeParse(error.details).data?.status,
      );
      return officialCodePullRequestError(
        status === 403 || status === 405 || status === 409 || status === 422
          ? status
          : 422,
        error.message,
        error.code,
      );
    }
    case "CLAUDEX_GITHUB_BAD_REPOSITORY":
      return officialCodePullRequestError(400, error.message, error.code);
    case "CLAUDEX_GITHUB_NOT_CONNECTED":
      return officialCodePullRequestError(409, error.message, error.code);
    case "CLAUDEX_GITHUB_NO_ACCESS":
      return officialCodePullRequestError(404, error.message, error.code);
  }
}

const branchName = (value: string) => value.replace(/^refs\/heads\//, "");

function ownedHead(conversation: Conversation, input: CreateInput) {
  const colon = input.head.indexOf(":");
  const forkOwner =
    colon >= 0 ? input.head.slice(0, colon).toLowerCase() : undefined;
  const head = branchName(input.head.slice(colon + 1));
  const repositories: readonly RepositoryRef[] = conversation
    .sessionRepositories?.length
    ? conversation.sessionRepositories
    : conversation.repository
      ? [{ url: conversation.repository.url }]
      : [];
  const candidates = repositories.flatMap((source, index) => {
    const url = URL.parse(source.url);
    const repo = url?.pathname
      .replace(/^\//, "")
      .replace(/\/$/, "")
      .replace(/\.git$/, "");
    if (
      !url ||
      url.origin !== "https://github.com" ||
      !repo ||
      !repositoryName.test(repo)
    )
      return [];
    const sessionBranch =
      source.outcome?.branch ??
      (index === 0 ? conversation.branch : source.branch) ??
      (source.ref?.startsWith("refs/heads/") ? source.ref : undefined);
    if (!sessionBranch || branchName(sessionBranch) !== head) return [];
    return [repo];
  });
  const target = input.repo.toLowerCase();
  const sources = candidates.filter((repo) =>
    forkOwner === undefined
      ? repo.toLowerCase() === target
      : repo.toLowerCase() !== target &&
        repo.split("/")[0].toLowerCase() === forkOwner,
  );
  if (sources.length)
    return { head, sources, target, fork: forkOwner !== undefined };
}

export async function createOfficialCodePullRequest(
  ctx: WebAppContext,
  organization: string,
  request: Record<string, unknown>,
  activationCurrent: () => boolean,
): Promise<OfficialUiReadResponse> {
  const fail = officialCodePullRequestError;
  const owner = ctx.activeAccount?.id;
  if (!owner || !activationCurrent())
    return fail(409, "A current authenticated capability lease is required.");
  if (
    organization !== organizationUuid(owner) ||
    (request.codeOrganizationId !== undefined &&
      (typeof request.codeOrganizationId !== "string" ||
        request.codeOrganizationId.toLowerCase() !== organization))
  )
    return fail(404, "Organization not found.");

  const { body, contentType } = request;
  if (
    body instanceof Uint8Array &&
    body.byteLength > officialCodePullRequestCreateMaxBytes
  )
    return fail(413, "The pull request is too large.");
  let input: CreateInput;
  try {
    if (
      !(body instanceof Uint8Array) ||
      typeof contentType !== "string" ||
      !/^application\/json(?:\s*;|$)/i.test(contentType)
    )
      throw Error();
    input = createBody.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
  } catch {
    return fail(400, "Invalid pull request.");
  }
  if (input.ghe_configuration_id != null)
    return fail(
      501,
      "Pull request creation is unavailable for this GitHub Enterprise configuration.",
    );

  const store = ctx.store;
  const key = input.session_id.replace(/^(?:session|cse)_/, "");
  const matches = store.conversations.filter(
    (conversation) =>
      isOwnedCloudCodeSession(conversation, owner) &&
      conversation.environment?.kind === "space" &&
      cloudCodeSessionKey(conversation, owner) === key,
  );
  if (matches.length !== 1) return fail(404, "Code session not found.");
  const [conversation] = matches;
  const coordinates = ownedHead(conversation, input);
  if (!coordinates)
    return fail(404, "The head branch does not belong to this Code session.");
  const { head, sources, target, fork } = coordinates;
  const base = branchName(input.base);
  if (!fork && head === base)
    return fail(422, "Choose a different base branch.");
  const sessionCurrent = () =>
    activationCurrent() &&
    ctx.activeAccount?.id === owner &&
    ctx.store === store &&
    store.conversations.includes(conversation) &&
    isOwnedCloudCodeSession(conversation, owner);
  const idle = () =>
    !conversation.archived &&
    !conversation.pendingSetup?.length &&
    !conversation.turns.some((turn) => turn.status === "inProgress");
  if (!idle())
    return fail(
      409,
      "Wait for the Code session to finish before creating a pull request.",
    );

  const transport = ctx.runtime?.transport;
  if (!transport) return fail(503, "GitHub is unavailable.");
  const github = (data: Record<string, unknown>) =>
    transport.request("github.api", ctx.userId, data);
  const unknownOutcome = () =>
    fail(
      409,
      "GitHub could not confirm whether the pull request was created. Check the branch on GitHub before trying again.",
    );
  let release: () => void;
  try {
    release = beginCodeSessionLifecycle(conversation);
  } catch {
    return fail(409, "A Code session change is already in progress.");
  }
  try {
    let matchedSources = sources;
    if (fork) {
      try {
        const upstreams = await Promise.all(
          sources.map(async (repo) => ({
            repo,
            upstream: forkBases.parse(
              await github({
                url: `https://github.com/${repo}`,
                action: "repository.forkBases",
              }),
            ),
          })),
        );
        matchedSources = upstreams
          .filter(({ upstream }) =>
            upstream.some((repo) => repo.toLowerCase() === target),
          )
          .map(({ repo }) => repo);
      } catch (error) {
        return sessionCurrent()
          ? (knownGitHubFailure(error) ??
              fail(
                503,
                "GitHub could not confirm the upstream of this Code session's fork.",
              ))
          : fail(409, "The account or Code session changed.");
      }
      if (!sessionCurrent())
        return fail(409, "The account or Code session changed.");
      if (!matchedSources.length)
        return fail(
          404,
          "The target repository is not an upstream of this Code session's fork.",
        );
      if (matchedSources.length !== 1)
        return fail(
          409,
          "More than one session fork matches this pull request.",
        );
    }
    const [source] = matchedSources;
    const current = () =>
      sessionCurrent() &&
      !!ownedHead(conversation, input)?.sources.includes(source);
    if (!current() || !idle())
      return fail(409, "The account or Code session changed.");
    const url = `https://github.com/${target}`;
    const coordinate = { url, head, base, headRepository: source };
    const lookup = () => findOpenGitHubPullRequest(github, coordinate);
    let pr: GitHubPullRequest | undefined;
    try {
      pr = await lookup();
    } catch (error) {
      return current()
        ? (knownGitHubFailure(error) ??
            fail(
              503,
              "GitHub could not confirm whether this branch already has a pull request.",
            ))
        : fail(409, "The account or Code session changed.");
    }
    if (!current() || !idle())
      return fail(409, "The account or Code session changed.");

    let own = false;
    if (!pr) {
      let failed: OfficialUiReadResponse | undefined;
      try {
        pr = await createGitHubPullRequest(github, coordinate, {
          title: input.title ?? "",
          body: input.body ?? "",
          draft: input.draft,
        });
        own = true;
      } catch (error) {
        failed = knownGitHubFailure(error);
        if (!current()) return unknownOutcome();
        try {
          pr = await lookup();
        } catch {
          /* GitHub could not resolve the write. */
        }
      }
      if (!pr) return failed ?? unknownOutcome();
    }
    if (!current())
      return fail(
        409,
        "The pull request was found on GitHub, but the Code session changed before it could be linked.",
      );

    const metadata = gitHubPullRequestMetadata(pr, target, own);
    try {
      if (
        await persistSessionPullRequest(store, conversation, metadata, current)
      ) {
        ctx.push({
          type: "conversation",
          conversation: structuredClone(conversation),
        });
        ctx.push({ type: "resync" });
      }
    } catch {
      return fail(
        409,
        "The pull request exists on GitHub, but its Code session link could not be confirmed.",
      );
    }
    return json(200, {
      number: pr.number,
      html_url: pr.html_url,
      state: pr.state,
      draft: pr.draft,
      title: pr.title,
    });
  } finally {
    release();
  }
}
