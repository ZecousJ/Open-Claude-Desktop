import { untrustedRootsFromLayers } from "../workspace/workspace-trust";
import {
  workspaceTrustMessage,
  type WorkspaceTrust,
} from "../../shared/workspace-trust-api";
import type { Engine } from "./engine";

/**
 * Replaces the `projects` table (workspace trust) of the running Codex's
 * user config: it writes the file and reloads it into loaded threads.
 * Resolves false when Codex isn't running here (the caller writes the
 * file, which the next start keeps).
 */
export async function writeCodexProjects(
  this: Engine,
  projects: Record<string, unknown>,
) {
  const rpc = this.rpc;
  if (!rpc || this.launcher || this.state.state !== "ready") return false;
  await rpc.call("config/batchWrite", {
    edits: [{ keyPath: "projects", value: projects, mergeStrategy: "replace" }],
    reloadUserConfig: true,
  });
  return true;
}

/** Trusts the Codex project of a folder Codex reports as untrusted. */
export async function trustCodexProject(this: Engine, cwd: string) {
  const rpc = this.rpc;
  if (!rpc) return;
  const read = await rpc.call("config/read", { includeLayers: true, cwd });
  const roots = untrustedRootsFromLayers(read?.layers);
  if (!roots.length) return;
  await rpc.call("config/batchWrite", {
    edits: [
      {
        keyPath: "projects",
        value: Object.fromEntries(
          roots.map((root) => [root, { trust_level: "trusted" }]),
        ),
        mergeStrategy: "upsert",
      },
    ],
    reloadUserConfig: true,
  });
}

/**
 * An SSH host's workspace trust for a folder there (shared/workspace-
 * trust-api.ts): trusted when its Codex project root is in this
 * computer's store for the host. Without a folder, the host's default.
 */
export async function remoteWorkspaceTrust(
  this: Engine,
  folder?: string,
  interactive = true,
): Promise<WorkspaceTrust> {
  const launcher = this.launcher;
  const hostId = this.sshHostId;
  if (!launcher?.workspaceTrust || !hostId)
    throw new Error("Workspace trust isn't available here.");
  const cwd = folder || (await launcher.defaultCwd?.());
  if (!cwd)
    throw new Error(`Choose a folder on ${launcher.label || "the SSH host"}`);
  const found = await launcher.workspaceTrust(cwd, interactive);
  const trusted = this.sshTrust!.roots(hostId).includes(found.root);
  if (trusted) this.trustedRemoteFolders.add(cwd);
  return {
    folder: found.folder,
    root: found.root,
    trusted,
    sources: trusted ? [] : found.sources,
    ...(launcher.label ? { host: launcher.label } : {}),
  };
}

/** Records "Trust workspace" for a folder on the SSH host. */
export async function trustRemoteWorkspace(
  this: Engine,
  folder?: string,
): Promise<WorkspaceTrust> {
  const trust = await this.remoteWorkspaceTrust(folder);
  if (trust.trusted) return trust;
  this.sshTrust!.trust(this.sshHostId!, trust.root);
  if (folder) this.trustedRemoteFolders.add(folder);
  this.trustedRemoteFolders.add(trust.folder);
  // The running Codex there loads it now; the next start writes it again.
  const rpc = this.rpc;
  if (rpc && this.state.state === "ready")
    await rpc
      .call("config/batchWrite", {
        edits: [
          {
            keyPath: "projects",
            value: { [trust.root]: { trust_level: "trusted" } },
            mergeStrategy: "upsert",
          },
        ],
        reloadUserConfig: true,
      })
      .catch(() => {});
  return { ...trust, trusted: true, sources: [] };
}

/**
 * Refuses a Code turn on an SSH host in a folder its Codex doesn't trust
 * (the official remote trust check before a session there).
 */
export async function assertRemoteTrust(
  this: Engine,
  cwd: string,
  interactive: boolean,
) {
  if (!this.launcher?.workspaceTrust || this.trustedRemoteFolders.has(cwd))
    return;
  const trust = await this.remoteWorkspaceTrust(cwd, interactive);
  if (!trust.trusted) throw new Error(workspaceTrustMessage);
}
