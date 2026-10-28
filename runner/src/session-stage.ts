import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { repositorySpaceId } from "./github-workspace";
import { parseRepositories } from "./code-workspace";
import type { SessionSetupHook } from "../../shared/session-setup";
import { CloudEnvironments } from "../../electron/cloud/environments";
import { cloudEnvironmentId } from "../../shared/cloud-environments-input";
import type { WebAppContext } from "./web-app-context";

/**
 * A new conversation's space, and a new Code session's folder there with its
 * repository and cloud environment: what the browser's first send gets, and a
 * scheduled Code task's run.
 */
export async function stageSession(
  ctx: WebAppContext,
  rest: Record<string, unknown>,
  {
    repository,
    repositories,
  }: { repository?: unknown; repositories?: unknown },
): Promise<[unknown[], string | undefined]> {
  // The main repository names the space; the others are cloned inside it.
  const [repo, ...more] =
    rest.mode === "code" ? parseRepositories({ repository, repositories }) : [];
  let spaceId = repo
    ? repositorySpaceId(repo.url)
    : `${rest.mode === "code" ? "s" : "c"}-${randomUUID()}`;
  const profile =
    rest.mode === "code"
      ? new CloudEnvironments(ctx.store.root).get(
          cloudEnvironmentId.parse(rest.cloudEnvironmentId ?? "default"),
        )
      : undefined;
  if (profile) {
    if (profile.id !== "default" || profile.updatedAt)
      spaceId = repo
        ? repositorySpaceId(`${repo.url}:${profile.id}:${profile.updatedAt}`)
        : spaceId;
    const root = ctx.spaceRoot(spaceId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(root, "cloud-environment.json"),
      JSON.stringify(profile),
      { mode: 0o600 },
    );
    rest.cloudEnvironmentId = profile.id;
  }
  const environment = { kind: "space", spaceId };
  if (rest.mode !== "code") return [[{ ...rest, environment }], undefined];
  // The session opens at once; its repository is cloned in its first turn.
  const { cwd, fetch } = await ctx.stageCodeSession(
    randomUUID(),
    repo,
    spaceId,
    more,
  );
  const setup: SessionSetupHook | undefined =
    fetch || profile?.setupScript
      ? {
          repositories: repo ? [repo, ...more] : [],
          fetch: fetch ?? (async () => {}),
          setupScript: profile?.setupScript,
        }
      : undefined;
  return [[{ ...rest, cwd, environment }, ...(setup ? [{ setup }] : [])], cwd];
}
