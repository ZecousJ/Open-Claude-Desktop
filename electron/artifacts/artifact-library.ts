import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactLibraryState, SavedArtifact } from "../../shared/types";
import {
  artifactNoteKey,
  artifactNoteLimits as limits,
  type ArtifactNote,
  type ArtifactNotePatch,
  type ArtifactNotes,
} from "../../shared/artifact-notes";
import { collectGeneratedSnapshots } from "./generated-blobs";

const copySchema = z
  .object({
    libraryId: z.string().uuid(),
    sharedArtifactToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{20,64}$/)
      .optional(),
    name: z.string().min(1).max(200),
    language: z.string().min(1).max(30),
    content: z.string().max(2_000_000),
    originConversationId: z.string().min(1).max(500).optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    copies: z.array(copySchema).max(100),
    pinned: z.array(z.string().max(2_000_200)).max(1000),
  })
  .strict();
export const duplicateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    language: z.string().min(1).max(30),
    content: z.string().max(2_000_000),
    originConversationId: z.string().min(1).max(500).optional(),
  })
  .strict();
const maxTotalBytes = 20 * 1024 * 1024;

const time = z.number().nonnegative().max(8.64e15);
export const noteKeySchema = z.string().regex(/^[0-9a-f]{32}$/);
const replySchema = z
  .object({
    id: z.string().min(1).max(100),
    text: z.string().max(limits.commentChars),
    createdAt: time,
    editedAt: time.optional(),
  })
  .strict();
const commentSchema = z
  .object({
    id: z.string().min(1).max(100),
    text: z.string().max(limits.commentChars),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    createdAt: time,
    resolved: z.boolean(),
    editedAt: time.optional(),
    replies: z.array(replySchema).max(limits.replies).optional(),
  })
  .strict();
const noteSchema = z
  .object({
    conversationId: z.string().min(1).max(500).optional(),
    name: z.string().trim().min(1).max(limits.nameChars).optional(),
    renamedAt: time.optional(),
    viewedAt: time.optional(),
    comments: z.array(commentSchema).max(limits.comments).optional(),
  })
  .strict();
const notesFileSchema = z
  .object({ version: z.literal(1), notes: z.record(noteKeySchema, noteSchema) })
  .strict();
export const notePatchSchema = z
  .object({
    conversationId: z.string().min(1).max(500).optional(),
    name: z.string().trim().min(1).max(limits.nameChars).optional(),
    viewed: z.literal(true).optional(),
    comments: z.array(commentSchema).max(limits.comments).optional(),
  })
  .strict();

/**
 * Artifact names, open times and comments for one account
 * (`artifact-notes.json`). Read on first use; a damaged file is reported and
 * left in place, never overwritten.
 */
export class ArtifactNotesStore {
  private file: string;
  private notes?: ArtifactNotes;
  constructor(
    root: string,
    private now: () => number = Date.now,
  ) {
    this.file = path.join(root, "artifact-notes.json");
  }
  private load(): ArtifactNotes {
    if (this.notes) return this.notes;
    try {
      this.notes = notesFileSchema.parse(
        JSON.parse(fs.readFileSync(this.file, "utf8")),
      ).notes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error(
          "Artifact names and comments cannot be read; the file has not been overwritten.",
        );
      this.notes = {};
    }
    return this.notes;
  }
  private save(notes: ArtifactNotes) {
    const text = JSON.stringify({ version: 1, notes });
    if (Buffer.byteLength(text) > limits.fileBytes)
      throw Error("Artifact comments storage limit reached.");
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.notes = notes;
  }
  all(): ArtifactNotes {
    return structuredClone(this.load());
  }
  update(rawKey: unknown, rawPatch: unknown): ArtifactNote {
    const key = noteKeySchema.parse(rawKey);
    const patch: ArtifactNotePatch = notePatchSchema.parse(rawPatch);
    const notes = { ...this.load() };
    if (!notes[key] && Object.keys(notes).length >= limits.notes)
      evictOneViewed(notes);
    const note: ArtifactNote = { ...notes[key] };
    if (patch.conversationId) note.conversationId = patch.conversationId;
    if (patch.name !== undefined) {
      note.name = patch.name;
      note.renamedAt = this.now();
    }
    if (patch.viewed) note.viewedAt = this.now();
    if (patch.comments) note.comments = patch.comments;
    notes[key] = note;
    this.save(notes);
    return structuredClone(note);
  }
  /** Adds notes kept elsewhere by earlier versions; what is saved here already wins. */
  import(raw: unknown): ArtifactNotes {
    const incoming =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.entries(raw)
        : [];
    const notes = { ...this.load() };
    let changed = false;
    for (const [rawKey, rawNote] of incoming) {
      const key = noteKeySchema.safeParse(rawKey);
      const note = noteSchema.safeParse(rawNote);
      if (!key.success || !note.success) continue;
      const current = notes[key.data];
      if (!current && Object.keys(notes).length >= limits.notes) break;
      notes[key.data] = { ...note.data, ...current };
      changed = true;
    }
    if (changed) this.save(notes);
    return structuredClone(notes);
  }
  remove(key: string) {
    const notes = this.load();
    if (!(key in notes)) return;
    const next = { ...notes };
    delete next[key];
    this.save(next);
  }
  /** Drops the notes of artifacts whose conversation no longer exists. */
  prune(conversationIds: ReadonlySet<string>) {
    const notes = this.load();
    const kept = Object.fromEntries(
      Object.entries(notes).filter(
        ([, note]) =>
          !note.conversationId || conversationIds.has(note.conversationId),
      ),
    );
    if (Object.keys(kept).length !== Object.keys(notes).length) this.save(kept);
  }
}

/** Makes room by forgetting the oldest note that only records an open time. */
function evictOneViewed(notes: ArtifactNotes) {
  const candidates = Object.entries(notes).filter(
    ([, note]) => note.name === undefined && !note.comments?.length,
  );
  if (!candidates.length) throw Error("Too many artifact notes.");
  candidates.sort(([, a], [, b]) => (a.viewedAt ?? 0) - (b.viewedAt ?? 0));
  delete notes[candidates[0][0]];
}

/**
 * Values in the saved history that may name a conversation or a file
 * snapshot. The file is scanned as text rather than parsed: the result may
 * include more than those values (item ids, text-file digests), never fewer,
 * so nothing still in use is ever removed. Undefined when there is no saved
 * history to compare with or it cannot be read.
 */
export function savedReferences(
  root: string,
): { ids: Set<string>; digests: Set<string> } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, "conversations.json"), "utf8");
  } catch {
    return undefined;
  }
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const match of text.matchAll(/"(id|digest)":\s*"([^"\\]{1,500})"/g))
    (match[1] === "id" ? ids : digests).add(match[2]);
  return { ids, digests };
}

/** Independent Artifact copies and library order live under one authenticated profile. */
export class ArtifactLibrary {
  private file: string;
  private state: ArtifactLibraryState;
  readonly notes: ArtifactNotesStore;
  constructor(
    private root: string,
    private now: () => number = Date.now,
  ) {
    this.file = path.join(root, "artifact-library.json");
    try {
      this.state = stateSchema.parse(
        JSON.parse(fs.readFileSync(this.file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error(
          "Artifact library cannot be read; it has not been overwritten.",
        );
      this.state = { version: 1, copies: [], pinned: [] };
    }
    this.notes = new ArtifactNotesStore(root, now);
    // The account is being opened: its history on disk is complete and
    // nothing new has been written yet, so leftovers can be told apart.
    this.tidy();
  }
  /**
   * Forgets pins and notes of deleted conversations and removes generated
   * file snapshots no saved conversation refers to. Never throws: a
   * failure leaves everything in place until the next time.
   */
  tidy() {
    const references = savedReferences(this.root);
    if (!references) return;
    try {
      const pinned = this.state.pinned.filter((identity) => {
        try {
          const [owner] = JSON.parse(identity) as unknown[];
          return owner === "library" || references.ids.has(String(owner));
        } catch {
          return true;
        }
      });
      if (pinned.length !== this.state.pinned.length) {
        this.state.pinned = pinned;
        this.save();
      }
    } catch {
      // Pins stay as they are.
    }
    try {
      this.notes.prune(references.ids);
    } catch {
      // A damaged notes file is reported when it is used.
    }
    try {
      collectGeneratedSnapshots(this.root, references.digests, this.now());
    } catch {
      // Snapshots stay until the next time.
    }
  }
  list(): ArtifactLibraryState {
    return structuredClone(this.state);
  }
  private save() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  duplicate(raw: unknown): {
    artifact: SavedArtifact;
    library: ArtifactLibraryState;
  } {
    const input = duplicateInputSchema.parse(raw);
    if (
      this.state.copies.length >= 100 ||
      this.state.copies.reduce(
        (sum, item) => sum + Buffer.byteLength(item.content),
        0,
      ) +
        Buffer.byteLength(input.content) >
        maxTotalBytes
    )
      throw Error("Artifact library storage limit reached.");
    const artifact: SavedArtifact = {
      libraryId: randomUUID(),
      name: `${input.name} copy`.slice(0, 200),
      language: input.language,
      content: input.content,
      originConversationId: input.originConversationId,
      createdAt: this.now(),
    };
    this.state.copies.push(artifact);
    this.save();
    return { artifact, library: this.list() };
  }
  /**
   * Shared-link imports keep their identity when refreshed. Imported code
   * carries no tool grants.
   */
  importShared(token: string, raw: unknown, refresh = false) {
    z.string()
      .regex(/^[A-Za-z0-9_-]{20,64}$/)
      .parse(token);
    const input = duplicateInputSchema.parse(raw);
    const existing = this.state.copies.find(
      (entry) => entry.sharedArtifactToken === token,
    );
    if (existing && !refresh)
      return { artifact: { ...existing }, library: this.list() };
    const artifact: SavedArtifact = {
      libraryId: existing?.libraryId ?? randomUUID(),
      sharedArtifactToken: token,
      name: input.name,
      language: input.language,
      content: input.content,
      createdAt: existing?.createdAt ?? this.now(),
    };
    const copies = existing
      ? this.state.copies.map((entry) =>
          entry.libraryId === existing.libraryId ? artifact : entry,
        )
      : [...this.state.copies, artifact];
    if (
      copies.length > 100 ||
      copies.reduce((sum, entry) => sum + Buffer.byteLength(entry.content), 0) >
        maxTotalBytes
    )
      throw Error("Artifact library storage limit reached.");
    this.state.copies = copies;
    this.save();
    return { artifact: { ...artifact }, library: this.list() };
  }
  deleteCopy(libraryId: string): ArtifactLibraryState {
    const original = this.state.copies.length;
    if (!this.state.copies.some((value) => value.libraryId === libraryId))
      throw Error("Artifact copy not found.");
    this.state.copies = this.state.copies.filter(
      (value) => value.libraryId !== libraryId,
    );
    if (this.state.copies.length !== original) {
      const identity = JSON.stringify(["library", libraryId]);
      this.state.pinned = this.state.pinned.filter(
        (value) => value !== identity,
      );
      this.save();
      try {
        this.notes.remove(artifactNoteKey(identity));
      } catch {
        // A damaged notes file keeps them; it is reported when used.
      }
    }
    return this.list();
  }
  pin(identity: string, pinned: boolean): ArtifactLibraryState {
    if (!identity || identity.length > 2_000_200)
      throw Error("Invalid Artifact identity.");
    if (this.state.pinned.includes(identity) === pinned) return this.list();
    if (pinned) {
      if (this.state.pinned.length >= 1000)
        throw Error("Too many pinned Artifacts.");
      this.state.pinned.unshift(identity);
    } else
      this.state.pinned = this.state.pinned.filter(
        (value) => value !== identity,
      );
    this.save();
    return this.list();
  }
}
