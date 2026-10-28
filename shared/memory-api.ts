/**
 * Memory (R3): what Claude remembers across Chat and Cowork conversations,
 * one global document plus one per project, and the Settings → Memory page.
 *
 * The interface and method list are frozen (S0); `electron/ipc/memory.ts`
 * answers them (R3-S4). A Claudex account keeps its memory on the service
 * (shared by its devices), an account on this computer in its profile's
 * memory.json. An account whose service has no memory reports
 * "unsupported" and every change is refused, so the Settings page shows no
 * memory controls.
 *
 * Reasons: "policy" (the administrator turned memory off), "server" (the
 * service has no memory, or no key to store it), "offline" (the service
 * cannot be reached: the cached copy is shown and changes wait).
 */
import { bridgeMethods } from "./bridge-methods";

/** A memory document: the global one or a project's. */
export type MemoryScopeRef =
  { kind: "global" } | { kind: "project"; projectId: string };

/** One explicit "remember this" edit, kept beside the synthesized text. */
export interface MemoryEditView {
  id: string;
  text: string;
  createdAt: number;
}

export interface MemoryDocView {
  content: string;
  updatedAt: number;
  generatedAt?: number;
  source: "generated" | "edited" | "imported";
  revision: number;
  edits: MemoryEditView[];
  /**
   * The service's limits for the "remember or forget" edits: how many a
   * scope keeps and how long one may be. Absent from an older main process.
   */
  limits?: { edits: number; editChars: number };
}

/** A change to a scope's edits (Manage memory): one to add, ids to remove. */
export interface MemoryEditsChange {
  add?: string;
  remove?: string[];
}

/**
 * How a Manage-memory change went (the original's result line: Added to
 * memory / Updated memory / Removed … / No changes were made.). `removed`
 * names the statements that went, shortened for a line.
 */
export type MemoryEditOutcome =
  | { kind: "added" | "updated" | "noop" | "rejected" }
  | { kind: "removed" | "added_removed" | "updated_removed"; removed: string[] }
  | { kind: "too_long"; limit: number };

/**
 * The texts of a memory_edits call memory refused, shared so the transcript
 * row can tell a refusal from another failure and show the original's line.
 */
export const memoryRefusalTexts = Object.freeze({
  sensitive: "Memory can't store passwords, keys, tokens or card numbers.",
  editTooLong: "A memory can be at most 500 characters.",
});

/**
 * What `updateMemoryEdits` answers: the scope's memory (the document view's
 * fields, an empty one when the scope has none, so an older client that only
 * reads the document keeps working) and how the change went.
 */
export type MemoryEditsResult = MemoryDocView & { outcome: MemoryEditOutcome };

export interface MemoryPrefs {
  /** Search and reference past chats. */
  searchChats: boolean;
  /** Generate memory from chat history. */
  generate: boolean;
}

export interface MemoryStatus {
  /** Policy, service and account type all allow memory. */
  available: boolean;
  reason?: "policy" | "server" | "offline" | "unsupported";
  /** What the policy allows. */
  allowed: MemoryPrefs;
  /** The person's own switches. */
  prefs: MemoryPrefs;
  global?: MemoryDocView;
  synthesizing: boolean;
  lastRun?: { at: number; ok: boolean; message?: string };
}

export interface MemoryAPI {
  readGlobalMemory(): Promise<string | null>;
  writeGlobalMemory(content: string): Promise<boolean>;
  listAccountMemories(
    includeContent?: boolean,
  ): Promise<{ path: string; content?: string; updatedAt: string }[]>;
  readAccountMemory(
    path: string,
  ): Promise<{ path: string; content?: string; updatedAt: string } | null>;
  writeAccountMemory(path: string, content: string): Promise<boolean>;
  deleteAccountMemory(path: string): Promise<boolean>;
  resetMemories(): Promise<boolean>;
  getAutoMemoryDir(projectId: string): Promise<string | null>;
  memoryStatus(): Promise<MemoryStatus>;
  setMemoryPrefs(prefs: Partial<MemoryPrefs>): Promise<MemoryStatus>;
  memoryDoc(scope: MemoryScopeRef): Promise<MemoryDocView | null>;
  /** Saves an edited document; `revision` is the one the edit started from. */
  saveMemoryDoc(
    scope: MemoryScopeRef,
    content: string,
    revision: number,
  ): Promise<MemoryDocView>;
  removeMemoryEdit(id: string): Promise<MemoryStatus>;
  /**
   * Manage memory: adds a "remember or forget" edit to a scope, removes some of
   * its edits, or both. Edits stay until removed; answers the scope's memory.
   */
  updateMemoryEdits(
    scope: MemoryScopeRef,
    change: MemoryEditsChange,
  ): Promise<MemoryEditsResult>;
  /** Merges memory exported from another assistant; nothing is saved yet. */
  previewMemoryImport(
    text: string,
  ): Promise<{ merged: string; revision: number }>;
  resetMemory(scope?: MemoryScopeRef): Promise<MemoryStatus>;
  /**
   * Settings → Reflect: a short reflection written from the global memory
   * by the account's model (kept a day unless `refresh`); "off" while
   * memory is not generated, "empty" before there is any.
   */
  memoryReflection(refresh?: boolean): Promise<MemoryReflection>;
}

export type MemoryReflection =
  | { state: "off" }
  | { state: "empty" }
  | { state: "ready"; text: string; generatedAt: number };

export const memoryMethods = bridgeMethods<MemoryAPI>({
  readGlobalMemory: true,
  writeGlobalMemory: true,
  listAccountMemories: true,
  readAccountMemory: true,
  writeAccountMemory: true,
  deleteAccountMemory: true,
  resetMemories: true,
  getAutoMemoryDir: true,
  memoryStatus: true,
  setMemoryPrefs: true,
  memoryDoc: true,
  saveMemoryDoc: true,
  removeMemoryEdit: true,
  updateMemoryEdits: true,
  previewMemoryImport: true,
  resetMemory: true,
  memoryReflection: true,
});

/** Memory status or a document changed; windows showing memory read it again. */
export interface MemoryChangedEvent {
  type: "memory-changed";
}

/** What `memoryStatus()` answers for an account without memory. */
export const unavailableMemory: MemoryStatus = {
  available: false,
  reason: "unsupported",
  allowed: { searchChats: false, generate: false },
  prefs: { searchChats: false, generate: false },
  synthesizing: false,
};
