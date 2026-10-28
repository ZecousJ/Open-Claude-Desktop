/**
 * The signed-in account's memory (R3 design 2.2): one service per account
 * over its store (the Claudex service, or memory.json on this computer).
 * It works out what memory may do from the administrator's policy and the
 * person's switches, answers the window (electron/ipc/memory.ts), gives the
 * engine the memory for a conversation (electron/memory/inject.ts) and runs
 * the memory_edits tool's changes (electron/memory/tools.ts).
 *
 * The engine asks synchronously, so the service keeps the store's last
 * snapshot in memory and reads it again when the policy changes, when a
 * window gains focus (at most once a minute) and every ten minutes.
 */
import type { ClientPolicy, MemoryPolicy } from "../../shared/client-policy";
import type {
  MemoryDocView,
  MemoryEditOutcome,
  MemoryEditView,
  MemoryEditsChange,
  MemoryEditsResult,
  MemoryPrefs,
  MemoryStatus,
} from "../../shared/memory-api";
import {
  MemoryConflictError,
  MemoryOfflineError,
  MemoryUnsupportedError,
  type MemoryStore,
} from "./store";
import {
  cleanEdit,
  looksSecret,
  memoryLimits,
  memoryMessages,
  utf8Bytes,
  type MemoryDocRecord,
  type MemoryEditRecord,
  type MemoryScope,
  type MemorySnapshot,
  type MemorySource,
} from "./types";

declare module "../app/app-context" {
  interface MemorySlot {
    /** The signed-in account's memory service. */
    service: MemoryService;
  }
}

export interface MemoryServiceOptions {
  store: MemoryStore;
  /** The administrator's policy now. */
  policy(): ClientPolicy;
  /** Memory changed: the windows read it again (`memory-changed`). */
  changed(): void;
  now?(): number;
}

type LoadState = "loading" | "ready" | "offline" | "unsupported";

/** A scope without memory, as an update answers it. */
const emptyDocView: MemoryDocView = {
  content: "",
  updatedAt: 0,
  source: "edited",
  revision: 0,
  edits: [],
};

/** A statement as a result line names it: one line, at most 40 characters. */
function shortName(text: string) {
  const letters = [...text.replace(/\s+/g, " ").trim()];
  return letters.length > 40
    ? `${letters.slice(0, 39).join("")}…`
    : letters.join("");
}

const off: MemoryPrefs = { searchChats: false, generate: false };

const viewSource: Record<MemorySource, MemoryDocView["source"]> = {
  generated: "generated",
  user: "edited",
  import: "imported",
};

/** Least time between two reads caused by window focus. */
export const memoryFocusRefreshMs = 60_000;
/** How often a Claudex account's memory is read while the app runs. */
export const memoryRefreshMs = 10 * 60_000;

/** What the summary task reports for `status()` (electron/memory/synthesizer.ts). */
export interface MemoryRunState {
  synthesizing: boolean;
  lastRun?: MemoryStatus["lastRun"];
}

export class MemoryService {
  private runState?: () => MemoryRunState;
  private state: LoadState;
  private first: Promise<void>;
  private loading?: Promise<void>;
  private lastRead = 0;
  private closed = false;
  private readonly now: () => number;
  constructor(private options: MemoryServiceOptions) {
    this.now = options.now ?? Date.now;
    this.state = options.store.kind === "local" ? "ready" : "loading";
    this.first =
      options.store.kind === "local" ? Promise.resolve() : this.refresh();
  }
  get store(): MemoryStore {
    return this.options.store;
  }
  /** Settles once the first read finished (or failed), at most `timeoutMs` later. */
  ready(timeoutMs = 5_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      this.first,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  /** Reads the store again; concurrent calls share one read. Never throws. */
  refresh(): Promise<void> {
    this.loading ??= this.read().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }
  /** Reads again unless the last read is more recent than `minAgeMs`. */
  refreshIfOlder(minAgeMs: number) {
    if (this.now() - this.lastRead < minAgeMs) return Promise.resolve();
    return this.refresh();
  }
  private async read() {
    if (this.closed) return;
    const before = this.fingerprint();
    this.lastRead = this.now();
    try {
      await this.options.store.load();
      this.state = "ready";
    } catch (error) {
      if (error instanceof MemoryUnsupportedError) this.state = "unsupported";
      else {
        this.state = "offline";
        if (!(error instanceof MemoryOfflineError))
          console.error(
            "Memory could not be read:",
            error instanceof Error ? error.message : String(error),
          );
      }
    }
    if (!this.closed && this.fingerprint() !== before) this.options.changed();
  }
  /**
   * Whether the bootstrap's memory section tells of something this copy
   * lacks: other switches, or a scope at another revision. (Edits carry no
   * revision; they arrive with the regular reads.)
   */
  differsFrom(section: {
    prefs: MemoryPrefs;
    available: boolean;
    revisions: Record<string, number>;
  }) {
    const snapshot = this.snapshot();
    if (!snapshot || this.state !== "ready") return true;
    if (
      snapshot.available !== section.available ||
      snapshot.prefs?.searchChats !== section.prefs.searchChats ||
      snapshot.prefs?.generate !== section.prefs.generate
    )
      return true;
    const mine = new Map(snapshot.docs.map((doc) => [doc.scope, doc.revision]));
    const theirs = Object.entries(section.revisions);
    return (
      theirs.length !== mine.size ||
      theirs.some(
        ([scope, revision]) => mine.get(scope as MemoryScope) !== revision,
      )
    );
  }
  private fingerprint() {
    return JSON.stringify([this.state, this.options.store.current() ?? null]);
  }
  private snapshot(): MemorySnapshot | undefined {
    return this.options.store.current();
  }
  /** The policy's memory block; undefined when the service offers no memory. */
  private policyMemory(): MemoryPolicy | undefined {
    return this.options.policy().memory;
  }
  /** What the policy (and the server's copy of it) lets the person turn on. */
  private allowed(
    policy: MemoryPolicy,
    snapshot: MemorySnapshot | undefined,
  ): MemoryPrefs {
    const server = snapshot?.allowed;
    return {
      searchChats:
        policy.enabled && policy.searchChats && (server?.searchChats ?? true),
      generate: policy.enabled && policy.generate && (server?.generate ?? true),
    };
  }
  /** The person's switches (the policy's default until they choose). */
  private prefs(
    policy: MemoryPolicy,
    snapshot: MemorySnapshot | undefined,
  ): MemoryPrefs {
    if (snapshot?.prefs) return { ...snapshot.prefs };
    const on = policy.enabled && policy.defaultOn;
    return { searchChats: on, generate: on };
  }
  /** Whether the service (or this computer) knows about memory at all. */
  get supported() {
    return !!this.policyMemory() && this.state !== "unsupported";
  }
  /**
   * What memory does now: search past chats (on this computer) and use and
   * write memory. Both stay off without the policy, and generate also
   * without the stored memory (a server without its key).
   */
  effective(): MemoryPrefs {
    const policy = this.policyMemory();
    const snapshot = this.snapshot();
    if (
      !policy ||
      this.state === "unsupported" ||
      (this.state === "loading" && !snapshot)
    )
      return { ...off };
    if (!policy.enabled || snapshot?.reason === "policy") return { ...off };
    const allowed = this.allowed(policy, snapshot);
    const prefs = this.prefs(policy, snapshot);
    return {
      searchChats: allowed.searchChats && prefs.searchChats,
      generate:
        allowed.generate &&
        prefs.generate &&
        !!snapshot &&
        snapshot.available !== false,
    };
  }
  /** The summary task tells `status()` whether it runs and how the last run went. */
  setRunState(read: (() => MemoryRunState) | undefined) {
    this.runState = read;
  }
  /** Tells the windows something about memory changed (a summary started or ended). */
  announce() {
    if (!this.closed) this.options.changed();
  }
  /** The model the policy names for summaries; null for the catalog's default. */
  synthesisModel(): string | null {
    return this.policyMemory()?.model ?? this.snapshot()?.model ?? null;
  }
  status(): MemoryStatus {
    const policy = this.policyMemory();
    const snapshot = this.snapshot();
    if (!policy || this.state === "unsupported")
      return {
        available: false,
        reason: policy ? "server" : "unsupported",
        allowed: { ...off },
        prefs: { ...off },
        synthesizing: false,
      };
    const allowed = this.allowed(policy, snapshot);
    const prefs = this.prefs(policy, snapshot);
    const reason: MemoryStatus["reason"] =
      !policy.enabled || snapshot?.reason === "policy"
        ? "policy"
        : snapshot?.reason === "server"
          ? "server"
          : this.state !== "ready"
            ? "offline"
            : undefined;
    const global = this.docView("global");
    const run = this.runState?.();
    return {
      available: !reason,
      ...(reason ? { reason } : {}),
      allowed,
      prefs,
      ...(global ? { global } : {}),
      synthesizing: run?.synthesizing ?? false,
      ...(run?.lastRun ? { lastRun: run.lastRun } : {}),
    };
  }
  /** A scope's document and edits as the engine and the tools read them. */
  memoryFor(scope: MemoryScope): {
    doc?: MemoryDocRecord;
    edits: MemoryEditRecord[];
  } {
    const snapshot = this.snapshot();
    const doc = snapshot?.docs.find((item) => item.scope === scope);
    const edits = (snapshot?.edits ?? [])
      .filter((edit) => edit.scope === scope && edit.text !== null)
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)
            ? Number(a.id) - Number(b.id)
            : 0),
      );
    return { ...(doc ? { doc } : {}), edits };
  }
  /** A scope's memory as the window shows it; null when there is none. */
  docView(scope: MemoryScope): MemoryDocView | null {
    const { doc, edits } = this.memoryFor(scope);
    if (!doc && !edits.length) return null;
    const views: MemoryEditView[] = edits.map((edit) => ({
      id: edit.id,
      text: edit.text ?? "",
      createdAt: edit.createdAt,
    }));
    const limits = this.limits();
    const editLimits = {
      edits: limits.editsPerScope,
      editChars: limits.editChars,
    };
    if (!doc)
      return {
        content: "",
        updatedAt: Math.max(...edits.map((edit) => edit.createdAt)),
        source: "edited",
        revision: 0,
        edits: views,
        limits: editLimits,
      };
    return {
      content: doc.content ?? "",
      updatedAt: doc.updatedAt,
      ...(doc.generatedAt !== undefined
        ? { generatedAt: doc.generatedAt }
        : {}),
      source: viewSource[doc.source],
      revision: doc.revision,
      edits: views,
      limits: editLimits,
    };
  }
  /**
   * Before a change: a service that could not be reached is tried again
   * (at most every few seconds), then the change must be one memory can
   * take now.
   */
  private async prepare(kind: "prefs" | "write" | "delete") {
    if (this.options.store.kind === "remote" && this.state === "offline")
      await this.refreshIfOlder(5_000);
    this.assertWritable(kind);
  }
  /**
   * Refuses a change memory cannot take now. "delete" (remove, reset) also
   * works while the administrator has memory turned off, like the server.
   */
  private assertWritable(kind: "prefs" | "write" | "delete") {
    const policy = this.policyMemory();
    if (!policy || this.state === "unsupported")
      throw new Error(memoryMessages.unsupported);
    // The service's policy has not arrived yet: nothing is sent to it.
    if (this.options.store.kind === "remote" && this.options.policy().pending)
      throw new Error(memoryMessages.pending);
    if (this.options.store.kind === "remote" && this.state !== "ready")
      throw new MemoryOfflineError();
    const snapshot = this.snapshot();
    if (kind === "write" && (!policy.enabled || snapshot?.reason === "policy"))
      throw new Error(memoryMessages.disabled);
    if (kind === "write" && snapshot?.reason === "server")
      throw new Error(memoryMessages.serverKey);
  }
  private done<T>(value: T): T {
    if (!this.closed) this.options.changed();
    return value;
  }
  /** Runs a change; a conflict reads memory again before it is reported. */
  private async change<T>(run: () => Promise<T>): Promise<T> {
    try {
      return this.done(await run());
    } catch (error) {
      if (error instanceof MemoryConflictError) await this.refresh();
      else if (error instanceof MemoryOfflineError) {
        this.state = "offline";
        this.options.changed();
      } else if (error instanceof MemoryUnsupportedError) {
        this.state = "unsupported";
        this.options.changed();
      }
      throw error;
    }
  }
  async setPrefs(next: Partial<MemoryPrefs>): Promise<MemoryStatus> {
    await this.prepare("prefs");
    const status = this.status();
    const change: Partial<MemoryPrefs> = {};
    for (const key of ["searchChats", "generate"] as const) {
      const value = next[key];
      if (value === undefined) continue;
      if (value && !status.allowed[key])
        throw new Error(memoryMessages.switchDisabled);
      change[key] = value;
    }
    if (!Object.keys(change).length) return status;
    // A local account stores both switches, so the default becomes a choice.
    if (this.options.store.kind === "local")
      Object.assign(change, { ...status.prefs, ...change });
    await this.change(() => this.options.store.setPrefs(change));
    return this.status();
  }
  async saveDoc(
    scope: MemoryScope,
    content: string,
    baseRevision: number,
    source: MemorySource = "user",
  ): Promise<MemoryDocView> {
    await this.prepare("write");
    if (utf8Bytes(content) > this.limits().docBytes)
      throw new Error(memoryMessages.tooLarge);
    await this.change(() =>
      this.options.store.saveDoc(scope, { content, source, baseRevision }),
    );
    return this.docView(scope)!;
  }
  /**
   * The summary's result: `content` replaces the scope's document and the
   * "remember this" edits up to `editsUpto` (which it folded in) go. A
   * document changed since `baseRevision` throws MemoryConflictError.
   */
  async saveGenerated(
    scope: MemoryScope,
    content: string,
    baseRevision: number,
    editsUpto?: string,
  ): Promise<MemoryDocView> {
    await this.prepare("write");
    if (!this.effective().generate)
      throw new Error(
        this.status().allowed.generate
          ? memoryMessages.off
          : memoryMessages.disabled,
      );
    if (utf8Bytes(content) > this.limits().docBytes)
      throw new Error(memoryMessages.tooLarge);
    await this.change(() =>
      this.options.store.saveDoc(scope, {
        content,
        source: "generated",
        baseRevision,
        ...(editsUpto !== undefined ? { editsUpto } : {}),
      }),
    );
    return this.docView(scope)!;
  }
  /** A "remember this" edit (the memory_edits tool); needs generate. */
  async addEdit(scope: MemoryScope, text: string): Promise<MemoryEditRecord> {
    await this.prepare("write");
    if (!this.effective().generate)
      throw new Error(
        this.status().allowed.generate
          ? memoryMessages.off
          : memoryMessages.disabled,
      );
    // Checked here too, so a secret never leaves this computer.
    const clean = cleanEdit(text);
    if (!clean) throw new Error(memoryMessages.emptyEdit);
    if ([...clean].length > this.limits().editChars)
      throw new Error(memoryMessages.editTooLong);
    if (looksSecret(clean)) throw new Error(memoryMessages.sensitive);
    return this.change(() => this.options.store.addEdit(scope, clean));
  }
  /**
   * Manage memory's change to a scope's edits: the ids to remove (only the
   * scope's own; one already gone is not an error), then the edit to add.
   * Removing alone works while memory is turned off, like removeEdit.
   * Answers the scope's memory with how the change went; an edit memory
   * will not keep (a secret, too long) changes nothing and says so.
   */
  async updateEdits(
    scope: MemoryScope,
    change: MemoryEditsChange,
  ): Promise<MemoryEditsResult> {
    const remove = [...new Set(change.remove ?? [])];
    const add = change.add?.trim() ? change.add : undefined;
    if (!remove.length && add === undefined)
      throw new Error(memoryMessages.emptyEdit);
    await this.prepare(add === undefined ? "delete" : "write");
    const done = (outcome: MemoryEditOutcome): MemoryEditsResult => ({
      ...(this.docView(scope) ?? emptyDocView),
      outcome,
    });
    if (add !== undefined) {
      if (!this.effective().generate)
        throw new Error(
          this.status().allowed.generate
            ? memoryMessages.off
            : memoryMessages.disabled,
        );
      // Checked before anything is removed: a refused edit changes nothing.
      const clean = cleanEdit(add);
      if (!clean) throw new Error(memoryMessages.emptyEdit);
      const limit = this.limits().editChars;
      if ([...clean].length > limit) return done({ kind: "too_long", limit });
      if (looksSecret(clean)) return done({ kind: "rejected" });
    }
    const own = new Map(
      this.memoryFor(scope).edits.map((edit) => [edit.id, edit.text ?? ""]),
    );
    const removed: string[] = [];
    for (const id of remove)
      if (own.has(id)) {
        await this.change(() => this.options.store.removeEdit(id));
        removed.push(shortName(own.get(id) ?? ""));
      }
    if (add !== undefined) await this.addEdit(scope, add);
    return done(
      add !== undefined
        ? removed.length
          ? { kind: "added_removed", removed }
          : { kind: "added" }
        : removed.length
          ? { kind: "removed", removed }
          : { kind: "noop" },
    );
  }
  async removeEdit(id: string): Promise<MemoryStatus> {
    await this.prepare("delete");
    await this.change(() => this.options.store.removeEdit(id));
    return this.status();
  }
  async reset(scope?: MemoryScope): Promise<MemoryStatus> {
    await this.prepare("delete");
    await this.change(() => this.options.store.reset(scope));
    return this.status();
  }
  limits() {
    return this.options.store.current()?.limits ?? memoryLimits;
  }
  /** Stops reading and telling the windows (sign-out). */
  close() {
    this.closed = true;
    this.options.store.close?.();
  }
}
