/**
 * Memory (R3) inside the main process: the records both stores keep, the
 * limits the service enforces (the same as the Claudex server's, design
 * 3.1) and the checks every memory edit passes before it is stored.
 *
 * A scope is "global" or "project:<uuid>" (lowercase), exactly as the
 * server names it; a project whose id is not a UUID has no memory of its
 * own.
 */
import {
  memoryRefusalTexts,
  type MemoryPrefs,
  type MemoryScopeRef,
} from "../../shared/memory-api";

export type MemoryScope = "global" | `project:${string}`;

/** Where a document's text came from, as the server names it. */
export type MemorySource = "generated" | "user" | "import";

export interface MemoryDocRecord {
  scope: MemoryScope;
  /** null when the text cannot be read any more (the server's key changed). */
  content: string | null;
  revision: number;
  source: MemorySource;
  generatedAt?: number;
  updatedAt: number;
  createdAt: number;
}

/** One "remember this" statement, kept until a summary folds it in. */
export interface MemoryEditRecord {
  id: string;
  scope: MemoryScope;
  /** null when the text cannot be read any more. */
  text: string | null;
  createdAt: number;
}

export interface MemoryLimits {
  /** Largest document, in UTF-8 bytes. */
  docBytes: number;
  editsPerScope: number;
  /** Longest edit, in characters. */
  editChars: number;
  /** Scopes per person: global plus the projects. */
  scopes: number;
}

export const memoryLimits: MemoryLimits = Object.freeze({
  docBytes: 16 * 1024,
  editsPerScope: 50,
  editChars: 500,
  scopes: 51,
});

/** Longest text Import memory accepts (design 3.7). */
export const maxImportBytes = 32 * 1024;

/** What a store holds for the signed-in person. */
export interface MemorySnapshot {
  /**
   * Whether memory text can be stored: the server's policy and encryption
   * key (a Claudex service), always true on this computer.
   */
  available: boolean;
  /** Why not: the administrator's policy, or a server without its key. */
  reason?: "policy" | "server";
  /** What the server's policy lets the person turn on (a Claudex service). */
  allowed?: MemoryPrefs;
  /** The person's switches; null until chosen (the policy's default applies). */
  prefs: MemoryPrefs | null;
  /** The model the policy names for summaries (a Claudex service). */
  model?: string | null;
  limits: MemoryLimits;
  docs: MemoryDocRecord[];
  edits: MemoryEditRecord[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A project's scope, or undefined when its id cannot name one. */
export function projectScope(projectId: string): MemoryScope | undefined {
  return uuid.test(projectId)
    ? `project:${projectId.toLowerCase()}`
    : undefined;
}

/** The scope of a window's scope reference; undefined for an unusable project id. */
export function scopeOf(ref: MemoryScopeRef): MemoryScope | undefined {
  return ref.kind === "global" ? "global" : projectScope(ref.projectId);
}

/** Whether a string is a scope as the server writes it. */
export function isMemoryScope(value: string): value is MemoryScope {
  return (
    value === "global" ||
    (value.startsWith("project:") &&
      uuid.test(value.slice(8)) &&
      value === value.toLowerCase())
  );
}

export function utf8Bytes(text: string) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * A memory edit as one line: control characters and line breaks become
 * spaces, runs of white space collapse (the server does the same).
 */
export function cleanEdit(text: string) {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * Credentials a memory edit never stores (the same kinds the server
 * refuses with CLAUDEX_MEMORY_SENSITIVE): memory is about the person,
 * never their secrets.
 */
export const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:password|passwd|passcode|api[ _-]?key|secret[ _-]?key|access[ _-]?token|private[ _-]?key)\s*(?:is|=|:)\s*\S+/i,
];

function luhn(digits: string) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Whether the text holds something shaped like a credential or a card number. */
export function looksSecret(text: string) {
  if (secretPatterns.some((pattern) => pattern.test(text))) return true;
  for (const match of text.match(/\b\d(?:[ -]?\d){12,18}\b/g) ?? [])
    if (luhn(match.replace(/[ -]/g, ""))) return true;
  return false;
}

/**
 * Memory text placed inside a prompt cannot open or close memory tags of
 * its own (`<user_memory>`, `<user_memory_edits>`).
 */
export function inertMemoryText(text: string) {
  return text.replace(/<(\/?)(user_memory)/gi, "&lt;$1$2");
}

/** Messages the window shows for a refused memory change. */
export const memoryMessages = Object.freeze({
  unsupported: "Memory isn't available on this server yet.",
  serverKey:
    "Memory isn't available on this server yet. Contact your administrator.",
  disabled: "Memory is turned off by your administrator.",
  off: "Memory is turned off. Turn on Generate memory from chat history in Settings > Memory.",
  searchOff:
    "Searching past chats is turned off. Turn on Search and reference chats in Settings > Memory.",
  switchDisabled: "Turned off by your administrator.",
  pending: "Memory settings are still loading. Try again in a moment.",
  offline: "You're offline. Changes will be available when you reconnect.",
  conflict: "Memory changed on another device. Reload it and try again.",
  tooLarge: "This memory is too long. Shorten it and try again.",
  full: "Memory is full. Remove something and try again.",
  sensitive: memoryRefusalTexts.sensitive,
  editTooLong: memoryRefusalTexts.editTooLong,
  emptyEdit: "There's nothing to remember.",
  noScope: "This project can't keep memory.",
  broken:
    "memory.json couldn't be read. To protect your memory, the app did not overwrite it.",
  rateLimited: "Too many memory changes. Try again later.",
  importUnavailable: "Importing memory isn't available yet.",
});
