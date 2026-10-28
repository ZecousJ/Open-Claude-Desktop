import { gitHubFetcher, stagedGitHubClone } from "./github-workspace";
import fs from "node:fs";
import path from "node:path";
import { attachmentsFolder } from "./attachments";
import type { CloudEnvironmentConfig } from "../../shared/cloud-environments-api";
import { parseEnvFile } from "../../shared/env-file";
import {
  emptyWorkspace,
  inCodeWorkspace,
  type RepositoryRef,
} from "./code-workspace";
import {
  prepareCodexCache,
  pruneCodexCache,
} from "../../electron/engine/codex-cache";
import type { WebAppContext } from "./web-app-context";

export function spaceStopped(this: WebAppContext, spaceId: string) {
  this.runtime.releaseSandbox?.(this.userId, `space-${this.userId}-${spaceId}`);
  pruneCodexCache(this.store.root, this.spaceRoot(spaceId));
  this.activeSpaces?.delete(spaceId);
}

/** Whether a folder is a Code session's own inside some space's workspace. */
export function inSpaceWorkspace(this: WebAppContext, folder: string) {
  const relative = path.relative(this.spacesRoot, path.resolve(folder));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return false;
  const [spaceId] = relative.split(path.sep);
  return inCodeWorkspace(
    path.join(this.spaceRoot(spaceId), "workspace"),
    folder,
  );
}

/**
 * An isolated space's sandbox: its own codex-home and workspace under
 * `<profile>/spaces/<id>`, attachments and project knowledge read-only,
 * and a sandbox of its own (`space-<user>-<id>`), so a conversation or a
 * repository never sees another's files.
 */
export function spaceSandbox(
  this: WebAppContext,
  spaceId: string,
): {
  binary: string;
  root: string;
  environmentVariables?: Record<string, string>;
} {
  const root = this.spaceRoot(spaceId);
  const profileFile = path.join(root, "cloud-environment.json");
  const cloudEnvironment: CloudEnvironmentConfig | undefined = fs.existsSync(
    profileFile,
  )
    ? JSON.parse(fs.readFileSync(profileFile, "utf8"))
    : undefined;
  const codexCache = prepareCodexCache(this.store.root, root);
  fs.mkdirSync(path.join(root, "workspace"), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(root, "codex-home"), {
    recursive: true,
    mode: 0o700,
  });
  const profile = this.store.root;
  const projects = path.join(profile, "projects");
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  const binary = this.runtime.codexBinary({
    userId: this.userId,
    storeRoot: root,
    codexCache,
    attachments: attachmentsFolder(profile),
    projects,
    sandboxId: `space-${this.userId}-${spaceId}`,
    cloudEnvironment,
  });
  this.activeSpaces?.add(spaceId);
  return {
    binary,
    root,
    environmentVariables: parseEnvFile(cloudEnvironment?.variables ?? ""),
  };
}

/**
 * A new Code session's folder, prepared by the runtime's hook: in the
 * shared workspace, or in a space's (`spaceId`).
 */
export async function prepareCodeSession(
  this: WebAppContext,
  sessionId: string,
  repository?: RepositoryRef,
  spaceId?: string,
  more: RepositoryRef[] = [],
): Promise<string> {
  const { cwd, fetch } = await this.stageCodeSession(
    sessionId,
    repository,
    spaceId,
    more,
  );
  if (fetch)
    try {
      await fetch();
    } catch (error) {
      fs.rmSync(cwd, { recursive: true, force: true });
      throw error;
    }
  return cwd;
}

/**
 * A new Code session's folder, made now, and (with a repository) the
 * clone that fills it, for the engine to run in the session's first turn
 * (shared/session-setup.ts). A custom hook prepares everything at once.
 */
export async function stageCodeSession(
  this: WebAppContext,
  sessionId: string,
  repository?: RepositoryRef,
  spaceId?: string,
  more: RepositoryRef[] = [],
): Promise<{ cwd: string; fetch?: (signal?: AbortSignal) => Promise<void> }> {
  const workspace = spaceId
    ? path.join(this.spaceRoot(spaceId), "workspace")
    : this.workspace;
  const session = { userId: this.userId, sessionId, workspace };
  // Without a custom hook: an empty folder, and a clone of the repository
  // when one was chosen (the service leases the credential, github.clone).
  const extra = repository && more.length ? [more] : [];
  const staged = this.runtime.prepareWorkspace
    ? await this.runtime.prepareWorkspace(session, repository, ...extra)
    : await stagedGitHubClone({
        transport: this.runtime.transport,
        base: emptyWorkspace,
      })(session, repository, ...extra);
  if (!inCodeWorkspace(workspace, staged.cwd))
    throw new Error("The session's folder is outside its workspace.");
  return staged;
}

/**
 * Fetches a session's repositories again into its folder (a start that
 * failed or was stopped): undefined when this runner cannot, or the
 * folder is not a session folder.
 */
export function refetchCodeSession(
  this: WebAppContext,
  cwd: string,
  repositories: RepositoryRef[],
): ((signal?: AbortSignal) => Promise<void>) | undefined {
  if (this.runtime.prepareWorkspace || !repositories.length) return;
  if (!inCodeWorkspace(this.workspace, cwd) && !this.inSpaceWorkspace(cwd))
    return;
  const fetchInto = gitHubFetcher({ transport: this.runtime.transport });
  return (signal) => fetchInto(this.userId, repositories, cwd, signal);
}

/** Removes a session folder whose first message failed (none of its own). */
export function discardCodeSession(this: WebAppContext, cwd: string) {
  if (
    (!inCodeWorkspace(this.workspace, cwd) && !this.inSpaceWorkspace(cwd)) ||
    this.store.conversations.some((c) => c.cwd === cwd)
  )
    return;
  fs.rmSync(cwd, { recursive: true, force: true });
}
