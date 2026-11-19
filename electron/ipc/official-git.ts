import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { officialGitRequest, readOfficialGit } from "../git/official-git";
import { contextSources, workspaceFsFor, wslEnvironmentInput } from "../workspace/workspace-fs";
import { localWorkingTree } from "../git/working-tree";
import { checkBranchSwitchConflict, FolderBranchSwitch, isBranchOnOrigin } from "../git/folder-branch";

const sshTarget = z.object({
  sshConfig: z.object({
    sshHost: z.string().min(1),
    sshPort: z.number().int().optional(),
    sshIdentityFile: z.string().optional(),
  }),
});
const remoteTarget = z.union([sshTarget, z.object({ wsl: wslEnvironmentInput })]);

export const folderBranchName = z.string().min(1).max(255)
  .refine(name => !name.startsWith("-") && !name.includes("\0"), "Invalid branch name.");
const branchFolder = { cwd: z.string().min(1).max(4096) };
const branchRequest = z.discriminatedUnion("kind", [
  z.object({ ...branchFolder, kind: z.literal("conflict"), branch: folderBranchName }),
  z.object({ ...branchFolder, kind: z.literal("origin"), branch: folderBranchName }),
  z.object({ ...branchFolder, kind: z.literal("stash"), message: z.string().max(4096) }),
  z.object({ ...branchFolder, kind: z.literal("commit"), fromBranch: z.string().min(1).max(255) }),
  z.object({ ...branchFolder, kind: z.literal("discard") }),
]);

declare module "../app/app-context" {
  interface AppServices {
    folderBranchSwitch?: FolderBranchSwitch;
  }
}

export function registerOfficialGitHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  if (ctx.services) ctx.services.folderBranchSwitch = new FolderBranchSwitch();
  ctx.onAccountDeactivating?.(() => {
    ctx.services.folderBranchSwitch = new FolderBranchSwitch();
  });
  handle("officialGitBranch", async (raw: unknown) => {
    const input = branchRequest.parse(raw);
    ctx.allowedFolder(input.cwd);
    try {
      ctx.services?.workspaceTrust?.assert({ mode: "code", cwd: input.cwd });
    } catch (error) {
      if (input.kind === "conflict") return false;
      if (input.kind === "origin") return null;
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (input.kind === "conflict")
      return checkBranchSwitchConflict(input.cwd, input.branch);
    if (input.kind === "origin")
      return isBranchOnOrigin(input.cwd, input.branch);
    const identity = ctx.accountActivationIdentity;
    const current = () => {
      if (ctx.accountRetiring || ctx.accountActivationIdentity !== identity)
        throw Error("The account changed during this request.");
    };
    const branches = ctx.services.folderBranchSwitch;
    if (!branches) throw Error("Local Git is unavailable.");
    return branches.prepare(input.cwd, input, current);
  });
  handle("officialGitDirectory", async (raw: unknown) => {
    const cwd = z.string().min(1).max(4096).parse(raw);
    ctx.allowedFolder(cwd);
    return await localWorkingTree.git(cwd, ["rev-parse", "--absolute-git-dir"])
      .then(directory => directory.trim(), () => null);
  });
  handle("officialGitRead", (raw: unknown, target?: unknown) => {
    const input = officialGitRequest.parse(raw);
    if (target === undefined) {
      ctx.allowedFolder(input.cwd);
      return readOfficialGit(input);
    }
    const remote = remoteTarget.parse(target);
    if ("wsl" in remote) {
      if (process.platform !== "win32") return null;
      try {
        ctx.allowedFolder(input.cwd, remote.wsl);
        return readOfficialGit(input, workspaceFsFor(contextSources(ctx), remote.wsl)).catch(() => null);
      } catch {
        return null;
      }
    }
    const { sshConfig } = remote;
    const ssh = ctx.services.ssh;
    if (!ssh?.allowed()) return null;
    const matches = ssh.hosts.list().filter((host) => {
      if (
        host.destination !== sshConfig.sshHost ||
        host.port !== sshConfig.sshPort ||
        host.identityFile !== sshConfig.sshIdentityFile
      )
        return false;
      try {
        ctx.allowedFolder(input.cwd, { kind: "ssh", hostId: host.id });
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) return null;
    const workspace = workspaceFsFor(contextSources(ctx), {
      kind: "ssh",
      hostId: matches[0].id,
    });
    return readOfficialGit(input, workspace).catch(() => null);
  });
}
