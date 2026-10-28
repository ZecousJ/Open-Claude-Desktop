/**
 * Where the signed-in person's memory lives (R3 design 2.2): the Claudex
 * service for a Claudex account (shared by all their devices), or
 * `memory.json` in the profile of an account on this computer. The memory
 * service uses both the same way.
 */
import type { MemoryPrefs } from "../../shared/memory-api";
import {
  memoryMessages,
  type MemoryDocRecord,
  type MemoryEditRecord,
  type MemoryScope,
  type MemorySnapshot,
  type MemorySource,
} from "./types";

export interface SaveDocInput {
  content: string;
  source: MemorySource;
  /** The revision the change started from; 0 creates the document. */
  baseRevision: number;
  /** Generated memory only: edits up to this id were folded in and go. */
  editsUpto?: string;
}

export interface MemoryStore {
  readonly kind: "local" | "remote";
  /** What the store holds now (a Claudex account: the last answer or the cache). */
  current(): MemorySnapshot | undefined;
  /** Reads everything again (the service for a Claudex account). */
  load(): Promise<MemorySnapshot>;
  /** Changes the given switches; the others keep their value. */
  setPrefs(prefs: Partial<MemoryPrefs>): Promise<MemorySnapshot>;
  /** Writes a document; a stale `baseRevision` throws MemoryConflictError. */
  saveDoc(scope: MemoryScope, input: SaveDocInput): Promise<MemoryDocRecord>;
  addEdit(scope: MemoryScope, text: string): Promise<MemoryEditRecord>;
  /** Removing an edit that is already gone is not an error. */
  removeEdit(id: string): Promise<void>;
  /** Deletes one scope's document and edits, or everything (the switches stay). */
  reset(scope?: MemoryScope): Promise<void>;
  /** Stops using the store (sign-out). */
  close?(): void;
}

/** A change based on an old revision: another device (or window) wrote first. */
export class MemoryConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(memoryMessages.conflict);
    this.name = "MemoryConflictError";
  }
}

/** The service has no memory (an older Claudex service). */
export class MemoryUnsupportedError extends Error {
  constructor() {
    super(memoryMessages.unsupported);
    this.name = "MemoryUnsupportedError";
  }
}

/** The service could not be reached; the cached copy is all there is. */
export class MemoryOfflineError extends Error {
  constructor(message: string = memoryMessages.offline) {
    super(message);
    this.name = "MemoryOfflineError";
  }
}
