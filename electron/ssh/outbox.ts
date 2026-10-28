/**
 * Messages written to an SSH conversation while its host is unreachable
 * (R9). They wait here, in the account's profile (so they survive a
 * restart), and are sent once when the host is back.
 *
 * Exactly once: every message has an id that goes to Codex as the turn's
 * `clientUserMessageId`, and Codex keeps it with the user message in the
 * thread (as `clientId`, also after the app-server restarts). A message
 * whose `turn/start` may have reached the host before the connection
 * dropped is marked `attempted`; before sending it again the engine reads
 * the thread and looks for that id (`deliveredIn`). One message waits per
 * conversation at a time.
 *
 * The conversation shows the waiting message as a turn whose id is the
 * entry's id (`outbox-…`), in progress with a "Will send when <host>
 * reconnects" note; Stop removes it from here.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Attachment, Mode, Turn } from "../../shared/types";

export const OUTBOX_FILE = "ssh-outbox.json";
/** The id prefix of waiting messages and of the turns that show them. */
export const OUTBOX_PREFIX = "outbox-";
/** Most messages that can wait at once (one per conversation). */
export const MAX_OUTBOX_ENTRIES = 100;

export interface OutboxEntry {
  /** `outbox-<uuid>`: the placeholder turn's id and Codex's clientUserMessageId. */
  id: string;
  conversationId: string;
  hostId: string;
  text: string;
  attachments: Attachment[];
  mode: Mode;
  providerId: string;
  model: string;
  createdAt: number;
  /** turn/start was sent and its answer never came: check before resending. */
  attempted?: boolean;
}

export const newOutboxId = () => OUTBOX_PREFIX + randomUUID();

/** A turn standing for a message that waits in the outbox. */
export const isOutboxTurn = (turn: Pick<Turn, "id"> | undefined) =>
  !!turn && turn.id.startsWith(OUTBOX_PREFIX);

/** What the conversation shows under a waiting message. */
export const waitingNote = (label: string) =>
  `Will send when ${label} reconnects`;

const id = /^outbox-[0-9a-f-]{36}$/;
const plainId = /^[A-Za-z0-9_.:-]{1,200}$/;

function validAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    typeof a.path === "string" &&
    (a.kind === "image" || a.kind === "text" || a.kind === "document") &&
    typeof a.size === "number"
  );
}

function valid(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    id.test(e.id) &&
    typeof e.conversationId === "string" &&
    e.conversationId.length <= 500 &&
    typeof e.hostId === "string" &&
    plainId.test(e.hostId) &&
    typeof e.text === "string" &&
    e.text.length <= 200_000 &&
    Array.isArray(e.attachments) &&
    e.attachments.length <= 12 &&
    e.attachments.every(validAttachment) &&
    (e.mode === "chat" || e.mode === "cowork" || e.mode === "code") &&
    typeof e.providerId === "string" &&
    e.providerId.length <= 500 &&
    typeof e.model === "string" &&
    e.model.length <= 200 &&
    typeof e.createdAt === "number" &&
    (e.attempted === undefined || typeof e.attempted === "boolean")
  );
}

/** The waiting messages of one account (<profile>/ssh-outbox.json, 0600). */
export class Outbox {
  private entries: OutboxEntry[];
  readonly file: string;

  constructor(root: string) {
    this.file = path.join(root, OUTBOX_FILE);
    this.entries = this.read();
  }

  private read(): OutboxEntry[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      // A damaged entry is dropped on its own; the others still wait.
      return value.filter(valid).slice(0, MAX_OUTBOX_ENTRIES);
    } catch {
      return [];
    }
  }

  private write() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    if (!this.entries.length) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.writeFileSync(temporary, JSON.stringify(this.entries), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.file);
  }

  /** Waiting messages, oldest first; only one host's with `hostId`. */
  list(hostId?: string): OutboxEntry[] {
    return this.entries
      .filter((entry) => hostId === undefined || entry.hostId === hostId)
      .map((entry) => structuredClone(entry));
  }

  get(entryId: string): OutboxEntry | undefined {
    const entry = this.entries.find((value) => value.id === entryId);
    return entry && structuredClone(entry);
  }

  /** The message waiting in a conversation, if any. */
  forConversation(conversationId: string): OutboxEntry | undefined {
    const entry = this.entries.find(
      (value) => value.conversationId === conversationId,
    );
    return entry && structuredClone(entry);
  }

  /** Adds a message, or updates the waiting one with the same id. */
  put(entry: OutboxEntry) {
    if (!valid(entry)) throw new Error("This message can't wait to be sent.");
    const index = this.entries.findIndex((value) => value.id === entry.id);
    if (index >= 0) this.entries[index] = structuredClone(entry);
    else {
      if (this.entries.some((v) => v.conversationId === entry.conversationId))
        throw new Error(
          "A message is already waiting in this conversation. Send the next one after it.",
        );
      if (this.entries.length >= MAX_OUTBOX_ENTRIES)
        throw new Error("Too many messages are waiting to be sent.");
      this.entries.push(structuredClone(entry));
    }
    this.write();
  }

  /** Marks that turn/start may have reached the host. */
  markAttempted(entryId: string) {
    const entry = this.entries.find((value) => value.id === entryId);
    if (!entry || entry.attempted) return;
    entry.attempted = true;
    this.write();
  }

  remove(entryId: string) {
    const before = this.entries.length;
    this.entries = this.entries.filter((value) => value.id !== entryId);
    if (this.entries.length !== before) this.write();
  }

  /** Drops the waiting messages of conversations that no longer exist or of a removed host. */
  prune(keep: (entry: OutboxEntry) => boolean) {
    const before = this.entries.length;
    this.entries = this.entries.filter(keep);
    if (this.entries.length !== before) this.write();
  }
}

/**
 * The thread's turn that holds the message (`thread/read` with
 * `includeTurns`), if Codex received it: a user message whose clientId is
 * the entry's id.
 */
export function deliveredIn(
  thread: unknown,
  entryId: string,
): { turnId: string; status?: string } | undefined {
  const turns = (thread as { turns?: unknown } | undefined)?.turns;
  if (!Array.isArray(turns)) return undefined;
  for (const turn of turns) {
    const items = (turn as { items?: unknown })?.items;
    if (!Array.isArray(items)) continue;
    if (
      items.some(
        (item) =>
          (item as { type?: unknown })?.type === "userMessage" &&
          (item as { clientId?: unknown }).clientId === entryId,
      )
    )
      return {
        turnId: String((turn as { id?: unknown }).id ?? ""),
        status:
          typeof (turn as { status?: unknown }).status === "string"
            ? (turn as { status: string }).status
            : undefined,
      };
  }
  return undefined;
}
