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
 *   store.conversations.list {cursor?}                        → {items: [{doc: ConversationDoc, position}], next?}
 *   store.conversations.put  {doc: ConversationDoc, position} → {}
 *   store.conversations.delete {id}                           → {} (its turns go too)
 *   store.turns.list       {conversationId, cursor?}          → {turns: TurnDoc[], next?}
 *   store.turns.put        {turns: TurnDoc[]}                 → {} (upsert by conversationId, branchId, turnId)
 *   store.turns.delete     {conversationId, keys: [{branchId, turnId}]} → {}
 * `position` is the row's index in the sidebar order (0 first).
 */
import { createHash } from "node:crypto";
import { finishTurn } from "../../shared/activity";
import type { Conversation, Project, Settings, Turn } from "../../shared/types";
import { webLimits } from "../../shared/web-protocol";
import { type WebRunnerOp } from "../../shared/web-runner-frames";
import {
  joinConversation,
  parseConversationDoc,
  parseTurnDoc,
  splitConversation,
  type ConversationDoc,
  type TurnDoc,
} from "../../shared/web-docs";
import {
  defaultSettings,
  projectWithVisibility,
  Store,
} from "../../electron/store/store";

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
  } as Settings;
}

/** Turns a restart cut off, marked as Store marks them at start. */
export function interruptLeftTurns(conversations: Conversation[]) {
  for (const c of conversations)
    for (const t of [
      c.turns,
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
}

export interface CloudStoreOptions {
  root: string;
  userId: number;
  transport: StoreTransport;
  /** Conversations loaded at most (the newest first). */
  maxConversations?: number;
  log?: (message: string) => void;
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
  private visibilityMigration = false;

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
  static async open(options: CloudStoreOptions) {
    const store = new CloudStore(options);
    await store.load(options.maxConversations ?? 2000);
    if (store.visibilityMigration) await store.sync("full");
    return store;
  }

  private request(op: WebRunnerOp, body?: unknown) {
    return this.transport.request(op, this.userId, body);
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

  private async load(maxConversations: number) {
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
    const conversations: Conversation[] = [];
    // A few conversations at a time: the link carries one frame at a time.
    for (let i = 0; i < kept.length; i += 8) {
      const batch = await Promise.all(
        kept.slice(i, i + 8).map(async ({ doc }) => {
          const turns = (
            await this.pages(
              "store.turns.list",
              { conversationId: doc.conversation.id },
              "turns",
            )
          ).map((row) => parseTurnDoc(record(row, "turn")));
          return { doc, turns };
        }),
      );
      for (const { doc, turns } of batch) {
        const conversation = joinConversation(doc, turns);
        conversations.push(conversation);
      }
    }
    // What webstore holds now: nothing of it needs writing again.
    conversations.forEach((conversation, position) =>
      this.synced.conversations.set(
        conversation.id,
        this.describe(conversation, position, "full").state,
      ),
    );
    // A turn a restart cut off is marked (and written back at the next flush).
    interruptLeftTurns(conversations);
    this.conversations = conversations;
  }

  /** Hashes of a conversation's rows, and the rows that differ from `before`. */
  private describe(
    conversation: Conversation,
    position: number,
    mode: "full" | "partial",
    before?: SyncedConversation,
  ) {
    const { doc, turns } = splitConversation(conversation);
    const meta = hash(JSON.stringify(doc) + "|" + position);
    const state: SyncedConversation = {
      meta,
      turns: new Map(),
      running: new Set(),
    };
    const changedTurns: { key: TurnKey; doc: TurnDoc; json: string }[] = [];
    for (const row of turns) {
      const key = turnKey(row.branchId, row.turnId);
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
        !before?.running.has(key)
      ) {
        state.turns.set(key, known);
        continue;
      }
      const fitted = fitTurnDoc(row);
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
    while (this.running) await this.running;
  }
  /** Email delivery must use a service-confirmed preference and owned session. */
  async persistCodeEmailPreference() {
    await this.sync("full");
    await this.settled();
    if (this.failures)
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
    if (this.failedWrites)
      throw new Error("Couldn’t save the setting. Try again.");
    const rows = await this.pages("store.conversations.list", {}, "items");
    for (const row of rows) {
      const doc = parseConversationDoc(
        record(row, "conversation").doc as Parameters<
          typeof parseConversationDoc
        >[0],
      );
      if (doc.conversation.mode !== "code") continue;
      await this.request("store.conversations.delete", {
        id: doc.conversation.id,
      });
      this.conversations = this.conversations.filter(
        (conversation) => conversation.id !== doc.conversation.id,
      );
      this.synced.conversations.delete(doc.conversation.id);
    }
  }

  /** Writes what is left and stops the timers (the context is closing). */
  async close() {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    await this.sync("full");
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** Write batches that failed in a row (0 once everything was written). */
  get failedWrites() {
    return this.failures;
  }

  private async writeChanges(mode: "full" | "partial") {
    // Settings.
    const settingsJson = JSON.stringify(this.settings);
    const settingsHash = hash(settingsJson);
    if (mode === "full" && settingsHash !== this.synced.settings) {
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
        const digest = hash(JSON.stringify({ project, position }));
        if (this.synced.projects.get(project.id) === digest) continue;
        await this.request("store.projects.put", { project, position });
        this.synced.projects.set(project.id, digest);
      }
    }

    // Conversations and their turns.
    const stored = this.conversations.filter((c) => !c.incognito);
    const present = new Set<string>();
    for (const [position, conversation] of stored.entries()) {
      present.add(conversation.id);
      const before = this.synced.conversations.get(conversation.id);
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
      if (!present.has(id)) {
        await this.request("store.conversations.delete", { id });
        this.synced.conversations.delete(id);
      }
    for (const id of [...this.synced.projects.keys()])
      if (!projectIds.has(id)) {
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
