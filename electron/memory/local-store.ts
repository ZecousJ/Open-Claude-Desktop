/**
 * Memory of an account on this computer: `<profile>/memory.json`, written
 * whole and atomically (temporary file, then rename, mode 0600) like the
 * rest of the profile. A file that cannot be read is never overwritten:
 * memory reads as empty and every change is refused until it is fixed.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MemoryPrefs } from "../../shared/memory-api";
import {
  MemoryConflictError,
  type MemoryStore,
  type SaveDocInput,
} from "./store";
import {
  cleanEdit,
  isMemoryScope,
  looksSecret,
  memoryLimits,
  memoryMessages,
  utf8Bytes,
  type MemoryDocRecord,
  type MemoryEditRecord,
  type MemoryScope,
  type MemorySnapshot,
} from "./types";

export const localMemoryFile = "memory.json";

const scope = z
  .string()
  .max(80)
  .refine((value) => isMemoryScope(value));
const time = z.number().int().nonnegative();
const fileSchema = z.object({
  version: z.literal(1),
  prefs: z
    .object({ searchChats: z.boolean(), generate: z.boolean() })
    .nullable(),
  docs: z
    .array(
      z.object({
        scope,
        content: z.string().max(memoryLimits.docBytes * 4),
        revision: z.number().int().positive(),
        source: z.enum(["generated", "user", "import"]),
        generatedAt: time.optional(),
        updatedAt: time,
        createdAt: time,
      }),
    )
    .max(1000),
  edits: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        scope,
        text: z.string().max(memoryLimits.editChars * 4),
        createdAt: time,
      }),
    )
    .max(100_000),
});
type MemoryFile = z.infer<typeof fileSchema>;

const emptyFile = (): MemoryFile => ({
  version: 1,
  prefs: null,
  docs: [],
  edits: [],
});

export class LocalMemoryStore implements MemoryStore {
  readonly kind = "local" as const;
  private data: MemoryFile;
  /** Set when memory.json exists but could not be read. */
  private broken = false;
  private readonly file: string;
  constructor(
    root: string,
    private now: () => number = Date.now,
  ) {
    this.file = path.join(root, localMemoryFile);
    this.data = this.read();
  }
  private read(): MemoryFile {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return emptyFile();
      this.broken = true;
      return emptyFile();
    }
    try {
      const parsed = fileSchema.parse(JSON.parse(text));
      this.broken = false;
      return parsed as MemoryFile;
    } catch {
      this.broken = true;
      return emptyFile();
    }
  }
  private write(next: MemoryFile) {
    if (this.broken) throw new Error(memoryMessages.broken);
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.data = next;
  }
  /** Whether memory.json exists but could not be read. */
  get unreadable() {
    return this.broken;
  }
  current(): MemorySnapshot {
    return {
      available: true,
      prefs: this.data.prefs ? { ...this.data.prefs } : null,
      limits: memoryLimits,
      docs: this.data.docs.map((doc) => ({ ...doc }) as MemoryDocRecord),
      edits: this.data.edits.map((edit) => ({ ...edit }) as MemoryEditRecord),
    };
  }
  async load() {
    this.data = this.read();
    return this.current();
  }
  async setPrefs(prefs: Partial<MemoryPrefs>) {
    const base = this.data.prefs ?? { searchChats: false, generate: false };
    this.write({
      ...this.data,
      prefs: {
        searchChats: prefs.searchChats ?? base.searchChats,
        generate: prefs.generate ?? base.generate,
      },
    });
    return this.current();
  }
  private scopes(extra?: MemoryScope) {
    const scopes = new Set<string>([
      ...this.data.docs.map((doc) => doc.scope),
      ...this.data.edits.map((edit) => edit.scope),
    ]);
    if (extra) scopes.add(extra);
    return scopes.size;
  }
  async saveDoc(
    scope: MemoryScope,
    input: SaveDocInput,
  ): Promise<MemoryDocRecord> {
    if (utf8Bytes(input.content) > memoryLimits.docBytes)
      throw new Error(memoryMessages.tooLarge);
    const existing = this.data.docs.find((doc) => doc.scope === scope);
    if ((existing?.revision ?? 0) !== input.baseRevision)
      throw new MemoryConflictError(existing?.revision ?? 0);
    if (!existing && this.scopes(scope) > memoryLimits.scopes)
      throw new Error(memoryMessages.full);
    const now = this.now();
    const doc: MemoryFile["docs"][number] = {
      scope,
      content: input.content,
      revision: (existing?.revision ?? 0) + 1,
      source: input.source,
      ...(input.source === "generated"
        ? { generatedAt: now }
        : existing?.generatedAt !== undefined
          ? { generatedAt: existing.generatedAt }
          : {}),
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    };
    const folded =
      input.source === "generated" && input.editsUpto !== undefined
        ? new Set(
            this.data.edits
              .slice(
                0,
                this.data.edits.findIndex(
                  (edit) => edit.id === input.editsUpto,
                ) + 1,
              )
              .filter((edit) => edit.scope === scope)
              .map((edit) => edit.id),
          )
        : new Set<string>();
    this.write({
      ...this.data,
      docs: [...this.data.docs.filter((item) => item.scope !== scope), doc],
      edits: this.data.edits.filter((edit) => !folded.has(edit.id)),
    });
    return { ...doc };
  }
  async addEdit(scope: MemoryScope, raw: string): Promise<MemoryEditRecord> {
    const text = cleanEdit(raw);
    if (!text) throw new Error(memoryMessages.emptyEdit);
    if ([...text].length > memoryLimits.editChars)
      throw new Error(memoryMessages.editTooLong);
    if (looksSecret(text)) throw new Error(memoryMessages.sensitive);
    const inScope = this.data.edits.filter((edit) => edit.scope === scope);
    if (inScope.length >= memoryLimits.editsPerScope)
      throw new Error(memoryMessages.full);
    if (this.scopes(scope) > memoryLimits.scopes)
      throw new Error(memoryMessages.full);
    const edit = {
      id: randomUUID(),
      scope,
      text,
      createdAt: this.now(),
    };
    this.write({ ...this.data, edits: [...this.data.edits, edit] });
    return { ...edit };
  }
  async removeEdit(id: string) {
    if (!this.data.edits.some((edit) => edit.id === id)) return;
    this.write({
      ...this.data,
      edits: this.data.edits.filter((edit) => edit.id !== id),
    });
  }
  async reset(scope?: MemoryScope) {
    this.write({
      ...this.data,
      docs: scope ? this.data.docs.filter((doc) => doc.scope !== scope) : [],
      edits: scope
        ? this.data.edits.filter((edit) => edit.scope !== scope)
        : [],
    });
  }
}
