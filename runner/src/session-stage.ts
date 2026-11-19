import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { repositorySpaceId } from "./github-workspace";
import { parseRepositories, type RepositoryRef } from "./code-workspace";
import type { SessionSetupHook } from "../../shared/session-setup";
import { CloudEnvironments } from "../../electron/cloud/environments";
import type { CloudEnvironmentConfig } from "../../shared/cloud-environments-api";
import { cloudEnvironmentId } from "../../shared/cloud-environments-input";
import type { WebAppContext } from "./web-app-context";

export function newConversationSpace() {
  return { kind: "space" as const, spaceId: `c-${randomUUID()}` };
}

/**
 * A new conversation's space, and a new Code session's folder there with
 * its repository and cloud environment: what the browser's first send gets,
 * and a scheduled Code task's run (web-context-activate.ts).
 */
export async function stageSession(
  ctx: WebAppContext,
  rest: Record<string, unknown>,
  {
    repository,
    repositories,
  }: { repository?: unknown; repositories?: unknown },
): Promise<[unknown[], string | undefined]> {
  if (rest.mode !== "code")
    return [[{ ...rest, environment: newConversationSpace() }], undefined];
  const refs = parseRepositories({ repository, repositories });
  const profile = new CloudEnvironments(ctx.store.root).get(
    cloudEnvironmentId.parse(rest.cloudEnvironmentId ?? "default"),
  );
  const { cwd, environment, fetch } = await stageCodeWorkspace(
    ctx,
    profile,
    refs,
  );
  const setup: SessionSetupHook | undefined =
    fetch || profile.setupScript
      ? {
          repositories: refs,
          fetch: fetch ?? (async () => {}),
          setupScript: profile.setupScript,
        }
      : undefined;
  return [
    [
      { ...rest, cwd, environment, cloudEnvironmentId: profile.id },
      ...(setup ? [{ setup }] : []),
    ],
    cwd,
  ];
}

export async function stageCodeWorkspace(
  ctx: WebAppContext,
  profile: CloudEnvironmentConfig,
  [repo, ...more]: RepositoryRef[],
) {
  let spaceId = repo ? repositorySpaceId(repo.url) : `s-${randomUUID()}`;
  if (repo && (profile.id !== "default" || profile.updatedAt))
    spaceId = repositorySpaceId(
      `${repo.url}:${profile.id}:${profile.updatedAt}`,
    );
  const root = ctx.spaceRoot(spaceId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, "cloud-environment.json"),
    JSON.stringify(profile),
    { mode: 0o600 },
  );
  const environment = { kind: "space" as const, spaceId };
  // The session opens at once; its repository is cloned in its first turn
  // (live claude.ai bundle, 2026-10-12: setup progress in the transcript).
  const { cwd, fetch } = await ctx.stageCodeSession(
    randomUUID(),
    repo,
    spaceId,
    more,
  );
  return { cwd, environment, fetch };
}
