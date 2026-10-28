/**
 * Memory of a Claudex account: kept by the service (shared by the person's
 * devices), with the last answer cached in `<profile>/memory-cache.json`
 * (0600, written atomically) so memory still applies when the app starts
 * offline. While the service cannot be reached the cache is read-only.
 */
import fs from "node:fs";
import path from "node:path";
import type { MemoryPrefs } from "../../shared/memory-api";
import {
  memoryErrorCodes,
  memoryMissing,
  parseMemoryView,
  type ClaudexMemory,
} from "../sub2api/claudex-memory";
import { metadataNumber, Sub2ApiError } from "../sub2api/http";
import {
  MemoryConflictError,
  MemoryOfflineError,
  MemoryUnsupportedError,
  type MemoryStore,
  type SaveDocInput,
} from "./store";
import {
  memoryMessages,
  type MemoryDocRecord,
  type MemoryEditRecord,
  type MemoryScope,
  type MemorySnapshot,
} from "./types";

export const memoryCacheFile = "memory-cache.json";

/** The service calls the store makes, each with a fresh access token. */
export type MemoryApi = Pick<
  ClaudexMemory,
  | "get"
  | "setPrefs"
  | "saveDoc"
  | "deleteDoc"
  | "deleteAll"
  | "addEdit"
  | "removeEdit"
>;
export type Authorized = <T>(call: (token: string) => Promise<T>) => Promise<T>;

/** What a refused memory request means to the person. */
export function memoryError(error: unknown): Error {
  if (!(error instanceof Sub2ApiError))
    return error instanceof Error ? error : new Error(String(error));
  if (memoryMissing(error)) return new MemoryUnsupportedError();
  switch (error.code) {
    case memoryErrorCodes.conflict:
      return new MemoryConflictError(
        metadataNumber(error, "current_revision") ?? -1,
      );
    case memoryErrorCodes.disabled:
      return new Error(
        error.metadata?.field === "memory" || !error.metadata?.field
          ? memoryMessages.disabled
          : memoryMessages.switchDisabled,
      );
    case memoryErrorCodes.tooLarge:
      return new Error(memoryMessages.tooLarge);
    case memoryErrorCodes.limit:
      return new Error(
        error.metadata?.limit === "edit_chars"
          ? memoryMessages.editTooLong
          : memoryMessages.full,
      );
    case memoryErrorCodes.sensitive:
      return new Error(memoryMessages.sensitive);
    case memoryErrorCodes.keyMissing:
      return new Error(memoryMessages.serverKey);
    case "UNREACHABLE":
      return new MemoryOfflineError();
  }
  if (error.status === 429) return new Error(memoryMessages.rateLimited);
  if (error.status === 0 || error.status >= 500)
    return new MemoryOfflineError(
      error.status === 0 ? memoryMessages.offline : error.message,
    );
  return new Error(error.message);
}

/** The cached copy of a Claudex account's memory in its profile, if any. */
export function readMemoryCache(root: string): MemorySnapshot | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, memoryCacheFile), "utf8"),
    );
    // The cache keeps the service's own answer, checked the same way.
    return raw?.version === 1 ? parseMemoryView(raw.view) : undefined;
  } catch {
    return undefined;
  }
}

export class RemoteMemoryStore implements MemoryStore {
  readonly kind = "remote" as const;
  private snapshot?: MemorySnapshot;
  private readonly file: string;
  private closed = false;
  constructor(
    private api: MemoryApi,
    private authorized: Authorized,
    root: string,
  ) {
    this.file = path.join(root, memoryCacheFile);
    this.snapshot = this.readCache();
  }
  private readCache(): MemorySnapshot | undefined {
    return readMemoryCache(path.dirname(this.file));
  }
  /** Writes the snapshot back in the service's wire form. */
  private writeCache() {
    if (this.closed || !this.snapshot) return;
    const s = this.snapshot;
    const iso = (at: number) => new Date(at).toISOString();
    const wire = (prefs: MemoryPrefs) => ({
      search_chats: prefs.searchChats,
      generate: prefs.generate,
    });
    const view = {
      available: s.available,
      reason: s.reason ?? null,
      allowed: wire(s.allowed ?? { searchChats: false, generate: false }),
      prefs: wire(s.prefs ?? { searchChats: false, generate: false }),
      model: s.model ?? null,
      limits: {
        doc_bytes: s.limits.docBytes,
        edits_per_scope: s.limits.editsPerScope,
        edit_chars: s.limits.editChars,
        scopes: s.limits.scopes,
      },
      docs: s.docs.map((doc) => ({
        scope: doc.scope,
        content: doc.content,
        readable: doc.content !== null,
        revision: doc.revision,
        source: doc.source,
        generated_at:
          doc.generatedAt !== undefined ? iso(doc.generatedAt) : null,
        updated_at: iso(doc.updatedAt),
        created_at: iso(doc.createdAt),
      })),
      edits: s.edits
        .filter((edit) => /^\d+$/.test(edit.id))
        .map((edit) => ({
          id: Number(edit.id),
          scope: edit.scope,
          text: edit.text,
          readable: edit.text !== null,
          created_at: iso(edit.createdAt),
        })),
    };
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, view }), {
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error(
        "Memory cache could not be saved:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  private async request<T>(call: (token: string) => Promise<T>) {
    try {
      return await this.authorized(call);
    } catch (error) {
      throw memoryError(error);
    }
  }
  private update(change: (snapshot: MemorySnapshot) => void) {
    if (!this.snapshot) return;
    change(this.snapshot);
    this.writeCache();
  }
  current() {
    return this.snapshot ? structuredClone(this.snapshot) : undefined;
  }
  async load() {
    const next = await this.request((token) => this.api.get(token));
    this.snapshot = next;
    this.writeCache();
    return structuredClone(next);
  }
  async setPrefs(prefs: Partial<MemoryPrefs>) {
    const status = await this.request((token) =>
      this.api.setPrefs(token, prefs),
    );
    if (!this.snapshot) return this.load();
    this.update((snapshot) => {
      snapshot.available = status.available;
      if (status.reason) snapshot.reason = status.reason;
      else delete snapshot.reason;
      snapshot.allowed = status.allowed;
      snapshot.prefs = status.prefs;
      snapshot.model = status.model;
    });
    return this.current()!;
  }
  async saveDoc(
    scope: MemoryScope,
    input: SaveDocInput,
  ): Promise<MemoryDocRecord> {
    const editsUpto =
      input.editsUpto !== undefined && /^\d+$/.test(input.editsUpto)
        ? Number(input.editsUpto)
        : undefined;
    const saved = await this.request((token) =>
      this.api.saveDoc(token, scope, {
        content: input.content,
        source: input.source,
        baseRevision: input.baseRevision,
        ...(editsUpto !== undefined ? { editsUpto } : {}),
      }),
    );
    this.update((snapshot) => {
      snapshot.docs = [
        ...snapshot.docs.filter((doc) => doc.scope !== scope),
        saved,
      ];
      if (editsUpto !== undefined)
        snapshot.edits = snapshot.edits.filter(
          (edit) => edit.scope !== scope || Number(edit.id) > editsUpto,
        );
    });
    return saved;
  }
  async addEdit(scope: MemoryScope, text: string): Promise<MemoryEditRecord> {
    const saved = await this.request((token) =>
      this.api.addEdit(token, scope, text),
    );
    this.update((snapshot) => {
      snapshot.edits = [...snapshot.edits, saved];
    });
    return saved;
  }
  async removeEdit(id: string) {
    await this.request((token) => this.api.removeEdit(token, id));
    this.update((snapshot) => {
      snapshot.edits = snapshot.edits.filter((edit) => edit.id !== id);
    });
  }
  async reset(scope?: MemoryScope) {
    await this.request((token) =>
      scope ? this.api.deleteDoc(token, scope) : this.api.deleteAll(token),
    );
    this.update((snapshot) => {
      snapshot.docs = scope
        ? snapshot.docs.filter((doc) => doc.scope !== scope)
        : [];
      snapshot.edits = scope
        ? snapshot.edits.filter((edit) => edit.scope !== scope)
        : [];
    });
  }
  close() {
    this.closed = true;
  }
}
