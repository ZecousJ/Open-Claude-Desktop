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
  MemoryControlsConflictError,
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
import { cleanControls } from "./controls";

export const localMemoryFile = "memory.json";

const scope = z
  .string()
  .max(80)
  .refine((value) => isMemoryScope(value));
const time = z.number().int().nonnegative();
const fileSchema = z.object({
  version: z.literal(1),
  epoch: z.number().int().nonnegative().default(0),
  versions: z.record(z.string(), z.number().int().nonnegative()).default({}),
  resets: z.record(z.string(), z.number().int().nonnegative()).default({}),
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
  epoch: 0,
  versions: {},
  resets: {},
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
      emptyControlsVersion: `v1:${this.data.epoch}:0:0`,
      controlsVersions: Object.fromEntries(
        Object.keys(this.data.versions).map((scope) => [
          scope,
          this.controlsVersion(scope),
        ]),
      ),
    };
  }
  async load() {
    this.data = this.read();
    return this.current();
  }
  async setPrefs(prefs: Partial<MemoryPrefs>, defaults?: MemoryPrefs) {
    this.data = this.read();
    const base = this.data.prefs ?? defaults ?? { searchChats: false, generate: false };
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
  private controlsVersion(scope: string) {
    return `v1:${this.data.epoch}:${this.data.resets[scope] ?? 0}:${this.data.versions[scope] ?? 0}`;
  }
  private checkControls(scope: MemoryScope, base: string) {
    const current = this.controlsVersion(scope);
    if (base !== current) {
      const a = base.split(":");
      const b = current.split(":");
      throw new MemoryControlsConflictError(a[1] !== b[1] || a[2] !== b[2]);
    }
  }
  async replaceControls(
    scope: MemoryScope,
    raw: string[],
    baseVersion: string,
  ) {
    this.data = this.read();
    const controls = cleanControls(raw, memoryLimits);
    this.checkControls(scope, baseVersion);
    if (controls.length && this.scopes(scope) > memoryLimits.scopes)
      throw new Error(memoryMessages.full);
    const edits = controls.map((text) => ({
      id: randomUUID(),
      scope,
      text,
      createdAt: this.now(),
    }));
    this.write({
      ...this.data,
      versions: {
        ...this.data.versions,
        [scope]: (this.data.versions[scope] ?? 0) + 1,
      },
      edits: [
        ...this.data.edits.filter((edit) => edit.scope !== scope),
        ...edits,
      ],
    });
    return {
      edits: edits.map((edit) => ({ ...edit })),
      version: this.controlsVersion(scope),
    };
  }
  async saveDoc(
    scope: MemoryScope,
    input: SaveDocInput,
    checkBeforeWrite?: () => void,
  ): Promise<MemoryDocRecord> {
    this.data = this.read();
    checkBeforeWrite?.();
    if (utf8Bytes(input.content) > memoryLimits.docBytes)
      throw new Error(memoryMessages.tooLarge);
    if (input.baseControlsVersion !== undefined)
      this.checkControls(scope, input.baseControlsVersion);
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
      versions: folded.size
        ? {
            ...this.data.versions,
            [scope]: (this.data.versions[scope] ?? 0) + 1,
          }
        : this.data.versions,
    });
    return { ...doc };
  }
  async addEdit(scope: MemoryScope, raw: string): Promise<MemoryEditRecord> {
    this.data = this.read();
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
    this.write({
      ...this.data,
      edits: [...this.data.edits, edit],
      versions: {
        ...this.data.versions,
        [scope]: (this.data.versions[scope] ?? 0) + 1,
      },
    });
    return { ...edit };
  }
  async removeEdit(id: string) {
    this.data = this.read();
    const existing = this.data.edits.find((edit) => edit.id === id);
    if (!existing) return;
    this.write({
      ...this.data,
      edits: this.data.edits.filter((edit) => edit.id !== id),
      versions: {
        ...this.data.versions,
        [existing.scope]: (this.data.versions[existing.scope] ?? 0) + 1,
      },
    });
  }
  async reset(scope?: MemoryScope) {
    this.data = this.read();
    this.write({
      ...this.data,
      epoch: scope ? this.data.epoch : this.data.epoch + 1,
      versions: scope
        ? {
            ...this.data.versions,
            [scope]: (this.data.versions[scope] ?? 0) + 1,
          }
        : {},
      resets: scope
        ? { ...this.data.resets, [scope]: (this.data.resets[scope] ?? 0) + 1 }
        : {},
      docs: scope ? this.data.docs.filter((doc) => doc.scope !== scope) : [],
      edits: scope
        ? this.data.edits.filter((edit) => edit.scope !== scope)
        : [],
    });
  }
}
