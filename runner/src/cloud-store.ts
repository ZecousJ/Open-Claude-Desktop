import { capabilityPreferenceSettings, type OfficialCapabilityPreference } from "../../shared/official-capability-preferences";
import { mcpPolicyIdentity } from "../../shared/mcp-connection-identity";
import { sessionConnectorPreferenceSnapshot, type SessionConnectorPreference } from "../../shared/session-connector-preference";
import { ResearchReports, portableResearchReport, hydrateResearchReports } from "../../electron/ipc/research";
/**
 * CloudStore: the desktop `Store` whose settings, projects and conversations
 * live in the Claudex service's webstore instead of JSON files (web plan §0.3,
 * §2 #1). The runner is the only writer of a user's webstore rows; every
 * write goes over the runner link as a service request.
 *
 * Engine and the IPC handlers keep using the Store they know: the whole
 * account in memory, `flush()` after a change, `schedule()` while a turn
 * streams. CloudStore turns those into row writes:
 *
 * - one row for the settings, one per project, one per conversation (without
 *   its turns, `ConversationDoc`) and one per turn (`TurnDoc`, live and saved
 *   branches), exactly as shared/web-protocol.ts splits them;
 * - only rows that changed since the last write are sent (sha-1 of their
 *   JSON); a streamed `schedule()` only looks at conversations with a turn in
 *   progress, a `flush()` looks at everything;
 * - writes run one batch at a time; a failed row stays changed and is sent
 *   again (5 s, then up to 60 s later, or at the next change);
 * - incognito conversations never leave memory;
 * - a turn over `webLimits.turnDocBytes` (4 MiB) is stored with its longest
 *   texts cut (the live copy in memory keeps everything).
 *
 * Everything else under `root` (codex-home, the Chat workspace, attachments,
 * notes, reply feedback) stays on the runner's own disk, per user.
 *
 * Service requests (bodies and answers; Go's W-STORE implements them):
 *   store.settings.get     {}                                 → {settings: object|null}
 *   store.settings.put     {settings}                         → {}
 *   store.projects.list    {}                                 → {projects: Project[]} (in order)
 *   store.projects.put     {project, position}                → {}
 *   store.projects.delete  {id}                               → {}
 *   store.projects.delete  {id, deleteChats: true}            → {deletedConversationIds: string[]}
 *   store.conversations.list {cursor?}                        → {items: [{doc: ConversationDoc, position}], next?}
 *   store.conversations.get  {id}                             → {doc: ConversationDoc|null, position?}
 *   store.conversations.put  {doc: ConversationDoc, position} → {revision}
 *   store.conversations.delete {id}                           → {} (its turns go too)
 *   store.turns.list       {conversationId, cursor?}          → {turns: TurnDoc[], next?}
 *   store.turns.put        {turns: TurnDoc[]}                 → {revisions, revision?}
 *   store.turns.delete     {conversationId, keys: [{branchId, turnId}]} → {}
 * `position` is the row's index in the sidebar order (0 first).
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { finishTurn } from "../../shared/activity";
import { isAcceptedCodeCompaction } from "../../shared/agent-api";
import type { Conversation, Project, Settings, Turn } from "../../shared/types";
import { sameProjectCreation } from "../../shared/project-creation";
import { hasPreparedProjectContext, type PreparedProjectContext } from "../../electron/projects/project-create-context";
import {
  canDeleteOwnedChatProject,
  isEditablePrivateChatProject,
  ownedProjectCapabilities,
  type ProjectMetadataPatch,
} from "../../shared/project-access";
import { webErrorCodes, webLimits } from "../../shared/web-protocol";
import { anyFolder } from "../../shared/sandbox-policy";
import { type WebRunnerOp } from "../../shared/web-runner-frames";
import {
  codeTurnCancelledBeforeDispatch,
  codeTurnStoppedByUser,
  isOfficialCodeSteer,
  officialCodeEvent,
  officialCodeRepositoryStartup,
} from "../../shared/official-code-followup";
import {
  joinConversation,
  parseConversationDoc,
  parseTurnDoc,
  splitConversation,
  type ConversationDoc,
  type ConversationMeta,
  type TurnDoc,
} from "../../shared/web-docs";
import {
  defaultSettings,
  projectWithVisibility,
  Store,
  type ApiPreferenceUpdate,
  type ConversationProjectMembership,
} from "../../electron/store/store";
import { LinkRequestError } from "./control-link";
import type { HostedCodeRewindPatch } from "../../electron/engine/engine-history";
import { modelFallbackSettings, type ModelFallbackPatch } from "../../shared/official-model-fallback";
import { preference } from "../../shared/settings-extras";
import type { CodeSettingsPatch } from "../../shared/official-code-settings";
import { officialCodeUserSettingsChecksum, type OfficialCodeUserSettings, type OfficialCodeUserSettingsEntries } from "../../shared/official-code-user-settings";

/** How the store reaches webstore (the runner link, or a fake in tests). */
export interface StoreTransport {
  request(op: WebRunnerOp, userId: number, body?: unknown): Promise<unknown>;
}

/** The same restart note Store gives turns cut off by a restart. */
const legacyRestartNote = "上次应用关闭时任务被中断，可以发送消息继续。";
/** Largest body of one turns.put request. */
const batchBytes = 8 * 1024 * 1024;
/** Pages read at most while loading one list. */
const maxPages = 1000;
const truncatedNote = "\n\n[Truncated: too large to store.]";

function hash(text: string) {
  return createHash("sha1").update(text).digest("base64");
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`The Claudex service sent an invalid ${what}.`);
  return value as Record<string, unknown>;
}

/** The saved settings brought to the shape Store's constructor gives them. */
export function normalizeSettings(saved: Record<string, any> | null): Settings {
  const value = saved ?? {};
  return {
    ...structuredClone(defaultSettings),
    ...value,
    sidebarWidth:
      Number.isInteger(value.sidebarWidth) &&
      value.sidebarWidth >= 188 &&
      value.sidebarWidth <= 460
        ? value.sidebarWidth
        : defaultSettings.sidebarWidth,
    codeEffort:
      value.codeEffort ??
      (["low", "medium", "high", "xhigh", "max"].includes(value.effort)
        ? value.effort
        : defaultSettings.codeEffort),
    codeSandbox:
      value.codeSandbox ?? value.sandbox ?? defaultSettings.codeSandbox,
    // Every web session runs in its own sandbox, so the runner confirms
    // every folder for bypass (owner, 2026-10-03). saveSettings stamps it
    // too, but an account that never saved from the web lacked it, and
    // its Code sessions set to full access ran workspace-write and asked
    // for each command outside the sandbox.
    bypassFolders: [anyFolder],
  } as Settings;
}

/** Turns a restart cut off, marked as Store marks them at start. */
export function interruptLeftTurns(conversations: Conversation[], deviceAccountScope?: string) {
  for (const c of conversations) {
    const binding = c.chatDeviceBinding;
    const remoteCowork = c.mode === "cowork" && !c.archived && !c.incognito &&
      binding?.version === 1 && binding.accountScope === deviceAccountScope &&
      binding.organizationId === null;
    for (const t of [
      ...(remoteCowork ? [] : [c.turns]),
      ...(c.savedBranches ?? []).map((b) => b.turns),
    ].flat())
      if (t.status === "inProgress") {
        finishTurn(t, "interrupted");
        t.stopReason = "restart";
        delete t.reconnecting;
      } else if (t.status === "interrupted" && t.error === legacyRestartNote) {
        t.stopReason = "restart";
        delete t.error;
      }
  }
}

function keepPromotedCompactions(turns: Turn[]) {
  const promoted = new Set(turns.flatMap(turn =>
    turn.compaction === "manual" && turn.compactionRequestId && !turn.id.startsWith("pending-")
      ? [turn.compactionRequestId] : []));
  return turns.filter(turn => turn.compaction !== "manual" || !turn.compactionRequestId ||
    !turn.id.startsWith("pending-") || !promoted.has(turn.compactionRequestId));
}

function byteLength(text: string) {
  return Buffer.byteLength(text);
}

/**
 * The turn document as stored: unchanged when it fits, otherwise a copy with
 * the longest strings of its items cut until it does.
 */
export function fitTurnDoc(
  doc: TurnDoc,
  limit: number = webLimits.turnDocBytes,
): { doc: TurnDoc; json: string } {
  let json = JSON.stringify(doc);
  if (byteLength(json) <= limit) return { doc, json };
  const copy = structuredClone(doc);
  // Every string under the items, longest first.
  const leaves: { owner: any; key: string | number; length: number }[] = [];
  const walk = (value: any) => {
    if (Array.isArray(value))
      value.forEach((item, index) => {
        if (typeof item === "string")
          leaves.push({ owner: value, key: index, length: item.length });
        else walk(item);
      });
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === "string" && key !== "id" && key !== "type")
          leaves.push({ owner: value, key, length: item.length });
        else walk(item);
      }
  };
  walk(copy.turn.items);
  leaves.sort((a, b) => b.length - a.length);
  for (const leaf of leaves) {
    const over = byteLength(json) - limit;
    if (over <= 0) break;
    const text: string = leaf.owner[leaf.key];
    // Cut at least the overflow (bytes ≥ characters/4 for UTF-8 worst case).
    const keep = Math.max(0, text.length - over - truncatedNote.length - 64);
    const cut = Math.max(Math.floor(text.length / 2), text.length - keep);
    leaf.owner[leaf.key] =
      text.slice(0, Math.max(0, text.length - cut)) + truncatedNote;
    json = JSON.stringify(copy);
  }
  if (byteLength(json) > limit)
    throw new Error("This reply is too large to store.");
  return { doc: copy, json };
}

type TurnKey = string;
const turnKey = (branchId: string | null, turnId: string): TurnKey =>
  `${branchId ?? ""}|${turnId}`;

interface SyncedConversation {
  meta: string;
  turns: Map<TurnKey, string>;
  /** Turn keys that were in progress at the last write. */
  running: Set<TurnKey>;
  /** Original Web Code user IDs in the acknowledged active transcript. */
  officialCodeEvents?: Set<string>;
  officialCodeStartupEvent?: string;
  officialCodeQueue?: Map<string, string>;
  codeCompactionRequests?: Set<string>;
  acceptedCodeCompactions?: Set<string>;
  latestCompletedCodeTurn?: Pick<Turn, "id" | "createdAt">;
  stoppedCodeTurns?: { conversationCreatedAt: number; turns: Map<string, number> };
}

type CodeMetadataPatch = Pick<Partial<Conversation>, "title" | "titleSetByUser" | "pinned" | "archived" | "keepAwake" | "codeAutoArchiveExempt" | "pullRequests">;
type CoworkModelPatch = Pick<Partial<Conversation>, "model" | "effort">;
type ChatMetadataPatch = Parameters<Store["persistChatMetadata"]>[1];
type ConversationMetadataPatch = CodeMetadataPatch & ChatMetadataPatch;

export interface CloudStoreOptions {
  root: string;
  userId: number;
  transport: StoreTransport;
  /** Conversations loaded at most (the newest first). */
  maxConversations?: number;
  log?: (message: string) => void;
}

interface PendingConversation {
  doc: ConversationDoc;
  position: number;
  loaded?: Promise<Conversation>;
}

export class CloudStore extends Store {
  readonly userId: number;
  /** webstore had no settings: the user's first time on the web. */
  fresh = false;
  private transport: StoreTransport;
  private log: (message: string) => void;
  private synced = {
    settings: "",
    projects: new Map<string, string>(),
    conversations: new Map<string, SyncedConversation>(),
  };
  /** Turn objects already hashed, for streamed writes (identity → hash). */
  private turnHashes = new WeakMap<Turn, string>();
  private running?: Promise<void>;
  private again?: "full" | "partial";
  private retryTimer?: NodeJS.Timeout;
  private streamTimer?: NodeJS.Timeout;
  private failures = 0;
  private closed = false;
  private closing = false;
  /** Explicit row saves share a reservation with background sync. */
  private explicitWrite?: Promise<unknown>;
  private reservedConversation?: Conversation;
  /** Reload from the service before any writer touches an uncertain row again. */
  private uncertainConversationWrites = new Set<string>();
  private uncertainProjectCreations = new Map<string, Project>();
  private uncertainProjectDeletes = new Map<string, Set<string>>();
  private uncertainSettings = false;
  private visibilityMigration = false;
  private researchMigration = false;
  private pendingHistory?: {
    inventory: ReadonlyMap<string, PendingConversation>;
    flush: boolean;
  };

  constructor(options: CloudStoreOptions) {
    super(options.root);
    this.userId = options.userId;
    this.transport = options.transport;
    this.log = options.log ?? ((message) => console.error(message));
    // Nothing of the account comes from the runner's disk.
    this.settings = normalizeSettings(null);
    this.conversations = [];
    this.projects = [];
  }

  /** Opens the user's store: reads everything from webstore first. */
  static async open(
    options: CloudStoreOptions,
    settingsReady?: (settings: Readonly<Settings>) => void,
  ) {
    const store = await CloudStore.openAccount(options, settingsReady);
    await store.loadHistory();
    return store;
  }

  static async openAccount(
    options: CloudStoreOptions,
    settingsReady?: (settings: Readonly<Settings>) => void,
  ) {
    const store = new CloudStore(options);
    await store.loadSettings();
    settingsReady?.(store.settings);
    await store.loadProjects();
    const inventory = await store.loadInventory(options.maxConversations ?? 2000);
    store.pendingHistory = { inventory, flush: false };
    return store;
  }

  get historyLoaded() {
    return this.pendingHistory === undefined;
  }

  conversationInventory(): readonly ConversationMeta[] | undefined {
    if (this.pendingHistory)
      return Array.from(this.pendingHistory.inventory.values(), ({ doc }) => doc.conversation);
  }

  async readConversation(id: string): Promise<Conversation | undefined> {
    if (!this.pendingHistory) return this.conversations.find((conversation) => conversation.id === id);
    const row = this.pendingHistory.inventory.get(id);
    if (row) return this.loadConversation(row);
  }

  private request(op: WebRunnerOp, body?: unknown) {
    return this.transport.request(op, this.userId, body);
  }

  /** Existing send/edit/delete paths resolve through this ownership boundary. */
  override conversation(id: string) {
    this.assertConversationWriteConfirmed(id);
    if (this.explicitWrite && this.reservedConversation?.id === id)
      throw new Error("The conversation change is still pending. Wait for it to finish before continuing this conversation.");
    return super.conversation(id);
  }

  override assertConversationMetadataWritable(id: string) {
    this.assertConversationWriteConfirmed(id);
    super.assertConversationMetadataWritable(id);
  }

  private assertConversationWriteConfirmed(id: string) {
    if (this.uncertainConversationWrites.has(id))
      throw Error("The last conversation update could not be confirmed. Reopen the account to reload it.");
  }

  private async pages(
    op: WebRunnerOp,
    body: Record<string, unknown>,
    field: string,
  ) {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const answer = record(
        await this.request(op, cursor ? { ...body, cursor } : body),
        `${op} answer`,
      );
      const list = answer[field];
      if (!Array.isArray(list))
        throw new Error(`The Claudex service sent an invalid ${op} answer.`);
      items.push(...list);
      if (typeof answer.next !== "string" || !answer.next) return items;
      cursor = answer.next;
    }
    throw new Error(`The Claudex service sent too many ${op} pages.`);
  }

  private async loadSettings() {
    const settingsAnswer = record(
      await this.request("store.settings.get", {}),
      "settings",
    );
    const saved = settingsAnswer.settings;
    this.settings = normalizeSettings(
      saved && typeof saved === "object"
        ? (saved as Record<string, any>)
        : null,
    );
    if (saved && typeof saved === "object")
      this.synced.settings = hash(JSON.stringify(saved));
    else this.fresh = true;
  }

  private async loadProjects() {
    const projects = await this.pages("store.projects.list", {}, "projects");
    this.projects = projects.map((item, position) => {
      const project = record(item, "project") as unknown as Project;
      if (typeof project.id !== "string" || !project.id)
        throw new Error("The Claudex service sent an invalid project.");
      // Hash the service's original document so a migrated visibility value
      // reaches the same account's real projects.put path on the first sync.
      this.synced.projects.set(
        project.id,
        hash(JSON.stringify({ project, position })),
      );
      const normalized = projectWithVisibility(project);
      if (normalized !== project) this.visibilityMigration = true;
      return normalized;
    });
  }

  private async loadInventory(maxConversations: number) {
    const rows = (
      await this.pages("store.conversations.list", {}, "items")
    ).map((item) => {
      const row = record(item, "conversation row");
      return {
        doc: parseConversationDoc(record(row.doc, "conversation")),
        position: typeof row.position === "number" ? row.position : 0,
      };
    });
    rows.sort((a, b) => a.position - b.position);
    const kept = rows.slice(0, maxConversations);
    if (rows.length > kept.length)
      this.log(
        `claudex-runner: user ${this.userId} has ${rows.length} conversations; loaded the first ${kept.length}`,
      );
    return new Map(kept.map(({ doc }, position) => [doc.conversation.id, { doc, position }]));
  }

  async loadHistory() {
    const pending = this.pendingHistory;
    if (!pending) return;
    const kept = Array.from(pending.inventory.values());
    const conversations: Conversation[] = [];
    // A few conversations at a time: the link carries one frame at a time.
    for (let i = 0; i < kept.length; i += 8) {
      conversations.push(...await Promise.all(
        kept.slice(i, i + 8).map((row) => this.loadConversation(row)),
      ));
      if (this.closing) return;
    }
    this.conversations = conversations;
    this.pendingHistory = undefined;
    if (this.visibilityMigration || this.researchMigration) await this.sync("full");
    else if (pending.flush) this.flush();
  }

  private loadConversation(row: PendingConversation): Promise<Conversation> {
    return row.loaded ??= (async () => {
      const { doc, position } = row;
      const turns = (
        await this.pages("store.turns.list", { conversationId: doc.conversation.id }, "turns")
      ).map((item) => parseTurnDoc(record(item, "turn")));
      const conversation = joinConversation(doc, turns);
      // Index what the service stored before normalizing interrupted turns and provisional rows.
      this.synced.conversations.set(
        conversation.id,
        this.describe(conversation, position, "full", undefined, false).state,
      );
      if (hydrateResearchReports(new ResearchReports(this.root), [conversation]))
        this.researchMigration = true;
      conversation.turns = keepPromotedCompactions(conversation.turns);
      for (const branch of conversation.savedBranches ?? [])
        branch.turns = keepPromotedCompactions(branch.turns);
      interruptLeftTurns([conversation], String(this.userId));
      return conversation;
    })();
  }

  /** Hashes of a conversation's rows, and the rows that differ from `before`. */
  private describe(
    conversation: Conversation,
    position: number,
    mode: "full" | "partial",
    before?: SyncedConversation,
    snapshotReports = true,
  ) {
    const { doc, turns } = splitConversation(conversation);
    const meta = hash(JSON.stringify(doc) + "|" + position);
    const state: SyncedConversation = {
      meta,
      turns: new Map(),
      running: new Set(),
    };
    if (doc.conversation.officialCodeQueuedTurns?.length) {
      state.officialCodeQueue = new Map(doc.conversation.officialCodeQueuedTurns.map(turn =>
        [turn.officialCodeEventId ?? "", hash(JSON.stringify(turn))]));
    }
    const startup = officialCodeRepositoryStartup(conversation);
    if (startup && !codeTurnCancelledBeforeDispatch(startup))
      state.officialCodeStartupEvent = startup.officialCodeEventId;
    const latest = conversation.mode === "code" ? conversation.turns.at(-1) : undefined;
    if (latest?.status === "completed" && !latest.id.startsWith("pending-"))
      state.latestCompletedCodeTurn = { id: latest.id, createdAt: latest.createdAt };
    const knownStopped =
      before?.stoppedCodeTurns?.conversationCreatedAt === conversation.createdAt
        ? before.stoppedCodeTurns.turns
        : undefined;
    const changedTurns: { key: TurnKey; doc: TurnDoc; json: string }[] = [];
    for (const row of turns) {
      const key = turnKey(row.branchId, row.turnId);
      const stopped =
        conversation.mode === "code" && row.branchId === null &&
        codeTurnStoppedByUser(row.turn);
      if (stopped) {
        const stateForStops = (state.stoppedCodeTurns ??= {
          conversationCreatedAt: conversation.createdAt,
          turns: new Map(),
        });
        stateForStops.turns.set(row.turnId, row.turn.createdAt);
      }
      if (conversation.mode === "code" && row.turn.compactionRequestId) {
        (state.codeCompactionRequests ??= new Set()).add(row.turn.compactionRequestId);
        if (isAcceptedCodeCompaction(row.turn))
          (state.acceptedCodeCompactions ??= new Set()).add(row.turn.compactionRequestId);
      }
      if (row.branchId === null && (conversation.mode === "code" || conversation.mode === "cowork")) {
        if (row.turn.officialCodeEventId && !row.turn.id.startsWith("pending-"))
          (state.officialCodeEvents ??= new Set()).add(row.turn.officialCodeEventId);
        if (conversation.mode === "code") {
          for (const item of row.turn.items)
            if (isOfficialCodeSteer(item))
              (state.officialCodeEvents ??= new Set()).add(item.officialCodeEventId);
        }
      }
      const inProgress = row.turn.status === "inProgress";
      if (inProgress) state.running.add(key);
      const known = before?.turns.get(key);
      const cached = this.turnHashes.get(row.turn);
      // Streaming: a turn that was done at the last write and is the same
      // object with the same ordinal keeps its hash without being serialised.
      if (
        mode === "partial" &&
        known &&
        cached === known &&
        !inProgress &&
        !before?.running.has(key) &&
        (!stopped || knownStopped?.get(row.turnId) === row.turn.createdAt)
      ) {
        state.turns.set(key, known);
        continue;
      }
      const report = row.turn.research?.report;
      let portable = row;
      if (report && snapshotReports) {
        const { markdown: _unverified, ...metadata } = report;
        let saved = metadata;
        try {
          saved = portableResearchReport(new ResearchReports(this.root), conversation.id, row.turnId, report);
        } catch {
          // Do not send unverified report text to webstore.
        }
        portable = { ...row, turn: { ...row.turn, research: { ...row.turn.research!, report: saved } } };
      }
      const fitted = fitTurnDoc(portable);
      const digest = hash(fitted.json);
      this.turnHashes.set(row.turn, digest);
      state.turns.set(key, digest);
      if (digest !== known)
        changedTurns.push({ key, doc: fitted.doc, json: fitted.json });
    }
    return { doc, state, changedTurns };
  }

  /** Writes to webstore what changed (whole account). */
  override flush() {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    void this.sync("full");
  }
  /** While a turn streams: a write of the running conversations soon. */
  override schedule() {
    if (this.streamTimer || this.closed) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined;
      void this.sync("partial");
    }, 750);
    this.streamTimer.unref?.();
  }
  /** Never writes the account's JSON files on the runner's disk. */
  override write(name: string, value: unknown) {
    if (
      name === "settings.json" ||
      name === "conversations.json" ||
      name === "projects.json"
    )
      return;
    super.write(name, value);
  }

  /** Runs one write batch at a time; a request during one runs after it. */
  sync(mode: "full" | "partial" = "full"): Promise<void> {
    if (this.pendingHistory) {
      this.pendingHistory.flush = true;
      return Promise.resolve();
    }
    if (this.explicitWrite)
      return this.explicitWrite.catch(() => {}).then(() => this.sync(mode));
    if (this.running) {
      this.again = this.again === "full" || mode === "full" ? "full" : mode;
      return this.running;
    }
    this.running = (async () => {
      let next: "full" | "partial" | undefined = mode;
      while (next) {
        this.again = undefined;
        try {
          await this.writeChanges(next);
          this.failures = 0;
        } catch (error) {
          this.failures++;
          this.log(
            `claudex-runner: saving user ${this.userId}'s data failed (${error instanceof Error ? error.message : String(error)}); trying again`,
          );
          this.retryLater();
        }
        next = this.again;
      }
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private retryLater() {
    if (this.retryTimer || this.closed) return;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(4, this.failures - 1));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.sync("full");
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Waits for the writes in flight (and the ones they queued). */
  async settled() {
    while (this.running || this.explicitWrite)
      await Promise.all([this.running, this.explicitWrite?.catch(() => {})]);
  }
  private async reserveExplicitWrite<T>(write: () => Promise<T>): Promise<T> {
    while (this.explicitWrite) await this.explicitWrite.catch(() => {});
    const reservation = Promise.resolve()
      .then(async () => {
        while (this.running) await this.running;
        return write();
      })
      .finally(() => {
        this.explicitWrite = undefined;
      });
    this.explicitWrite = reservation;
    return reservation;
  }

  override async persistConversationProjectMove(
    conversation: Conversation,
    membership: ConversationProjectMembership,
    current: () => boolean,
  ): Promise<void> {
    const id = conversation.id;
    const check = () => {
      if (this.closed || this.closing || !current() || this.uncertainConversationWrites.has(id) ||
          this.isAffectedByUncertainProjectDeletion(id, conversation.projectId))
        throw Error("The conversation or project changed before the move.");
    };
    check();
    if (conversation.incognito) return super.persistConversationProjectMove(conversation, membership, current);
    const release = this.reserveConversationProjectMove(conversation, membership.projectId);
    await this.reserveExplicitWrite(async () => {
      let outcome: "finished" | "unknown" = "finished";
      try {
        check();
        const position = this.conversations.filter(row => !row.incognito).indexOf(conversation);
        const staged = parseConversationDoc(JSON.stringify(splitConversation({ ...conversation, ...membership }).doc));
        const meta = hash(JSON.stringify(staged) + "|" + position);
        outcome = "unknown";
        try {
          const { revision } = record(await this.request("store.conversations.put", { doc: staged, position }), "conversation save");
          if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
            throw Error("The Claudex service sent an invalid conversation revision.");
        } catch (error) {
          if (error instanceof LinkRequestError && (error.code === webErrorCodes.badRequest ||
              error.code === webErrorCodes.tooLarge || error.code === webErrorCodes.quotaExceeded ||
              error.code === webErrorCodes.methodUnavailable)) {
            outcome = "finished";
            throw error;
          }
          check();
          const saved = record(await this.request("store.conversations.get", { id }), "conversation row");
          if (saved.position !== position ||
              !isDeepStrictEqual(parseConversationDoc(record(saved.doc, "conversation")), staged))
            throw Error("The conversation save could not be confirmed.");
        }
        check();
        Object.assign(conversation, membership);
        const previous = this.synced.conversations.get(id);
        this.synced.conversations.set(id, { turns: new Map(), running: new Set(), ...previous, meta });
        outcome = "finished";
      } finally {
        release(outcome);
      }
    });
  }

  async persistProjectMetadata(
    id: string,
    patch: ProjectMetadataPatch,
    current: () => boolean,
  ): Promise<Project | undefined> {
    return this.reserveExplicitWrite(async () => {
      if (this.closed || this.closing || !current()) throw Error("The account changed during this request.");
      if (this.isProjectDeleting(id)) throw Error("This project's deletion is pending.");
      const position = this.projects.findIndex((project) => project.id === id);
      const project = this.projects[position];
      if (!project || !isEditablePrivateChatProject(project) ||
          (patch.instructions !== undefined && !ownedProjectCapabilities(project).canEditInstructions))
        return undefined;
      const next = projectWithVisibility({ ...project, ...patch });
      await this.putProject(next, position);
      const currentPosition = this.projects.indexOf(project);
      if (currentPosition < 0) throw Error("The project changed during this request.");
      this.projects[currentPosition] = next;
      if (!current()) throw Error("The account changed during this request.");
      return structuredClone(next);
    });
  }

  override async persistProjectCreation(
    project: Project,
    current: () => boolean,
    prepared?: PreparedProjectContext,
  ): Promise<Project> {
    let keepContext = false;
    try {
      return await this.reserveExplicitWrite(async () => {
        if (this.closed || this.closing || !current()) throw Error("The account changed during this request.");
        if (this.isProjectDeleting(project.id)) throw Error("This project's deletion is pending.");
        let existing = this.projects.find(row => row.id === project.id);
        const unconfirmed = this.uncertainProjectCreations.get(project.id);
        if (!existing && unconfirmed) {
          const projects = await this.pages("store.projects.list", {}, "projects");
          const persisted = projects.find(row => record(row, "project").id === project.id) as Project | undefined;
          if (persisted) {
            existing = projectWithVisibility(persisted);
            this.projects.push(existing);
            this.uncertainProjectCreations.delete(project.id);
          }
          if (!current()) throw Error("The account changed during this request.");
          if (!existing && !sameProjectCreation(unconfirmed, project))
            throw Error("The original project save is unconfirmed. Check the project list before changing its details.");
        }
        if (existing) {
          if (!sameProjectCreation(existing, project)) throw Error("This project already exists with different details.");
          return structuredClone(existing);
        }
        const saved = unconfirmed ?? projectWithVisibility(project);
        const resumingContext = hasPreparedProjectContext(this.root, project.id);
        if (!prepared && resumingContext)
          throw Error("Retry with the original project files or start a new project.");
        prepared?.commit(true);
        try {
          await this.putProject(saved, this.projects.length);
        } catch (error) {
          if (unconfirmed || resumingContext || error instanceof LinkRequestError &&
              (error.code === webErrorCodes.runnerUnavailable || error.code === webErrorCodes.timeout ||
               error.code === webErrorCodes.handlerFailed)) {
            this.uncertainProjectCreations.set(project.id, saved);
            keepContext = true;
          }
          throw Error("The project save could not be confirmed. Check the project list before trying again.");
        }
        keepContext = true;
        this.uncertainProjectCreations.delete(project.id);
        this.projects.push(saved);
        if (!current()) throw Error("The account changed during this request.");
        return structuredClone(saved);
      });
    } finally {
      if (!keepContext) prepared?.rollback();
    }
  }
  override async confirmProjectSave(project: Project, current: () => boolean): Promise<void> {
    await this.sync("full");
    await this.settled();
    if (!current()) throw Error("The account changed during this request.");
    const position = this.projects.findIndex(row => row.id === project.id);
    const saved = this.projects[position];
    if (this.isProjectDeleting(project.id) || !saved || JSON.stringify(saved) !== JSON.stringify(projectWithVisibility(project)) ||
        this.synced.projects.get(saved.id) !== hash(JSON.stringify({ project: saved, position })))
      throw Error("The project save could not be confirmed. Check the project list before trying again.");
  }
  override async confirmProjectDeletion(id: string, current: () => boolean): Promise<void> {
    await this.sync("full");
    await this.settled();
    super.confirmProjectDeletion(id, current);
    if (this.uncertainProjectDeletes.has(id) || this.synced.projects.has(id))
      throw Error("The project deletion could not be confirmed.");
  }

  override isProjectDeleting(id: string): boolean {
    return super.isProjectDeleting(id) || this.uncertainProjectDeletes.has(id);
  }

  override async deleteProjectWithChats(project: Project, current: () => boolean): Promise<void> {
    const { id } = project;
    const check = () => {
      if (this.closed || this.closing || !current())
        throw new Error("The account changed during this request.");
      if (!this.projects.includes(project) || !canDeleteOwnedChatProject(project))
        throw new Error("The project changed during this request.");
    };
    check();
    await this.reserveExplicitWrite(async () => {
      check();
      const uncertain = this.uncertainProjectDeletes.get(id);
      if (!uncertain) {
        await this.writeChanges("full");
        check();
      }
      const affected = uncertain ?? new Set<string>();
      for (const row of this.conversations) {
        if (row.projectId === id && !row.projectOrganizationId) affected.add(row.id);
      }
      this.uncertainProjectDeletes.set(id, affected);

      let deletedIds: Set<string>;
      try {
        const answer = record(await this.request("store.projects.delete", { id, deleteChats: true }), "project deletion");
        const ids = answer.deletedConversationIds;
        if (!Array.isArray(ids) || !ids.every((value): value is string => typeof value === "string" && value.length > 0))
          throw new Error("The Claudex service sent an invalid project deletion.");
        deletedIds = new Set(ids);
      } catch (cause) {
        throw new Error("The project deletion could not be confirmed. Retry deleting the project or reopen the account.", { cause });
      }
      check();
      for (const row of this.conversations) {
        if (row.projectOrganizationId) continue;
        if (row.mode === "code") {
          if (row.projectId === id) delete row.projectId;
        } else if (row.projectId === id || affected.has(row.id)) {
          deletedIds.add(row.id);
        }
      }
      this.conversations = this.conversations.filter(row => !deletedIds.has(row.id));
      this.projects = this.projects.filter(row => row !== project);
      this.synced.projects.delete(id);
      for (const conversationId of deletedIds) {
        this.synced.conversations.delete(conversationId);
        this.uncertainConversationWrites.delete(conversationId);
      }
      this.uncertainProjectDeletes.delete(id);
    });
  }

  private isAffectedByUncertainProjectDeletion(id: string, projectId?: string): boolean {
    if (projectId && this.uncertainProjectDeletes.has(projectId)) return true;
    for (const affected of this.uncertainProjectDeletes.values()) {
      if (affected.has(id)) return true;
    }
    return false;
  }
  /** Stage session connector metadata under the same writer exclusion as Research and sync. */
  override async persistSessionConnectorPreference(
    conversation: Conversation,
    patch: SessionConnectorPreference,
    current: () => boolean,
  ): Promise<void> {
    // Capture at invocation, not after waiting: a queued stale patch must never
    // overwrite another request's acknowledged preference.
    const id = conversation.id;
    const incognito = conversation.incognito;
    const before = sessionConnectorPreferenceSnapshot(conversation);
    const stagedPatch = structuredClone(patch);
    const check = () => {
      this.assertConversationMetadataWritable(id);
      if (this.closed || this.closing || !current() ||
          this.uncertainConversationWrites.has(conversation.id) ||
          this.isAffectedByUncertainProjectDeletion(conversation.id, conversation.projectId) ||
          !this.conversations.includes(conversation) ||
          conversation.id !== id || conversation.incognito !== incognito ||
          this.conversations.filter(row => row.id === conversation.id).length !== 1 ||
          sessionConnectorPreferenceSnapshot(conversation) !== before)
        throw new Error("The conversation changed during the connector save. Its outcome may be unknown.");
    };
    check();
    while (this.explicitWrite) {
      await this.explicitWrite.catch(() => {});
      check();
    }
    const operation = (async () => {
      // Install the shared reservation before transport or a reentrant flush.
      await Promise.resolve();
      while (this.running) await this.running;
      check();
      if (conversation.incognito) {
        Object.assign(conversation, stagedPatch);
        return;
      }
      if (this.failures)
        throw new Error("Connectors could not be saved because an earlier history save failed.");
      const position = this.conversations.filter(row => !row.incognito).indexOf(conversation);
      const { doc } = splitConversation({ ...conversation, ...stagedPatch });
      const staged = JSON.parse(JSON.stringify(doc)) as ConversationDoc;
      const meta = hash(JSON.stringify(staged) + "|" + position);
      try {
        await this.putConversation(staged, position);
        check();
      } catch (cause) {
        // The service may have committed even if its acknowledgement was lost.
        // Quarantine prevents background replay, deletion, or Research overwrite.
        this.uncertainConversationWrites.add(id);
        throw new Error("The connector save could not be confirmed. Its outcome is unknown. Reopen the account to reload this conversation before saving again; do not retry automatically.", { cause });
      }
      Object.assign(conversation, stagedPatch);
      const previous = this.synced.conversations.get(conversation.id);
      this.synced.conversations.set(conversation.id, {
        turns: new Map(), running: new Set(), ...previous, meta,
      });
    })();
    const reservation = operation.finally(() => {
      if (this.explicitWrite === reservation) {
        this.explicitWrite = undefined;
        this.reservedConversation = undefined;
      }
    });
    this.reservedConversation = conversation;
    this.explicitWrite = reservation;
    return reservation;
  }
  /** Stage one Research metadata row under the same writer exclusion as sync. */
  override async persistResearchPreference(
    conversation: Conversation,
    enabled: boolean,
    webSearch: boolean | undefined,
    current: () => boolean,
  ): Promise<void> {
    if (this.explicitWrite) {
      await this.explicitWrite.catch(() => {});
      return this.persistResearchPreference(conversation, enabled, webSearch, current);
    }
    const check = () => {
      this.assertConversationMetadataWritable(conversation.id);
      if (this.closed || this.closing || !current() ||
          this.uncertainConversationWrites.has(conversation.id) ||
          this.isAffectedByUncertainProjectDeletion(conversation.id, conversation.projectId) ||
          !this.conversations.includes(conversation) ||
          this.conversations.filter(item => item.id === conversation.id).length !== 1)
        throw new Error("The conversation changed during this operation. Its save outcome may be unknown.");
    };
    check();
    const operation = (async () => {
      // Publish the reservation before transport or a reentrant sync can run.
      await Promise.resolve();
      // Do not await settled(): it includes this reservation. Existing batches
      // drain their already-queued work; new sync/flush/retry calls wait above.
      while (this.running) await this.running;
      check();
      if (this.failures)
        throw new Error("Research could not be saved because an earlier history save failed.");
      const beforeResearch = conversation.research;
      const beforeWebSearch = conversation.webSearch;
      const next = { ...conversation };
      if (enabled) next.research = true;
      else delete next.research;
      if (webSearch !== undefined) next.webSearch = webSearch;
      if (conversation.incognito) {
        check();
        if (enabled) conversation.research = true;
        else delete conversation.research;
        if (webSearch !== undefined) conversation.webSearch = webSearch;
        return;
      }
      const position = this.conversations.filter(item => !item.incognito).indexOf(conversation);
      const { doc } = splitConversation(next);
      // Freeze the exact request, including nested metadata, before yielding.
      const staged = JSON.parse(JSON.stringify(doc)) as ConversationDoc;
      const meta = hash(JSON.stringify(staged) + "|" + position);
      try {
        await this.putConversation(staged, position);
      } catch {
        // A rejected transport may have lost an acknowledgement after commit.
        // No live candidate, rollback, retry timer, or replay is installed.
        this.uncertainConversationWrites.add(conversation.id);
        throw new Error("The Research save could not be confirmed. Its outcome is unknown. Reopen the account to reload this conversation before saving it again; do not retry automatically.");
      }
      try {
        check();
        if (conversation.research !== beforeResearch || conversation.webSearch !== beforeWebSearch)
          throw new Error("Research changed during the save.");
      } catch {
        this.uncertainConversationWrites.add(conversation.id);
        throw new Error("The Research save belongs to a changed conversation. Its outcome is unknown. Reopen the account to reload it before saving again; do not retry automatically.");
      }
      if (enabled) conversation.research = true;
      else delete conversation.research;
      if (webSearch !== undefined) conversation.webSearch = webSearch;
      // Preserve turn acknowledgements. A concurrent title/project/branch edit
      // remains dirty against the exact staged metadata hash and syncs normally.
      const previous = this.synced.conversations.get(conversation.id);
      this.synced.conversations.set(conversation.id, {
        turns: new Map(), running: new Set(), ...previous, meta,
      });
    })();
    const reservation = operation.finally(() => {
      if (this.explicitWrite === reservation) {
        this.explicitWrite = undefined;
        this.reservedConversation = undefined;
      }
    });
    this.reservedConversation = conversation;
    this.explicitWrite = reservation;
    return reservation;
  }
  assertConnectorSettingsWritable() {
    if (this.uncertainSettings)
      throw Error("A settings save has an unknown outcome. Reopen the account before changing settings.");
  }

  async persistConnectorSettings(servers: Record<string, unknown>, current: () => boolean): Promise<void> {
    const before = mcpPolicyIdentity(this.settings.mcpServers);
    const next = structuredClone(servers);
    const check = () => {
      this.assertConnectorSettingsWritable();
      if (this.closed || this.closing || !current() ||
          mcpPolicyIdentity(this.settings.mcpServers) !== before)
        throw Error("The account or connector configuration changed during this request.");
    };
    check();
    while (this.explicitWrite) { await this.explicitWrite.catch(() => {}); check(); }
    const operation = (async () => {
      await Promise.resolve();
      while (this.running) await this.running;
      check();
      const staged = JSON.parse(JSON.stringify({ ...this.settings, mcpServers: next })) as Settings;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.request("store.settings.put", { settings: staged }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error("The connector settings save timed out.")), 15_000);
            timer.unref?.();
          }),
        ]);
        check();
      } catch (cause) {
        this.uncertainSettings = true;
        throw new Error("The connector settings save could not be confirmed. Its outcome is unknown. Reopen the account before saving again; do not retry automatically.", { cause });
      } finally { clearTimeout(timer); }
      this.settings.mcpServers = next;
      this.synced.settings = hash(JSON.stringify(staged));
    })();
    const reservation = operation.finally(() => {
      if (this.explicitWrite === reservation) this.explicitWrite = undefined;
    });
    this.explicitWrite = reservation;
    return reservation;
  }

  async persistCodeSettings(patch: CodeSettingsPatch, current: () => boolean) {
    return this.persistOfficialSettings(() => patch, current);
  }

  async persistModelFallback(change: ModelFallbackPatch, current: () => boolean) {
    return this.persistOfficialSettings(() => {
      if (change.kind === "code" && (preference(this.settings, "modelAutoFallback") !== change.companion ||
          (change.toolSearchCompanion !== undefined &&
           (preference(this.settings, "toolAccessMode") === "loaded" ? "off" : "on") !== change.toolSearchCompanion)))
        return undefined;
      return modelFallbackSettings(change);
    }, current);
  }

  async persistCapabilityPreference(change: OfficialCapabilityPreference, current: () => boolean) {
    return this.persistOfficialSettings(() => {
      if ("preview_feature_uses_artifacts" in change && !("enabled_monkeys_in_a_barrel" in change) && !change.preview_feature_uses_artifacts && preference(this.settings, "chatExecution")) return undefined;
      return capabilityPreferenceSettings(change);
    }, current);
  }

  async persistCodeUserSettings(entries: OfficialCodeUserSettingsEntries, ifMatch: string | undefined, current: () => boolean) {
    let row: OfficialCodeUserSettings | undefined;
    let matched = true;
    await this.persistOfficialSettings(() => {
      row = this.settings.officialCodeUserSettings;
      matched = ifMatch === undefined || ifMatch === officialCodeUserSettingsChecksum(row);
      if (!matched) return;
      const merged = { ...row?.entries, ...entries };
      if (isDeepStrictEqual(merged, row?.entries ?? {})) return;
      row = { entries: merged, revision: (row?.revision ?? 0) + 1 };
      return { officialCodeUserSettings: row };
    }, current);
    return { matched, row };
  }

  private async persistOfficialSettings(
    select: () => Partial<Settings> | undefined,
    current: () => boolean,
  ) {
    let saved = false;
    await this.reserveExplicitWrite(async () => {
      if (this.closed || this.closing || this.uncertainSettings || !current())
        throw Error("The account's settings cannot be saved.");
      const patch = select();
      if (!patch) return;
      const staged = JSON.stringify({ ...this.settings, ...patch });
      try {
        await this.request("store.settings.put", { settings: JSON.parse(staged) });
        if (!current()) throw Error("The account activation changed.");
      } catch (error) {
        if (!(error instanceof LinkRequestError &&
            (error.code === webErrorCodes.badRequest || error.code === webErrorCodes.tooLarge ||
             error.code === webErrorCodes.quotaExceeded || error.code === webErrorCodes.methodUnavailable)))
          this.uncertainSettings = true;
        throw error;
      }
      this.settings = { ...this.settings, ...patch };
      this.synced.settings = hash(staged);
      saved = true;
    });
    return saved;
  }

  /** Internal acknowledgement contract; does not grant any settings mutation. */
  private static async confirmSettings(store: CloudStore, label: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await store.sync("full");
          await store.settled();
          // A later successful partial batch may reset the global failure count
          // without writing settings. Require the actual service-acknowledged digest.
          if (store.uncertainSettings || store.failures || store.synced.settings !== hash(JSON.stringify(store.settings)))
            throw new Error(`The ${label} save could not be confirmed.`);
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`The ${label} save confirmation timed out; its outcome is unknown.`)), 15_000);
          timer.unref?.();
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  /** Preserve the runner's remote writer and post-reload confirmation contract. */
  override async persistWebSearchPreference(
    conversation: Conversation,
    patch: import("../../electron/store/store").WebSearchPreference,
    current: () => boolean,
  ): Promise<void> {
    this.assertConversationMetadataWritable(conversation.id);
    if (!current() || !this.conversations.includes(conversation))
      throw new Error("The conversation changed during this operation.");
    Object.assign(conversation, patch);
    if (patch.research === undefined) delete conversation.research;
    this.flush();
  }
  // A local-file commit is not an acknowledgement from the service.
  override assertLocalCodeLifecycleAvailable(): never {
    throw Error("Local Code lifecycle changes are unavailable on the cloud store.");
  }
  /** Confirm the accepted dispatch in the persisted turn, including after a reload. */
  async confirmOfficialCodeCompaction(conversation: Conversation, requestId: string, current: () => boolean) {
    const check = () => {
      this.assertConversationMetadataWritable(conversation.id);
      if (this.closed || this.closing || !current() || !this.conversations.includes(conversation) ||
          this.isAffectedByUncertainProjectDeletion(conversation.id, conversation.projectId) ||
          ![...conversation.turns, ...(conversation.savedBranches ?? []).flatMap(branch => branch.turns)]
            .some(turn => turn.compactionRequestId === requestId && isAcceptedCodeCompaction(turn)))
        throw Error("The Cloud Code compaction outcome could not be confirmed.");
    };
    const confirmed = () => this.synced.conversations.get(conversation.id)?.acceptedCodeCompactions?.has(requestId);
    check();
    if (confirmed()) return;
    await this.awaitHistorySave();
    check();
    if (!confirmed()) throw Error("The Code compaction save was not acknowledged.");
  }

  /** Confirm this exact Chat metadata row, not a successful unrelated write batch. */
  override async persistChatMetadata(
    conversation: Conversation,
    patch: ChatMetadataPatch,
    current: () => boolean,
  ): Promise<void> {
    this.assertConversationMetadataWritable(conversation.id);
    if (!current() || !this.conversations.includes(conversation))
      throw new Error("The account changed during this operation. Its save outcome may be unknown.");
    if (patch.codeUltracode !== undefined || "pullRequests" in patch || "prAutoFixArm" in patch || "prAutoFixOwnPrs" in patch) {
      await this.commitConversationMutation(conversation, patch, current);
      return;
    }
    Object.assign(conversation, patch);
    await this.confirmConversationMetadata(conversation, current);
  }

  override async persistConversationDeletion(conversation: Conversation, current: () => boolean): Promise<void> {
    if (conversation.incognito) return super.persistConversationDeletion(conversation, current);
    await this.commitConversationMutation(conversation, null, current);
  }

  async commitOfficialCodeMutation(
    conversation: Conversation,
    update: CodeMetadataPatch | (() => CodeMetadataPatch) | null,
    current: () => boolean,
  ): Promise<boolean> {
    return this.commitConversationMutation(conversation, update, current);
  }

  async commitCoworkModelPreference(conversation: Conversation, patch: CoworkModelPatch, current: () => boolean) {
    return this.commitConversationMutation(conversation, patch, current);
  }

  private async commitConversationMutation(
    conversation: Conversation,
    update: ConversationMetadataPatch | (() => ConversationMetadataPatch) | null,
    current: () => boolean,
  ): Promise<boolean> {
    const { id } = conversation;
    const check = () => {
      this.assertConversationProjectWritable(id);
      if (this.closed || this.closing || this.uncertainConversationWrites.has(id) ||
          this.isAffectedByUncertainProjectDeletion(id, conversation.projectId) ||
          !current())
        throw Error("The session changed during the save.");
    };
    check();
    return this.reserveExplicitWrite(async () => {
      check();
      const patch = typeof update === "function" ? update() : update;
      const fields = patch ? Object.keys(patch) as (keyof ConversationMetadataPatch)[] : [];
      if (patch && fields.every(key => conversation[key] === patch[key])) return false;
      const before = fields.map(key => conversation[key]);
      const position = this.conversations.filter(row => !row.incognito).indexOf(conversation);
      const doc = patch ? parseConversationDoc(JSON.stringify(splitConversation({ ...conversation, ...patch }).doc)) : null;
      const lifecycle = patch === null || patch.archived !== undefined;
      if (lifecycle) this.reservedConversation = conversation;
      try {
        try {
          if (doc) await this.putConversation(doc, position);
          else await this.request("store.conversations.delete", { id });
        } catch (cause) {
          if (cause instanceof LinkRequestError && [webErrorCodes.badRequest, webErrorCodes.tooLarge,
            webErrorCodes.quotaExceeded, webErrorCodes.methodUnavailable].some(code => code === cause.code))
            throw cause;
          try {
            check();
            const saved = record(await this.request("store.conversations.get", { id }), "conversation row");
            const confirmed = doc
              ? saved.position === position && isDeepStrictEqual(parseConversationDoc(record(saved.doc, "conversation")), doc)
              : saved.doc === null;
            if (!confirmed) throw cause;
          } catch (error) {
            this.uncertainConversationWrites.add(id);
            throw Error("The session change could not be confirmed.", { cause: error });
          }
        }
        try {
          check();
        } catch (error) {
          this.uncertainConversationWrites.add(id);
          throw error;
        }
        if (!doc || !patch) {
          this.conversations = this.conversations.filter(row => row !== conversation);
          this.synced.conversations.delete(id);
          return true;
        }
        const staged = JSON.stringify(doc);
        this.synced.conversations.set(id, {
          turns: new Map(), running: new Set(), ...this.synced.conversations.get(id),
          meta: hash(staged + "|" + position),
        });
        if (fields.some((key, index) => conversation[key] !== before[index] && conversation[key] !== patch[key]))
          throw Error("A newer Code session change replaced this save.");
        Object.assign(conversation, patch);
        if ("keepAwake" in patch) delete conversation.keepAwake;
        return true;
      } finally {
        if (lifecycle) this.reservedConversation = undefined;
      }
    });
  }

  async commitHostedCodeRewind(
    conversation: Conversation,
    patch: HostedCodeRewindPatch,
    targetIndex: number,
    current: () => boolean,
  ) {
    const { id } = conversation;
    const check = () => {
      this.assertConversationProjectWritable(id);
      if (this.closed || this.closing || this.uncertainConversationWrites.has(id) ||
          this.isAffectedByUncertainProjectDeletion(id, conversation.projectId) || !current())
        throw Error("The Code session changed during rewind.");
    };
    check();
    await this.awaitHistorySave();
    await this.reserveExplicitWrite(async () => {
      check();
      const targetTurnId = conversation.turns[targetIndex]?.id;
      const position = this.conversations.filter(row => !row.incognito).indexOf(conversation);
      const before = this.synced.conversations.get(id);
      const active = this.describe(conversation, position, "full", before);
      if (!targetTurnId || !before || position < 0 || active.state.meta !== before.meta ||
          active.changedTurns.length || active.state.turns.size !== before.turns.size)
        throw Error("The current Code history has not been saved.");
      const { doc, state, changedTurns } = this.describe({ ...conversation, ...patch }, position, "full", before);
      const retained = changedTurns.find(row => row.doc.branchId === null && row.doc.ordinal === targetIndex)?.doc;
      this.reservedConversation = conversation;
      try {
        await this.request("store.conversations.rewind", {
          doc, position, keep: targetIndex, targetTurnId,
          ...(retained ? { retained } : {}),
        });
        check();
        Object.assign(conversation, patch);
        this.synced.conversations.set(id, state);
      } catch (cause) {
        this.uncertainConversationWrites.add(id);
        throw Error("The Code rewind save could not be confirmed.", { cause });
      } finally {
        this.reservedConversation = undefined;
      }
    });
  }

  /** Confirm an existing mutation without changing/replaying its side effects. */
  override async confirmConversationMetadata(conversation: Conversation, current: () => boolean, alreadyFlushed = false): Promise<void> {
    const check = () => {
      this.assertConversationMetadataWritable(conversation.id);
      if (this.isAffectedByUncertainProjectDeletion(conversation.id, conversation.projectId))
        throw new Error("This conversation's project deletion is pending.");
      if (!current() || !this.conversations.includes(conversation))
        throw new Error("The account changed during this operation. Its save outcome may be unknown.");
    };
    check();
    if (conversation.incognito) return;
    const position = this.conversations.filter(c => !c.incognito).indexOf(conversation);
    const expected = this.describe(conversation, position, "full").state.meta;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          if (alreadyFlushed) await this.running;
          else await this.sync("full");
          check();
          await this.settled();
          check();
          const nowPosition = this.conversations.filter(c => !c.incognito).indexOf(conversation);
          if (this.describe(conversation, nowPosition, "full").state.meta !== expected ||
              this.synced.conversations.get(conversation.id)?.meta !== expected)
            throw new Error("The conversation save could not be confirmed. Its outcome may be unknown; do not retry automatically.");
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("The conversation save confirmation timed out; its outcome is unknown.")), 15_000);
          timer.unref?.();
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    // Do not roll back an uncertain service write or replay the action. Existing
    // Store background persistence retains its original independent retry policy.
  }

  override async confirmChatFork(source: Conversation, child: Conversation, current: () => boolean): Promise<void> {
    const check = () => {
      if (this.closed || this.closing || !current() ||
          !this.conversations.includes(source) || !this.conversations.includes(child))
        throw Error("The fork save could not be confirmed. Its outcome may be unknown.");
      this.assertConversationMetadataWritable(source.id);
      this.assertConversationMetadataWritable(child.id);
    };
    check();
    const describe = (conversation: Conversation) => {
      const position = this.conversations.filter(row => !row.incognito).indexOf(conversation);
      return this.describe(conversation, position, "full").state;
    };
    const sourceState = describe(source);
    const childState = describe(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.running;
          await this.settled();
          check();
          const sourceSaved = this.synced.conversations.get(source.id);
          const childSaved = this.synced.conversations.get(child.id);
          if (describe(source).meta !== sourceState.meta ||
              describe(child).meta !== childState.meta ||
              !isDeepStrictEqual(describe(child).turns, childState.turns) ||
              sourceSaved?.meta !== sourceState.meta || childSaved?.meta !== childState.meta ||
              !isDeepStrictEqual(childSaved?.turns, childState.turns))
            throw Error("The fork save could not be confirmed. Its outcome may be unknown.");
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error("The fork save confirmation timed out. Its outcome is unknown.")), 15_000);
          timer.unref?.();
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  override async persistChatLeaf(
    conversation: Conversation,
    next: Conversation,
    current: () => boolean,
  ): Promise<void> {
    this.assertConversationMetadataWritable(conversation.id);
    if (
      !current() || this.closed || this.closing ||
      !this.conversations.includes(conversation) ||
      this.isAffectedByUncertainProjectDeletion(conversation.id, conversation.projectId)
    )
      throw new Error("The conversation changed before the version was saved.");
    const selected = next.turns;
    if (next !== conversation) Object.assign(conversation, next);
    const stillSelected = () => current() && conversation.turns === selected;
    await this.confirmConversationMetadata(conversation, stillSelected);
    if (conversation.incognito) return;
    const position = this.conversations.filter(c => !c.incognito).indexOf(conversation);
    const saved = this.synced.conversations.get(conversation.id);
    if (
      !stillSelected() || !saved ||
      !isDeepStrictEqual(this.describe(conversation, position, "full").state.turns, saved.turns)
    )
      throw new Error("The selected version could not be confirmed. Reopen the conversation.");
  }
  /** Confirm one exact queued event even as the active turn changes other metadata. */
  async confirmOfficialCodeQueue(conversation: Conversation, eventId: string, current: () => boolean) {
    const entry = () => conversation.officialCodeQueuedTurns?.find(turn => turn.officialCodeEventId === eventId);
    const value = entry();
    const expected = value ? hash(JSON.stringify(value)) : undefined;
    const check = () => {
      const latest = entry();
      if (this.closed || !current() || !this.conversations.includes(conversation) ||
          (latest ? hash(JSON.stringify(latest)) : undefined) !== expected)
        throw Error("The queued Code message changed.");
    };
    check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.sync("full").then(() => this.settled()),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error("The queued Code save timed out.")), 15_000); timer.unref?.(); }),
      ]);
      check();
      const synced = this.synced.conversations.get(conversation.id);
      const position = this.conversations.filter(row => !row.incognito).indexOf(conversation);
      const acknowledged = synced?.officialCodeQueue?.get(eventId) === expected;
      const metadata = this.describe(conversation, position, "full", synced).state.meta;
      if (!synced || (!acknowledged && synced.meta !== metadata))
        throw Error("The queued Code message was not acknowledged.");
    } finally { if (timer) clearTimeout(timer); }
  }

  hasConfirmedOfficialCodeEvent(conversation: Conversation, eventId: string) {
    return this.synced.conversations.get(conversation.id)?.officialCodeEvents?.has(eventId) === true;
  }

  hasConfirmedOfficialCodeStartup(conversation: Conversation, eventId: string) {
    return this.synced.conversations.get(conversation.id)?.officialCodeStartupEvent === eventId;
  }

  async confirmOfficialCodeStartup(
    conversation: Conversation,
    eventId: string,
    current: () => boolean,
  ) {
    const check = () => {
      const turn = officialCodeRepositoryStartup(conversation);
      if (this.closed || !current() || !this.conversations.includes(conversation) ||
          turn?.officialCodeEventId !== eventId || codeTurnCancelledBeforeDispatch(turn))
        throw Error("The Code repository startup could not be confirmed.");
    };
    check();
    if (this.hasConfirmedOfficialCodeStartup(conversation, eventId)) return;
    await this.awaitHistorySave();
    check();
    if (!this.hasConfirmedOfficialCodeStartup(conversation, eventId))
      throw Error("The Code repository startup was not acknowledged.");
  }

  override async persistCodeCompaction(conversation: Conversation, turn: Turn, current: () => boolean) {
    const requestId = turn.compactionRequestId;
    if (!requestId) throw Error("The Code compaction request is missing its identity.");
    const check = () => {
      this.assertConversationMetadataWritable(conversation.id);
      if (this.closed || !current() || !this.conversations.includes(conversation) ||
          !conversation.turns.includes(turn))
        throw Error("The Code session changed before compaction was saved.");
    };
    check();
    await this.awaitHistorySave();
    check();
    if (!this.synced.conversations.get(conversation.id)?.codeCompactionRequests?.has(requestId)) {
      this.uncertainConversationWrites.add(conversation.id);
      throw Error("The compaction request save was not acknowledged.");
    }
  }

  hasConfirmedCodeCompletion(conversation: Conversation, turn: Pick<Turn, "id" | "createdAt">) {
    const confirmed = this.synced.conversations.get(conversation.id)?.latestCompletedCodeTurn;
    return confirmed?.id === turn.id && confirmed.createdAt === turn.createdAt;
  }

  hasConfirmedCodeStops(conversation: Conversation) {
    const saved = this.synced.conversations.get(conversation.id)?.stoppedCodeTurns;
    return conversation.turns.every(
      (turn) =>
        !codeTurnStoppedByUser(turn) ||
        (saved?.conversationCreatedAt === conversation.createdAt &&
          saved.turns.get(turn.id) === turn.createdAt),
    );
  }

  async confirmCodeStops(conversation: Conversation, current: () => boolean) {
    if (this.closed || !current()) return false;
    if (this.hasConfirmedCodeStops(conversation)) return true;
    await this.awaitHistorySave();
    return !this.closed && current() && this.hasConfirmedCodeStops(conversation);
  }

  /** Confirm the original input ID, even when later streaming text changes the turn hash. */
  async confirmOfficialCodeEvent(
    conversation: Conversation,
    eventId: string,
    current: () => boolean,
  ) {
    const check = () => {
      const event = officialCodeEvent(conversation.turns, eventId);
      if (
        this.closed ||
        !current() ||
        !this.conversations.includes(conversation) ||
        !event ||
        (event.kind === "turn" && event.turn.id.startsWith("pending-"))
      )
        throw Error("The Cloud Code follow-up outcome could not be confirmed.");
    };
    const confirmed = () => this.hasConfirmedOfficialCodeEvent(conversation, eventId);

    check();
    if (confirmed()) return;

    await this.awaitHistorySave();
    check();
    if (!confirmed()) throw Error("The Code history save was not acknowledged.");
  }

  private async awaitHistorySave() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.sync("full").then(() => this.settled()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error("The Code history save timed out.")), 15_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async persistModelPreference() {
    await CloudStore.confirmSettings(this, "model preference");
  }
  /** Cosmetic UI must not label a queued/retrying write as saved. */
  async persistAppearancePreference() {
    await CloudStore.confirmSettings(this, "response font");
  }
  /** A skill toggle requires the same exact settings-row acknowledgement. */
  override async persistSkillPreference() {
    await CloudStore.confirmSettings(this, "skill preference");
  }
  override async persistApiPreferences(update: ApiPreferenceUpdate, current: () => boolean) {
    await this.reserveExplicitWrite(async () => {
      if (this.closed || this.closing || this.uncertainSettings || !current())
        throw Error("The account's API preference cannot be saved.");
      const updated = update(this.settings);
      const staged = JSON.stringify({ ...this.settings, ...updated });
      try {
        await this.request("store.settings.put", { settings: JSON.parse(staged) });
        if (!current()) throw Error("The account changed during this operation.");
      } catch (error) {
        if (error instanceof LinkRequestError &&
            (error.code === webErrorCodes.badRequest || error.code === webErrorCodes.tooLarge ||
             error.code === webErrorCodes.quotaExceeded || error.code === webErrorCodes.methodUnavailable))
          throw error;
        this.uncertainSettings = true;
        throw Error("The API preference save could not be confirmed. Reopen the account before changing it again.", { cause: error });
      }
      Object.assign(this.settings, updated);
      this.synced.settings = hash(staged);
    });
  }
  /** Email delivery must use a service-confirmed preference and owned session. */
  async persistCodeEmailPreference() {
    await this.sync("full");
    await this.settled();
    if (this.uncertainSettings || this.failures)
      throw new Error(
        "The cloud Code email preference couldn’t be saved. Try again.",
      );
  }
  /** Binding confirmation must not acknowledge a write that is merely queued
   * for retry; ordinary streaming persistence retains its retry behaviour. */
  async persistChatBinding() {
    await this.sync("full");
    await this.settled();
    if (this.failures)
      throw new Error("The Chat device binding couldn't be saved. Try again.");
  }

  /** Deletes only the service's Code copies; desktop-local stores are untouched. */
  async deleteStoredCodeSessions() {
    await this.sync("full");
    await this.reserveExplicitWrite(async () => {
      if (this.failedWrites)
        throw new Error("Couldn’t save the setting. Try again.");
      const rows = await this.pages("store.conversations.list", {}, "items");
      const ids = rows.map(row => parseConversationDoc(
        record(row, "conversation").doc as Parameters<typeof parseConversationDoc>[0],
      ).conversation).filter(row => row.mode === "code").map(row => row.id);
      for (const id of ids) this.assertConversationProjectWritable(id);
      for (const id of ids) {
        await this.request("store.conversations.delete", { id });
        this.conversations = this.conversations.filter(conversation => conversation.id !== id);
        this.synced.conversations.delete(id);
      }
    });
  }

  /** Writes what is left and stops the timers (the context is closing). */
  async close() {
    this.closing = true;
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    if (this.historyLoaded) await this.sync("full");
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** Write batches that failed in a row (0 once everything was written). */
  get failedWrites() {
    return this.failures;
  }

  private async putProject(project: Project, position: number) {
    const digest = hash(JSON.stringify({ project, position }));
    if (this.synced.projects.get(project.id) === digest) return;
    await this.request("store.projects.put", { project, position });
    this.synced.projects.set(project.id, digest);
  }

  private async writeChanges(mode: "full" | "partial") {
    // Settings.
    const settingsJson = JSON.stringify(this.settings);
    const settingsHash = hash(settingsJson);
    if (mode === "full" && !this.uncertainSettings && settingsHash !== this.synced.settings) {
      await this.request("store.settings.put", {
        settings: JSON.parse(settingsJson),
      });
      this.synced.settings = settingsHash;
    }

    // Projects.
    const projectIds = new Set<string>();
    if (mode === "full") {
      this.projects = this.projects.map(projectWithVisibility);
      for (const [position, project] of this.projects.entries()) {
        projectIds.add(project.id);
        if (!this.uncertainProjectDeletes.has(project.id)) await this.putProject(project, position);
      }
    }

    // Conversations and their turns.
    const stored = this.conversations.filter((c) => !c.incognito);
    const present = new Set<string>();
    for (const [position, conversation] of stored.entries()) {
      present.add(conversation.id);
      // A lost acknowledgement is not permission to overwrite the row with
      // either the staged candidate or the old live metadata.
      if (this.uncertainConversationWrites.has(conversation.id) ||
          this.isAffectedByUncertainProjectDeletion(conversation.id, conversation.projectId)) continue;
      const before = this.synced.conversations.get(conversation.id);
      const unresolvedMove = this.isProjectMoveUnresolved(conversation.id);
      if (unresolvedMove && !before) continue;
      if (
        mode === "partial" &&
        before &&
        before.running.size === 0 &&
        !conversation.turns.some((t) => t.status === "inProgress")
      )
        continue;
      const { doc, state, changedTurns } = this.describe(
        conversation,
        position,
        mode,
        before,
      );
      if (unresolvedMove && before) {
        const activeOrStoredTurns = changedTurns.filter(
          row => row.doc.branchId === null || before.turns.has(row.key),
        );
        await this.putTurns(activeOrStoredTurns);
        for (const { key } of activeOrStoredTurns) {
          const digest = state.turns.get(key);
          if (digest !== undefined) before.turns.set(key, digest);
        }
        before.running = state.running;
        before.stoppedCodeTurns = state.stoppedCodeTurns;
        continue;
      }
      if (!before || before.meta !== state.meta)
        await this.putConversation(doc, position);
      await this.putTurns(changedTurns.map((item) => item));
      const gone = before
        ? [...before.turns.keys()].filter((key) => !state.turns.has(key))
        : [];
      if (gone.length)
        await this.request("store.turns.delete", {
          conversationId: conversation.id,
          keys: gone.map((key) => {
            const bar = key.indexOf("|");
            return {
              branchId: bar > 0 ? key.slice(0, bar) : null,
              turnId: key.slice(bar + 1),
            };
          }),
        });
      this.synced.conversations.set(conversation.id, state);
    }
    if (mode === "partial") return;
    for (const id of [...this.synced.conversations.keys()])
      if (!present.has(id) && !this.uncertainConversationWrites.has(id) && !this.isProjectMoveUnresolved(id) &&
          !this.isAffectedByUncertainProjectDeletion(id)) {
        await this.request("store.conversations.delete", { id });
        this.synced.conversations.delete(id);
      }
    for (const id of [...this.synced.projects.keys()])
      if (!projectIds.has(id) && !this.uncertainProjectDeletes.has(id)) {
        await this.request("store.projects.delete", { id });
        this.synced.projects.delete(id);
      }
  }

  private async putConversation(doc: ConversationDoc, position: number) {
    await this.request("store.conversations.put", { doc, position });
  }

  private async putTurns(rows: { doc: TurnDoc; json: string }[]) {
    let batch: TurnDoc[] = [];
    let bytes = 0;
    const send = async () => {
      if (!batch.length) return;
      await this.request("store.turns.put", { turns: batch });
      batch = [];
      bytes = 0;
    };
    for (const row of rows) {
      const size = byteLength(row.json);
      if (bytes && bytes + size > batchBytes) await send();
      // The row as it was described: the live turn may have changed since
      // (a provisional "pending-…" id becomes Codex's own right after
      // turn/start), and turn.id must stay equal to the row's turnId.
      batch.push(JSON.parse(row.json) as TurnDoc);
      bytes += size;
    }
    await send();
  }
}
