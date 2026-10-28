/**
 * Cowork folder grants (R11-A). Cowork asks before it uses a folder of the
 * person's: "Allow" lets one task (conversation) use it, "Always allow" makes
 * it a trusted folder (and every folder inside it). The decision lives here,
 * in the main process, per account profile (`<store.root>/cowork-folders.json`):
 * the window can only ask for a grant through `electron/ipc/cowork.ts`, and
 * every Cowork send is checked against these grants before the engine runs.
 *
 * Paths are compared after `realpath`, so a grant for one folder never lets
 * a symbolic link swapped in later point somewhere else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import { coworkFolderPermissionMessage } from "../../shared/cowork-api";
import { ExecutionFolderBrowser } from "./execution-folder-browser";
import { emptyGrants } from "./cowork-folders-support";
import * as coworkFolderAccess from "./cowork-folder-access";
import { installMethods } from "./install-methods";
import { extraLimit, projectGrantLimit } from "./cowork-folders-support";

export { coworkFolderPermissionMessage };
/** A routine's run whose Cowork folder was never allowed (nobody is there to ask). */
export const routineFolderPermissionMessage =
  "Cowork needs your permission to use this task's folder. Add it under Settings → Cowork → Trusted Cowork folders, or choose the folder again in the task.";

const fileName = "cowork-folders.json";
/** How long an "Allow" given before the task exists waits for its first send. */
export const pendingGrantMs = 15 * 60 * 1000;

export interface SessionGrant {
  primary?: string;
  extra: string[];
}
export interface SavedGrants {
  version: 1;
  trusted: string[];
  sessions: Record<string, SessionGrant>;
  routines: Record<string, string>;
  /**
   * Folders the person allowed for a project's tasks (its Folder section):
   * project id → real paths. Each new Cowork task in the project gets them.
   */
  projects?: Record<string, string[]>;
}

export interface CoworkFolderGrantsOptions {
  platform?: NodeJS.Platform;
  home?: string;
  now?: () => number;
}

export class CoworkFolderGrants {
  readonly file: string;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly now: () => number;
  data: SavedGrants = emptyGrants();
  /** Incognito tasks' grants never reach disk. */
  readonly memorySessions = new Map<string, SessionGrant>();
  /** "Allow" given before the task existed: folder → expiry. */
  readonly pending = new Map<string, number>();
  loaded = false;

  constructor(
    readonly root: string,
    options: CoworkFolderGrantsOptions = {},
  ) {
    this.file = path.join(root, fileName);
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? os.homedir();
    this.now = options.now ?? Date.now;
  }

  /** A remote session can browse only its own execution workspace. */
  executionBrowser(
    conversation: Readonly<Conversation>,
  ): ExecutionFolderBrowser {
    const environment = conversation.environment;
    if (
      environment?.kind !== "space" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(environment.spaceId) ||
      conversation.linkedToComputer ||
      conversation.chatDeviceBinding
    )
      throw new Error("Folder access is unavailable for this session.");
    const profile = fs.realpathSync.native(this.root);
    const wanted = path.join(
      profile,
      "spaces",
      environment.spaceId,
      "workspace",
    );
    const real = fs.realpathSync.native(wanted);
    // Reject symlinked spaces/workspaces, including links into a sibling account.
    if (real !== wanted)
      throw new Error(
        "This task’s workspace moved outside its execution root.",
      );
    const browser = new ExecutionFolderBrowser(real);
    if (conversation.cwd) browser.checked(conversation.cwd);
    return browser;
  }

  /** The folder Cowork uses when no folder is chosen (never asks). */
  defaultWorkspace(): string {
    return path.join(this.root, "workspace");
  }

  /**
   * The folder's real path, or undefined when it does not exist or is not a
   * folder.
   */
  normalize(folder: string): string | undefined {
    try {
      const real = fs.realpathSync.native(path.resolve(folder));
      return fs.statSync(real).isDirectory() ? real : undefined;
    } catch {
      return undefined;
    }
  }

  key(folder: string) {
    return this.platform === "darwin" || this.platform === "win32"
      ? folder.toLowerCase()
      : folder;
  }
  same(a: string, b: string) {
    return this.key(a) === this.key(b);
  }
  /** `folder` is `parent` or inside it. */
  within(folder: string, parent: string) {
    const api = this.platform === "win32" ? path.win32 : path.posix;
    const relative = api.relative(this.key(parent), this.key(folder));
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${api.sep}`) &&
        !api.isAbsolute(relative))
    );
  }
  /**
   * The default workspace or a folder inside it, including an isolated
   * space's own workspace on the cloud runner (`<root>/spaces/<id>/workspace`,
   * docs/cloud-sync.md): a Cowork task there works in its own space.
   */
  isDefault(folder: string) {
    const workspace = this.defaultWorkspace();
    const root = this.normalize(this.root) ?? path.resolve(this.root);
    const real = path.join(root, "workspace");
    if (this.within(folder, real) || this.within(folder, workspace))
      return true;
    const api = this.platform === "win32" ? path.win32 : path.posix;
    for (const spaces of [
      path.join(root, "spaces"),
      path.join(this.root, "spaces"),
    ]) {
      if (!this.within(folder, spaces)) continue;
      const [id, inside] = api
        .relative(this.key(spaces), this.key(folder))
        .split(api.sep);
      if (id && inside === "workspace") return true;
    }
    return false;
  }

  /**
   * Reads (or, the first time, creates) the grants. Called when the account
   * starts, so only tasks from before folder permission existed are adopted.
   */
  ensureLoaded(): void {
    this.load();
  }
  trusted(): string[] {
    this.load();
    return [...this.data.trusted];
  }

  /**
   * "Allow" for a task that does not exist yet: the next new Cowork task in
   * this folder (within 15 minutes) may use it, once.
   */
  allowOnce(folder: string): string {
    const real = this.checked(folder);
    this.pending.set(this.key(real), this.now() + pendingGrantMs);
    return real;
  }
  /**
   * Lets the conversation use the folder: as its working folder when it is
   * that, else as a folder added to the task.
   */
  grantConversation(conversation: Conversation, folder: string): string {
    this.load();
    const real = this.checked(folder);
    const primary = conversation.cwd
      ? (this.normalize(conversation.cwd) ?? conversation.cwd)
      : undefined;
    const session: SessionGrant = structuredClone(
      this.session(conversation.id) ?? { extra: [] },
    );
    if (primary && this.same(primary, real)) session.primary = real;
    else if (!session.extra.some((value) => this.same(value, real))) {
      if (session.extra.length >= extraLimit)
        throw new Error(`A task can use up to ${extraLimit} added folders.`);
      session.extra.push(real);
    }
    this.keep(conversation, session);
    return real;
  }
  /** A confirmed folder already inside this remote session's sandbox. */
  grantExecutionConversation(
    conversation: Conversation,
    folder: string,
  ): string {
    const real = this.executionBrowser(conversation).checked(folder);
    const session: SessionGrant = structuredClone(
      this.session(conversation.id) ?? { extra: [] },
    );
    if (!session.extra.includes(real)) {
      if (session.extra.length >= extraLimit)
        throw new Error(`A task can use up to ${extraLimit} added folders.`);
      session.extra.push(real);
    }
    this.keep(conversation, session);
    return real;
  }
  private keep(conversation: Conversation, session: SessionGrant) {
    if (conversation.incognito) {
      this.memorySessions.set(conversation.id, session);
      return;
    }
    this.data.sessions[conversation.id] = session;
    this.save();
  }
  /**
   * A new Cowork task started in `folder`: the one-time grant (if any) becomes
   * the task's. A trusted folder records nothing: removing it from the
   * trusted folders closes it for every task again.
   */
  bind(
    conversation: Conversation,
    folder: string,
    options: { consumeAllow?: boolean } = {},
  ): void {
    this.load();
    const real = this.normalize(folder);
    if (!real || this.isDefault(real)) return;
    // A routine's run binds its own grant: a pending "Allow" stays for the
    // task the person is about to start.
    if (options.consumeAllow !== false) this.pending.delete(this.key(real));
    if (this.data.trusted.some((trusted) => this.within(real, trusted))) return;
    const session = this.session(conversation.id) ?? { extra: [] };
    if (session.primary && this.same(session.primary, real)) return;
    this.keep(conversation, { ...session, primary: real });
  }
  /** Folders the person added to the task (beyond its working folder). */
  extraFolders(conversationId: string): string[] {
    return [...(this.session(conversationId)?.extra ?? [])];
  }
  /** The task was deleted or discarded: its grants go with it. */
  forgetConversation(conversationId: string): void {
    this.load();
    this.memorySessions.delete(conversationId);
    if (this.data.sessions[conversationId]) {
      delete this.data.sessions[conversationId];
      this.save();
    }
  }

  /**
   * "Allow" for a project's folder: the project's tasks may use it (each new
   * Cowork task in the project is given its folders when it starts).
   */
  grantProject(projectId: string, folder: string): string {
    this.load();
    const real = this.checked(folder);
    const projects = { ...(this.data.projects ?? {}) };
    const granted = projects[projectId] ?? [];
    if (!granted.some((value) => this.same(value, real))) {
      if (granted.length >= projectGrantLimit)
        throw new Error(
          `A project can have up to ${projectGrantLimit} folders. Remove one first.`,
        );
      projects[projectId] = [...granted, real];
      this.data.projects = projects;
      this.save();
    }
    return real;
  }
  /** The folders allowed for a project's tasks. */
  projectFolders(projectId: string): string[] {
    this.load();
    return [...(this.data.projects?.[projectId] ?? [])];
  }
  /**
   * A folder left the project (or every folder, without `folder`): the
   * project's new tasks no longer get it. Tasks already started keep theirs.
   */
  releaseProject(projectId: string, folder?: string): void {
    this.load();
    const granted = this.data.projects?.[projectId];
    if (!granted) return;
    const real = folder ? (this.normalize(folder) ?? folder) : undefined;
    const kept = real
      ? granted.filter(
          (value) => !this.same(value, real) && !this.same(value, folder!),
        )
      : [];
    if (kept.length === granted.length) return;
    const projects = { ...this.data.projects };
    if (kept.length) projects[projectId] = kept;
    else delete projects[projectId];
    this.data.projects = projects;
    this.save();
  }
  /**
   * A new Cowork task in a project: the project's other folders that Cowork
   * may still use become the task's added folders. Returns them.
   */
  bindProjectFolders(
    conversation: Conversation,
    projectId: string,
    folders: readonly string[],
  ): string[] {
    const given: string[] = [];
    for (const folder of folders) {
      const access = this.access(folder, conversation.id, projectId);
      if (access.state !== "granted" && access.state !== "trusted") continue;
      try {
        given.push(this.grantConversation(conversation, access.folder));
      } catch {
        // A folder that went away or a full task: the rest still count.
      }
    }
    return given;
  }

  /** "Allow" for a routine: its runs may use the folder unattended. */
  grantRoutine(routineId: string, folder: string): string {
    this.load();
    const real = this.checked(folder);
    this.data.routines[routineId] = real;
    this.save();
    return real;
  }
  /** Whether a routine's unattended run may use its Cowork folder. */
  routineAllowed(routineId: string, folder: string | undefined): boolean {
    this.load();
    if (!folder) return true;
    if (this.isDefault(path.resolve(folder))) return true;
    const real = this.normalize(folder);
    if (!real) return false;
    if (this.isDefault(real)) return true;
    if (this.refusal(real)) return false;
    if (this.data.trusted.some((trusted) => this.within(real, trusted)))
      return true;
    const granted = this.data.routines[routineId];
    return Boolean(granted && this.within(real, granted));
  }
  forgetRoutine(routineId: string): void {
    this.load();
    if (this.data.routines[routineId] === undefined) return;
    delete this.data.routines[routineId];
    this.save();
  }

  /** The folder's real path; refuses folders Cowork may never use. */
  checked(folder: string): string {
    const real = this.normalize(folder);
    if (!real) throw new Error("This folder no longer exists.");
    const reason = this.refusal(real);
    if (reason) throw new Error(reason);
    return real;
  }
}

export interface CoworkFolderGrants {
  refusal: OmitThisParameter<typeof coworkFolderAccess.refusal>;
  load: OmitThisParameter<typeof coworkFolderAccess.load>;
  adopt: OmitThisParameter<typeof coworkFolderAccess.adopt>;
  save: OmitThisParameter<typeof coworkFolderAccess.save>;
  session: OmitThisParameter<typeof coworkFolderAccess.session>;
  pendingFor: OmitThisParameter<typeof coworkFolderAccess.pendingFor>;
  access: OmitThisParameter<typeof coworkFolderAccess.access>;
  trust: OmitThisParameter<typeof coworkFolderAccess.trust>;
  untrust: OmitThisParameter<typeof coworkFolderAccess.untrust>;
}
installMethods(CoworkFolderGrants.prototype, coworkFolderAccess);

const registry = new Map<string, CoworkFolderGrants>();
/**
 * The grants of the account profile at `root` (one instance per profile, so
 * the bridge, the send check and the scheduler share one view).
 */
export function coworkFolderGrants(root: string): CoworkFolderGrants {
  const key = path.resolve(root);
  let grants = registry.get(key);
  if (!grants) {
    grants = new CoworkFolderGrants(key);
    registry.set(key, grants);
  }
  return grants;
}

/**
 * The send check: a Cowork task runs only in its default workspace, a
 * trusted folder, or a folder the person allowed for it. Returns the folder
 * a new task should start in (its real path), if it has one.
 */
export function assertCoworkFolder(
  grants: CoworkFolderGrants,
  input: {
    mode: string;
    conversation?: Conversation;
    cwd?: string;
    /** A new task's project: folders allowed for the project pass. */
    projectId?: string;
  },
): string | undefined {
  const existing = input.conversation;
  if (existing) {
    if (existing.mode !== "cowork" && input.mode !== "cowork") return undefined;
    const folder = existing.cwd ?? grants.defaultWorkspace();
    const access = grants.access(folder, existing.id);
    if (access.state === "refused") throw new Error(access.reason);
    if (access.state === "ask") throw new Error(coworkFolderPermissionMessage);
    return undefined;
  }
  if (input.mode !== "cowork" || !input.cwd) return undefined;
  const access = grants.access(input.cwd, undefined, input.projectId);
  if (access.state === "refused") throw new Error(access.reason);
  if (access.state === "ask") throw new Error(coworkFolderPermissionMessage);
  return access.folder;
}
