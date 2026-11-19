import { isDeepStrictEqual } from "node:util";
import type { StorageCipher } from "../engine/provider-credentials";
import { sessionConnectorPreferenceSnapshot, type SessionConnectorPreference } from "../../shared/session-connector-preference";
import fs from "node:fs";
import { finishTurn } from "../../shared/activity";
import path from "node:path";
import type { Conversation, Project, Settings, Turn } from "../../shared/types";
import { defaultSidebarWidth } from "../../shared/sidebar-layout";
import { sameProjectCreation } from "../../shared/project-creation";
import type { PreparedProjectContext } from "../projects/project-create-context";
export const defaultSettings: Settings = {
  theme: "dark",
  sidebarWidth: defaultSidebarWidth,
  name: "Zecous",
  providers: [
    {
      id: "default",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      protocol: "responses",
      model: "",
      models: [],
    },
  ],
  activeProviderId: "default",
  effort: "high",
  codeEffort: "medium",
  sandbox: "workspace-write",
  codeSandbox: "workspace-write",
  autoAcceptEdits: false,
  codePlanMode: false,
  instructions: "",
  mcpServers: {},
};
/**
 * Earlier versions stored this note as the error of a turn cut off by the app
 * closing; such turns now carry stopReason "restart" instead.
 */
const legacyRestartNote =
  "\u4e0a\u6b21\u5e94\u7528\u5173\u95ed\u65f6\u4efb\u52a1\u88ab\u4e2d\u65ad\uff0c\u53ef\u4ee5\u53d1\u9001\u6d88\u606f\u7ee7\u7eed\u3002";

/** These stores have account owners and no project sharing operation. Migrate
 * only missing metadata; an explicit unknown/non-private value is not a grant
 * to relabel it (Go webstore/store.go listProjects/putProject use user_id). */
export function projectWithVisibility(project: Project): Project {
  return Object.hasOwn(project, "visibility")
    ? project
    : { ...project, visibility: "private" };
}

export function conversationsAfterProjectDeletion(conversations: Conversation[], projectId: string) {
  return conversations.flatMap((conversation) => {
    if (conversation.projectId !== projectId || conversation.projectOrganizationId) return [conversation];
    return conversation.mode === "code" ? [{ ...conversation, projectId: undefined }] : [];
  });
}

/** A local atomic search save failed before publishing the staged values. */
export class WebSearchSaveError extends Error {
  constructor(cause: unknown) {
    super("The web search setting could not be saved. Its previous value is unchanged.", { cause });
  }
}
export type WebSearchPreference = Pick<Conversation, "webSearch" | "research" | "providerId" | "model">;
export type ApiPreferenceUpdate = (settings: Settings) => Pick<Settings, "apiGroups">;
export type ConversationProjectMembership = Pick<Conversation, "projectId" | "projectOrganizationId" | "cwd">;
interface ConversationProjectMove {
  source: string | undefined;
  target: string | undefined;
  outcome: "pending" | "unknown";
}
const pendingProjectDeletionFile = "pending-project-deletion.json";

export class Store {
  settings: Settings;
  conversations: Conversation[];
  projects: Project[];
  /** Local picker choices belong to this account, not synced settings. */
  localFolderGrants: string[];
  private timer?: NodeJS.Timeout;
  private readonly deletingProjects = new Set<string>();
  private readonly projectMoves = new Map<string, ConversationProjectMove>();
  constructor(readonly root: string, private readonly codeEnvironmentCipher?: StorageCipher) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.localFolderGrants = this.read("local-folder-grants.json", []);
    const savedSettings = this.read("settings.json", {});
    this.settings = {
      ...structuredClone(defaultSettings),
      ...savedSettings,
      sidebarWidth:
        Number.isInteger(savedSettings.sidebarWidth) &&
        savedSettings.sidebarWidth >= 188 &&
        savedSettings.sidebarWidth <= 460
          ? savedSettings.sidebarWidth
          : defaultSettings.sidebarWidth,
      codeEffort:
        savedSettings.codeEffort ??
        (["low", "medium", "high", "xhigh", "max"].includes(
          savedSettings.effort,
        )
          ? savedSettings.effort
          : defaultSettings.codeEffort),
      codeSandbox:
        savedSettings.codeSandbox ??
        savedSettings.sandbox ??
        defaultSettings.codeSandbox,
    };
    this.conversations = this.read("conversations.json", []);
    const savedProjects: Project[] = this.read("projects.json", []);
    this.projects = savedProjects.map(projectWithVisibility);
    if (
      this.projects.some((project, index) => project !== savedProjects[index])
    )
      this.write("projects.json", this.projects);
    const pendingDeletion: unknown = this.read(pendingProjectDeletionFile, null);
    if (typeof pendingDeletion === "string") this.finishLocalProjectDeletion(pendingDeletion, true);
    for (const c of this.conversations)
      for (const t of [
        c.turns,
        ...(c.savedBranches ?? []).map((b) => b.turns),
      ].flat())
        if (t.status === "inProgress") {
          // The transcript marks these as stopped by the app closing (R-0742).
          finishTurn(t, "interrupted");
          t.stopReason = "restart";
          delete t.reconnecting;
        } else if (
          t.status === "interrupted" &&
          t.error === legacyRestartNote
        ) {
          t.stopReason = "restart";
          delete t.error;
        }
  }
  private read(name: string, fallback: any) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, name), "utf8"));
    } catch (e: any) {
      if (e.code === "ENOENT") return fallback;
      throw new Error(
        `${name} couldn't be read. To protect your history, the app did not overwrite it.`,
      );
    }
  }
  readCodeSessionEnvironment(): Record<string, Record<string, string>> {
    const encoded: string | undefined = this.read("code-session-environment.json", undefined);
    if (!encoded) return {};
    const cipher = this.codeEnvironmentCipher;
    if (!cipher?.isEncryptionAvailable())
      throw Error("Scoped environment variables are unreadable right now");
    try {
      return JSON.parse(cipher.decryptString(Buffer.from(encoded, "base64")));
    } catch {
      throw Error("Scoped environment variables are unreadable right now");
    }
  }
  codeSessionEnvironmentVariables(scope: string | undefined, includeMachine: boolean) {
    if (!this.codeEnvironmentCipher || (!scope && !includeMachine)) return;
    const values = this.readCodeSessionEnvironment();
    const machine = includeMachine ? values[""] : undefined;
    if (!scope && !machine) return;
    return {
      ...machine,
      ...(scope && Object.hasOwn(values, scope) ? values[scope] : undefined),
    };
  }
  updateCodeSessionEnvironment(change: (values: Record<string, Record<string, string>>) => void) {
    const previous = this.readCodeSessionEnvironment();
    const next = structuredClone(previous);
    change(next);
    if (isDeepStrictEqual(previous, next)) return;
    const cipher = this.codeEnvironmentCipher;
    if (!cipher?.isEncryptionAvailable())
      throw Error("Encryption is unavailable for Code environment variables");
    this.write("code-session-environment.json", cipher.encryptString(JSON.stringify(next)).toString("base64"));
  }
  grantLocalFolders(folders: string[]) {
    const next = [...new Set([...this.localFolderGrants, ...folders])];
    this.write("local-folder-grants.json", next);
    this.localFolderGrants = next;
  }
  write(name: string, value: unknown) {
    const target = path.join(this.root, name);
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, target);
        break;
      } catch (error) {
        if (process.platform !== "win32" || attempt >= 5 ||
            !(error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EBUSY"))) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
      }
    }
  }
  /** Stage session connector maps before the atomic history-file replacement. */
  async persistSessionConnectorPreference(
    conversation: Conversation,
    patch: SessionConnectorPreference,
    current: () => boolean,
  ): Promise<void> {
    const id = conversation.id;
    const incognito = conversation.incognito;
    const before = sessionConnectorPreferenceSnapshot(conversation);
    const staged = structuredClone(patch);
    const check = () => {
      if (!current() || !this.conversations.includes(conversation) ||
          conversation.id !== id || conversation.incognito !== incognito ||
          this.conversations.filter(row => row.id === conversation.id).length !== 1 ||
          sessionConnectorPreferenceSnapshot(conversation) !== before)
        throw new Error("The conversation changed during the connector save. Its outcome may be unknown.");
    };
    check();
    if (!conversation.incognito) {
      const next = { ...conversation, ...staged };
      this.write("conversations.json", this.conversations
        .filter(row => !row.incognito).map(row => row === conversation ? next : row));
    }
    check();
    Object.assign(conversation, staged);
  }
  /** Research owns only these two flags. Commit history before publishing memory. */
  async persistResearchPreference(
    conversation: Conversation,
    enabled: boolean,
    webSearch: boolean | undefined,
    current: () => boolean,
  ): Promise<void> {
    const check = () => {
      if (!current() || !this.conversations.includes(conversation) ||
          this.conversations.filter(item => item.id === conversation.id).length !== 1)
        throw new Error("The conversation changed during this operation.");
    };
    check();
    const next = { ...conversation };
    if (enabled) next.research = true;
    else delete next.research;
    if (webSearch !== undefined) next.webSearch = webSearch;
    if (!conversation.incognito)
      this.write("conversations.json", this.conversations
        .filter(item => !item.incognito).map(item => item === conversation ? next : item));
    check();
    if (enabled) conversation.research = true;
    else delete conversation.research;
    if (webSearch !== undefined) conversation.webSearch = webSearch;
  }
  /** Stage only this preference, so unrelated flush failures cannot publish it. */
  async persistWebSearchPreference(
    conversation: Conversation,
    patch: WebSearchPreference,
    current: () => boolean,
  ): Promise<void> {
    const check = () => {
      if (!current() || !this.conversations.includes(conversation) ||
          this.conversations.filter(item => item.id === conversation.id).length !== 1)
        throw new Error("The conversation changed during this operation.");
    };
    check();
    const next = { ...conversation, ...patch };
    if (patch.research === undefined) delete next.research;
    try {
      if (!conversation.incognito)
        this.write("conversations.json", this.conversations
          .filter(item => !item.incognito).map(item => item === conversation ? next : item));
    } catch (error) { throw new WebSearchSaveError(error); }
    check();
    Object.assign(conversation, patch);
    if (patch.research === undefined) delete conversation.research;
  }
  assertConversationMetadataWritable(id: string) {
    if (this.isProjectMoveUnresolved(id))
      throw Error("The project move outcome is unknown. Reopen the account before changing or deleting this conversation or its project.");
  }
  assertConversationProjectWritable(id: string) {
    this.assertConversationMetadataWritable(id);
    if (this.projectMoves.has(id)) throw Error("This conversation's project move is still in progress.");
  }
  assertProjectDeletionAllowed(id: string) {
    for (const [conversationId, move] of this.projectMoves) {
      if (move.source === id || move.target === id)
        this.assertConversationProjectWritable(conversationId);
    }
  }
  protected isProjectMoveUnresolved(id: string) {
    return this.projectMoves.get(id)?.outcome === "unknown";
  }
  protected reserveConversationProjectMove(conversation: Conversation, target: string | undefined) {
    const id = conversation.id;
    this.assertConversationProjectWritable(id);
    const move: ConversationProjectMove = { source: conversation.projectId, target, outcome: "pending" };
    this.projectMoves.set(id, move);
    return (outcome: "finished" | "unknown") => {
      if (outcome === "unknown") move.outcome = "unknown";
      else this.projectMoves.delete(id);
    };
  }
  async persistConversationProjectMove(
    conversation: Conversation,
    membership: ConversationProjectMembership,
    current: () => boolean,
  ): Promise<void> {
    this.assertConversationProjectWritable(conversation.id);
    if (!current()) throw Error("The conversation or project changed before the move.");
    if (!conversation.incognito) {
      const next = { ...conversation, ...membership };
      this.write("conversations.json", this.conversations
        .filter(row => !row.incognito).map(row => row === conversation ? next : row));
    }
    if (!current()) throw Error("The conversation or project changed during the move.");
    Object.assign(conversation, membership);
  }
  /** Narrow conversation metadata commit. No global flush, retry, or archive effects. */
  async persistChatMetadata(
    conversation: Conversation,
    patch: Pick<Partial<Conversation>, "title" | "pinned" | "titleSetByUser" | "providerId" | "model" | "effort" | "codeUltracode" | "unread" | "readStateRevision" | "thinkingSummariesWanted" | "tokenUsage" | "importedSessionResumePending" | "pullRequests" | "prAutoFixArm" | "prAutoFixOwnPrs">,
    current: () => boolean,
  ): Promise<void> {
    if (!current() || !this.conversations.includes(conversation))
      throw new Error("The account changed during this operation.");
    const next = { ...conversation, ...patch };
    if (!conversation.incognito)
      this.write("conversations.json", this.conversations
        .filter(item => !item.incognito).map(item => item === conversation ? next : item));
    if (!current() || !this.conversations.includes(conversation))
      throw new Error("The save outcome could not be confirmed after the account changed.");
    Object.assign(conversation, patch);
  }
  releaseCoworkDeviceBinding(conversation: Conversation): void {
    const origin = conversation.deviceChatOrigin;
    if (!origin?.active || conversation.mode !== "cowork" || conversation.incognito ||
        !this.conversations.includes(conversation))
      throw Error("This Cowork device binding is no longer available.");
    const next = { ...conversation, deviceChatOrigin: { ...origin, active: false } };
    this.write("conversations.json", this.conversations
      .filter(row => !row.incognito).map(row => row === conversation ? next : row));
    conversation.deviceChatOrigin = next.deviceChatOrigin;
  }
  /** Overridden by stores whose writes require a remote acknowledgement. */
  assertLocalCodeLifecycleAvailable(): void {}
  async persistConversationDeletion(conversation: Conversation, current: () => boolean): Promise<void> {
    if (!current() || !this.conversations.includes(conversation))
      throw Error("The conversation changed before deletion.");
    const remaining = this.conversations.filter(row => row !== conversation);
    if (!conversation.incognito)
      this.write("conversations.json", remaining.filter(row => !row.incognito));
    this.conversations = remaining;
  }
  /** Local Code lifecycle commit: publish only after the one history rename succeeds. */
  commitLocalCodeLifecycle(
    conversation: Conversation,
    archived: boolean | null,
    current: () => boolean,
  ): void {
    this.assertLocalCodeLifecycleAvailable();
    const check = () => {
      if (!current() || !this.conversations.includes(conversation) ||
          this.conversations.filter(row => row.id === conversation.id).length !== 1)
        throw Error("The Code session changed. Its save outcome may be unknown.");
    };
    check();
    const next = { ...conversation, ...(archived === null ? {} : { archived }) };
    if (archived === true) delete next.keepAwake;
    if (archived === false) {
      if (conversation.archived) next.codeAutoArchiveExempt = true;
      if (next.worktree) {
        next.worktree = { ...next.worktree };
        delete next.worktree.state;
        delete next.worktree.archivedBranchTip;
      }
      if (next.additionalWorktrees)
        next.additionalWorktrees = next.additionalWorktrees.map(({ state: _state, archivedBranchTip: _tip, ...tree }) => tree);
    }
    const rows = archived === null
      ? this.conversations.filter(row => row !== conversation)
      : this.conversations.map(row => row === conversation ? next : row);
    if (!conversation.incognito)
      this.write("conversations.json", rows.filter(row => !row.incognito));
    check();
    if (archived === null) this.conversations = rows;
    else {
      if (archived === false && conversation.archived)
        conversation.codeAutoArchiveExempt = true;
      conversation.archived = archived;
      if (archived) delete conversation.keepAwake;
      else {
        if (conversation.worktree) {
          delete conversation.worktree.state;
          delete conversation.worktree.archivedBranchTip;
        }
        for (const tree of conversation.additionalWorktrees ?? []) {
          delete tree.state;
          delete tree.archivedBranchTip;
        }
      }
    }
  }
  /** Stage Code history and its optional child in one atomic history-file write. */
  commitLocalCodeHistory(
    conversation: Conversation,
    patch: Partial<Conversation>,
    addition: Conversation | undefined,
    current: () => boolean,
  ): void {
    this.assertLocalCodeLifecycleAvailable();
    const check = () => {
      if (!current() || !this.conversations.includes(conversation) ||
          this.conversations.filter(row => row.id === conversation.id).length !== 1 ||
          addition && this.conversations.some(row => row.id === addition.id))
        throw Error("The Code history changed. Its save outcome may be unknown.");
    };
    check();
    const next = { ...conversation, ...patch };
    const rows = this.conversations.map(row => row === conversation ? next : row);
    if (addition) rows.unshift(addition);
    if (!conversation.incognito)
      this.write("conversations.json", rows.filter(row => !row.incognito));
    check();
    Object.assign(conversation, patch);
    if (addition) this.conversations.unshift(addition);
  }
  commitImportedConversations(additions: readonly Conversation[], current: () => boolean, projects: readonly Project[] = []): void {
    this.assertLocalCodeLifecycleAvailable();
    const ids = new Set(this.conversations.map((row) => row.id));
    for (const row of additions) {
      if (row.incognito || ids.has(row.id))
        throw Error("The conversation cannot be imported.");
      ids.add(row.id);
    }
    if (!current()) throw Error("The account changed during conversation import.");
    if (!additions.length) return;
    const projectIds = new Set(this.projects.map(project => project.id));
    for (const project of projects) {
      if (projectIds.has(project.id)) throw Error("The project has already been imported.");
      projectIds.add(project.id);
    }
    if (projects.length) this.write("projects.json", [...this.projects, ...projects]);
    try {
      this.write("conversations.json", [...additions, ...this.conversations.filter((row) => !row.incognito)]);
    } catch (error) {
      if (projects.length) this.write("projects.json", this.projects);
      throw error;
    }
    this.projects.push(...projects);
    this.conversations.unshift(...additions);
  }
  /** Confirms an already-flushed mutation; local flush is synchronous. */
  async confirmConversationMetadata(conversation: Conversation, current: () => boolean, _alreadyFlushed = false): Promise<void> {
    if (!current() || !this.conversations.includes(conversation))
      throw new Error("The account changed during this operation. Its outcome may be unknown.");
  }
  async confirmChatFork(source: Conversation, child: Conversation, current: () => boolean): Promise<void> {
    if (!current() || !this.conversations.includes(source) || !this.conversations.includes(child))
      throw Error("The fork save could not be confirmed. Its outcome may be unknown.");
  }
  persistChatLeaf(
    conversation: Conversation,
    next: Conversation,
    current: () => boolean,
  ): void | Promise<void> {
    if (!current() || !this.conversations.includes(conversation))
      throw new Error("The conversation changed before the version was saved.");
    if (conversation === next) return;
    if (!conversation.incognito)
      this.write(
        "conversations.json",
        this.conversations
          .filter((row) => !row.incognito)
          .map((row) => (row === conversation ? next : row)),
      );
    Object.assign(conversation, next);
  }
  persistCodeCompaction(conversation: Conversation, turn: Turn, current: () => boolean): void | Promise<void> {
    this.assertLocalCodeLifecycleAvailable();
    if (!current() || !this.conversations.includes(conversation) || !conversation.turns.includes(turn))
      throw Error("The Code session changed before compaction was saved.");
    this.flush();
  }
  /** Local preference commit; flush writes and renames settings before returning. */
  async persistSkillPreference() { this.flush(); }
  async persistApiPreferences(update: ApiPreferenceUpdate, current: () => boolean) {
    if (!current()) throw Error("The account changed during this operation.");
    const updated = update(this.settings);
    this.write("settings.json", { ...this.settings, ...updated });
    Object.assign(this.settings, updated);
  }
  persistProjectCreation(
    project: Project,
    current: () => boolean,
    prepared?: PreparedProjectContext,
  ): Project | Promise<Project> {
    const before = this.projects;
    try {
      if (!current()) throw Error("The signed-in account changed. Try again.");
      const existing = before.find(row => row.id === project.id);
      if (existing) {
        prepared?.rollback();
        if (!sameProjectCreation(existing, project)) throw Error("This project already exists with different details.");
        return existing;
      }
      prepared?.commit();
      const saved = projectWithVisibility(project);
      this.projects = [...before, saved];
      this.flush();
      return saved;
    } catch (error) {
      this.projects = before;
      prepared?.rollback();
      throw error;
    }
  }
  /** Local project writes have already completed when the IPC handler reaches this check. */
  confirmProjectSave(project: Project, current: () => boolean): void | Promise<void> {
    if (!current() || !this.projects.some(row => row.id === project.id))
      throw Error("The project changed during this save.");
  }
  confirmProjectDeletion(id: string, current: () => boolean): void | Promise<void> {
    if (!current() || this.projects.some((row) => row.id === id))
      throw Error("The project deletion could not be confirmed.");
  }
  isProjectDeleting(id: string) {
    return this.deletingProjects.has(id);
  }
  reserveProjectDeletion(id: string) {
    if (this.deletingProjects.has(id)) throw Error("This project is already being deleted.");
    this.assertProjectDeletionAllowed(id);
    this.deletingProjects.add(id);
    return () => { this.deletingProjects.delete(id); };
  }
  async deleteProjectWithChats(project: Project, current: () => boolean) {
    if (!current() || !this.projects.includes(project))
      throw Error("The project changed during this request.");
    const pending: unknown = this.read(pendingProjectDeletionFile, null);
    if (pending !== null && pending !== project.id) throw Error("Finish the pending project deletion first.");
    this.write(pendingProjectDeletionFile, project.id);
    this.finishLocalProjectDeletion(project.id, false);
  }
  private finishLocalProjectDeletion(id: string, recovering: boolean) {
    const clearPending = () => fs.rmSync(path.join(this.root, pendingProjectDeletionFile), { force: true });
    const projects = this.projects.filter(project => project.id !== id);
    const conversations = conversationsAfterProjectDeletion(this.conversations, id);
    try {
      this.write("conversations.json", conversations.filter(row => !row.incognito));
    } catch (error) {
      if (!recovering) clearPending();
      throw error;
    }
    try {
      this.write("projects.json", projects);
    } catch (error) {
      if (!recovering) {
        this.write("conversations.json", this.conversations.filter(row => !row.incognito));
        clearPending();
      }
      throw error;
    }
    this.conversations = this.conversations.filter(row => row.projectId !== id || row.mode === "code");
    for (const row of this.conversations)
      if (row.projectId === id) row.projectId = undefined;
    this.projects = projects;
    clearPending();
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    // History imports and account/device copies also enter the project list.
    this.projects = this.projects.map(projectWithVisibility);
    this.write("settings.json", this.settings);
    // Incognito chats never reach disk.
    this.write(
      "conversations.json",
      this.conversations.filter((c) => !c.incognito),
    );
    this.write("projects.json", this.projects);
  }
  schedule() {
    if (!this.timer) {
      const save = (retry: boolean) => {
        try { this.flush(); }
        catch (error) {
          console.error("Scheduled store save failed:", error);
          if (retry) this.timer = setTimeout(() => save(false), 750);
        }
      };
      this.timer = setTimeout(() => save(true), 750);
    }
  }
  conversation(id: string) {
    const c = this.conversations.find((c) => c.id === id);
    if (!c) throw new Error("Conversation not found.");
    return c;
  }
}
