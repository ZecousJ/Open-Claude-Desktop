/**
 * The working folder of a Code conversation, wherever it is (R9): this
 * computer's (`localWorkspaceFs`) or an SSH host's (`RemoteWorkspace`,
 * electron/ssh/remote-workspace.ts). The Changes panel, the `@` file list,
 * the branch chip and generated file snapshots ask the conversation's
 * `WorkspaceFs`, so a host's path is never looked up on this computer, nor
 * the other way round.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MentionFile } from "../../shared/composer-api";
import type { WorkspaceGit } from "../../shared/code-usage-api";
import type { Conversation, EnvironmentRef } from "../../shared/types";
import type { AppContext } from "../app/app-context";
import { mentionFiles } from "../engine/composer-files";
import {
  FileTooLargeError,
  type WorkspaceFileReader,
} from "../artifacts/generated-files";
import { workspaceGit } from "../git/git-branch";
import { localWorkingTree, type WorkingTreeHost } from "../git/working-tree";
import { remoteWorkspace, type RemoteSources } from "../ssh/remote-workspace";

export interface WorkspaceFs extends WorkingTreeHost {
  readonly environment: EnvironmentRef;
  /** Whether `folder` is a folder there. */
  isDirectory(folder: string): Promise<boolean>;
  /** The `@` list for `query` under `root` (composer-files.ts rules). */
  mentionFiles(root: string, query: string): Promise<MentionFile[]>;
  /** The folder's branch and whether it has a GitHub remote. */
  workspaceGit(folder: string): Promise<WorkspaceGit>;
  /** A regular file inside a folder, up to a size (generated files). */
  readFileInside: WorkspaceFileReader;
  writeFileInside?(
    cwd: string,
    file: string,
    bytes: Buffer,
    authorize?: () => void,
  ): Promise<void>;
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** An environment the window names (a new Code session's, a project's). */
export const environmentInput = z.union([
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("ssh"),
      hostId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    })
    .strict(),
]);

/** This computer's folders. */
export const localWorkspaceFs: WorkspaceFs = {
  environment: { kind: "local" },
  ...localWorkingTree,
  async isDirectory(folder) {
    try {
      return fs.statSync(folder).isDirectory();
    } catch {
      return false;
    }
  },
  async mentionFiles(root, query) {
    return mentionFiles(root, query);
  },
  async workspaceGit(folder) {
    return workspaceGit(folder);
  },
  async readFileInside(cwd, file, maxBytes) {
    const root = fs.realpathSync(cwd);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error("Only regular files can be previewed.");
    if (!inside(root, fs.realpathSync(file)))
      throw new Error("This file resolves outside the conversation workspace.");
    if (stat.size > maxBytes) throw new FileTooLargeError(stat.size);
    const data = fs.readFileSync(file);
    if (data.length !== stat.size)
      throw new Error("The file changed while preparing its preview.");
    return data;
  },
  async writeFileInside(cwd, file, bytes, authorize) {
    const root = fs.realpathSync(cwd);
    const target = path.resolve(cwd, file);
    const parent = fs.realpathSync(path.dirname(target));
    if (
      !inside(path.resolve(cwd), target) ||
      !inside(root, parent) ||
      target === path.resolve(cwd)
    )
      throw new Error("This file resolves outside the conversation workspace.");
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1))
      throw new Error("Only regular files can be previewed.");
    const temporary = path.join(parent, `.claudex-restore-${randomUUID()}`);
    try {
      fs.writeFileSync(temporary, bytes, {
        flag: "wx",
        mode: stat ? stat.mode & 0o777 : 0o600,
      });
      if (
        fs.realpathSync(path.dirname(target)) !== parent ||
        fs.realpathSync(cwd) !== root
      )
        throw new Error(
          "This file resolves outside the conversation workspace.",
        );
      authorize?.();
      fs.renameSync(temporary, path.join(parent, path.basename(target)));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  },
};

/** The folder of an environment: this computer's, or an SSH host's. */
export function workspaceFsFor(
  sources: RemoteSources,
  environment: EnvironmentRef | undefined,
): WorkspaceFs {
  return environment?.kind === "ssh"
    ? remoteWorkspace(sources, environment.hostId)
    : localWorkspaceFs;
}

/** The folder of a conversation (its `environment`; missing means local). */
export function conversationWorkspace(
  sources: RemoteSources,
  conversation: Pick<Conversation, "environment">,
): WorkspaceFs {
  return workspaceFsFor(sources, conversation.environment);
}

/** The sources an IPC domain has in the app context. */
export function contextSources(
  ctx: Pick<AppContext, "engines" | "services">,
): RemoteSources {
  return {
    engines: () => ctx.engines.all(),
    ssh: () => ctx.services.ssh,
  };
}
