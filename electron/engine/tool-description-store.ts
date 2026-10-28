/**
 * Descriptions of the shell commands child agents ran (R7-B).
 *
 * The gateway reads the model's `description` of each shell command call
 * (R7-A, S1). For the conversation's own thread the engine writes it onto
 * the command item. A child agent's items are not in the conversation: the
 * Workflow panel reads them from Codex (`thread/read`), which knows nothing
 * of descriptions. This store keeps those descriptions, by child thread and
 * call id, so the panel can put them back on the items it shows.
 *
 * - Kept in memory and in `<profile>/tool-descriptions.json` (mode 0600,
 *   written atomically, 250 ms after the last change), at most
 *   `maxStoredDescriptions` entries, least recently used dropped first.
 * - Children of an incognito chat are kept in memory only.
 * - Entries whose parent conversation no longer exists (deleted, or an
 *   incognito chat that ended) are dropped when the store loads, after a
 *   turn completes and before each write.
 * - The text is model output: it is cleaned with `sanitizeDescription` on
 *   the way in and again when read from disk, and only ever shown as text.
 *   It is not part of diagnostics.
 */
import fs from "node:fs";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import { maxSignalIdLength } from "../../shared/gateway-signals";
import { sanitizeDescription } from "../../shared/tool-description";
import type { EngineExtensions } from "./engine-extensions";

/** Most descriptions kept (memory and disk together). */
export const maxStoredDescriptions = 5000;
/** Delay between the last change and the write to disk. */
export const writeDelayMs = 250;
export const toolDescriptionsFile = "tool-descriptions.json";

interface Entry {
  threadId: string;
  callId: string;
  description: string;
  /** The conversation that started the child agent. */
  conversationId: string;
  /** false: memory only (incognito). */
  persist: boolean;
}

interface StoredFile {
  version: 1;
  entries: Array<{ t: string; c: string; d: string; p: string }>;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxSignalIdLength;

const keyOf = (threadId: string, callId: string) =>
  `${threadId}\u0000${callId}`;

export class ToolDescriptionStore {
  /** Insertion order is recency order: the first entry goes first. */
  private entries = new Map<string, Entry>();
  private timer?: NodeJS.Timeout;
  readonly file: string;
  constructor(
    root: string,
    /** Ids of the conversations that still exist; others' entries are dropped. */
    private liveConversations?: () => Iterable<string>,
  ) {
    this.file = path.join(root, toolDescriptionsFile);
    this.load();
  }
  get size() {
    return this.entries.size;
  }
  /**
   * Remembers a child command's description. The first description of a
   * call wins, like on the conversation's own items. Returns whether it was
   * stored.
   */
  put(
    threadId: string,
    callId: string,
    description: unknown,
    options: { conversationId: string; persist?: boolean },
  ): boolean {
    const text = sanitizeDescription(description);
    if (!text || !validId(threadId) || !validId(callId)) return false;
    if (!validId(options.conversationId)) return false;
    const key = keyOf(threadId, callId);
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(key, existing);
      return false;
    }
    this.entries.set(key, {
      threadId,
      callId,
      description: text,
      conversationId: options.conversationId,
      persist: options.persist !== false,
    });
    while (this.entries.size > maxStoredDescriptions)
      this.entries.delete(this.entries.keys().next().value!);
    if (options.persist !== false) this.schedule();
    return true;
  }
  get(threadId: string, callId: string): string | undefined {
    const key = keyOf(threadId, callId);
    const entry = this.entries.get(key);
    if (entry) this.touch(key, entry);
    return entry?.description;
  }
  /** The descriptions of one child thread, by call id. */
  forThread(threadId: string): Map<string, string> {
    const found = new Map<string, string>();
    for (const [key, entry] of [...this.entries])
      if (entry.threadId === threadId) {
        found.set(entry.callId, entry.description);
        this.touch(key, entry);
      }
    return found;
  }
  /** Forgets every description of these child threads. */
  dropThreads(threadIds: Iterable<string>) {
    const ids = new Set(threadIds);
    this.dropWhere((entry) => ids.has(entry.threadId));
  }
  /** Forgets the children of these conversations. */
  dropConversations(conversationIds: Iterable<string>) {
    const ids = new Set(conversationIds);
    this.dropWhere((entry) => ids.has(entry.conversationId));
  }
  /** Drops the entries of conversations that no longer exist. */
  prune() {
    if (!this.liveConversations) return;
    const live = new Set(this.liveConversations());
    this.dropWhere((entry) => !live.has(entry.conversationId));
  }
  /** Writes pending changes now. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.prune();
    const file: StoredFile = {
      version: 1,
      entries: [...this.entries.values()]
        .filter((entry) => entry.persist)
        .map((entry) => ({
          t: entry.threadId,
          c: entry.callId,
          d: entry.description,
          p: entry.conversationId,
        })),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error(
        "Command descriptions could not be saved:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  /** Stops the pending write (writing it first). */
  close() {
    if (this.timer) this.flush();
  }
  private touch(key: string, entry: Entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
  private dropWhere(match: (entry: Entry) => boolean) {
    let persisted = false;
    for (const [key, entry] of [...this.entries])
      if (match(entry)) {
        this.entries.delete(key);
        persisted ||= entry.persist;
      }
    if (persisted) this.schedule();
  }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), writeDelayMs);
    this.timer.unref?.();
  }
  /** A missing or unreadable file is an empty store (it is only a cache of labels). */
  private load() {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const list = (raw as Partial<StoredFile> | null)?.entries;
    if (!Array.isArray(list)) return;
    for (const value of list.slice(-maxStoredDescriptions)) {
      if (!value || typeof value !== "object") continue;
      const description = sanitizeDescription(value.d);
      if (
        !description ||
        !validId(value.t) ||
        !validId(value.c) ||
        !validId(value.p)
      )
        continue;
      this.entries.set(keyOf(value.t, value.c), {
        threadId: value.t,
        callId: value.c,
        description,
        conversationId: value.p,
        persist: true,
      });
    }
    const before = this.entries.size;
    this.prune();
    if (this.entries.size !== before) this.schedule();
  }
}

/**
 * Puts stored descriptions on the command items of a child thread read from
 * Codex (`thread/read`), without replacing one the item already has.
 * Returns how many items got one.
 */
export function applyToolDescriptions(
  thread: any,
  store: Pick<ToolDescriptionStore, "forThread"> | undefined,
): number {
  if (!store || !thread || typeof thread.id !== "string") return 0;
  const descriptions = store.forThread(thread.id);
  if (!descriptions.size) return 0;
  let applied = 0;
  for (const turn of Array.isArray(thread.turns) ? thread.turns : [])
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (
        !item ||
        item.type !== "commandExecution" ||
        typeof item.id !== "string" ||
        typeof item.description === "string"
      )
        continue;
      const description = descriptions.get(item.id);
      if (!description) continue;
      item.description = description;
      applied++;
    }
  return applied;
}

interface DescribedEngine {
  extensions?: Pick<EngineExtensions, "add">;
}

const stores = new WeakMap<
  object,
  { store: ToolDescriptionStore; remove?: () => void }
>();

/** The engine's store, if its account activated one. */
export function toolDescriptionsOf(
  engine: object | undefined,
): ToolDescriptionStore | undefined {
  return engine ? stores.get(engine)?.store : undefined;
}

/** Writes the engine's store and unhooks it (sign-out). */
export function releaseToolDescriptions(engine: object | undefined) {
  const known = engine ? stores.get(engine) : undefined;
  if (!known) return;
  stores.delete(engine!);
  known.remove?.();
  known.store.close();
}

/**
 * The store for an engine's child agents, created (and hooked to the
 * engine's gateway signals) on first use. `conversations` gives the
 * account's current conversations.
 */
export function toolDescriptionsFor(
  engine: DescribedEngine,
  root: string,
  conversations: () => readonly Conversation[],
): ToolDescriptionStore {
  const known = stores.get(engine);
  if (known) return known.store;
  const store = new ToolDescriptionStore(root, () =>
    conversations().map((conversation) => conversation.id),
  );
  const entry: { store: ToolDescriptionStore; remove?: () => void } = {
    store,
  };
  stores.set(engine, entry);
  try {
    entry.remove = hook(engine, store);
  } catch (error) {
    stores.delete(engine);
    throw error;
  }
  return store;
}

function hook(engine: DescribedEngine, store: ToolDescriptionStore) {
  return engine.extensions?.add({
    id: "tool-descriptions",
    // Children of incognito chats are kept too, in memory only.
    incognito: true,
    onGatewaySignal(signal, target) {
      // The engine writes the conversation's own commands itself.
      if (signal.type !== "toolDescription" || target.conversation) return;
      const parent = target.parent;
      if (!parent) return;
      store.put(
        signal.event.threadId,
        signal.event.callId,
        signal.event.description,
        { conversationId: parent.id, persist: !parent.incognito },
      );
    },
    onTurnCompleted() {
      store.prune();
    },
  });
}
