import type { Conversation, ConversationBranch, Turn } from "./types";
import {
  webLimits,
  object,
  string,
  integer,
  boolean,
  oneOf,
  parseJson,
} from "./web-protocol";
import { fail } from "./web-wire";
import type { Json } from "./web-protocol";

// ---------------------------------------------------------------------------
// Stored documents (webstore), schema v1

export const webDocSchema = 1;

/**
 * One turn row (claudex_web_turns.doc). `branchId` is null for the live
 * transcript and a `savedBranches` id for a saved branch's turns. `ordinal`
 * orders the turns of one branch from 0. `turn` keeps every field of
 * shared/types.ts `Turn` and its items, including ones this file does not
 * know (the Go side stores it as raw JSON).
 */
export interface TurnDoc {
  schema: 1;
  conversationId: string;
  branchId: string | null;
  turnId: string;
  ordinal: number;
  turn: Turn;
}

/** A saved branch without its turns (those are TurnDoc rows). */
export type BranchMeta = Omit<ConversationBranch, "turns">;

/** The conversation row (claudex_web_conversations.doc) without turns. */
export type ConversationMeta = Omit<Conversation, "turns" | "savedBranches"> & {
  savedBranches?: BranchMeta[];
};

export interface ConversationDoc {
  schema: 1;
  conversation: ConversationMeta;
}

const turnStatuses = [
  "inProgress",
  "completed",
  "failed",
  "interrupted",
] as const;

const modes = ["chat", "cowork", "code"] as const;

const docIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

function docId(value: unknown, what: string) {
  const id = string(value, what);
  if (!docIdPattern.test(id)) fail(`${what} has the wrong shape`);
  return id;
}

function byteLength(text: string) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function checkTurn(value: unknown, what: string): Turn {
  const turn = object(value, what);
  docId(turn.id, `${what}.id`);
  string(turn.prompt, `${what}.prompt`, true);
  if (!Array.isArray(turn.attachments))
    fail(`${what}.attachments must be an array`);
  if (!Array.isArray(turn.items)) fail(`${what}.items must be an array`);
  turn.items.forEach((item, index) => {
    const row = object(item, `${what}.items[${index}]`);
    string(row.id, `${what}.items[${index}].id`);
    string(row.type, `${what}.items[${index}].type`);
  });
  oneOf(turn.status, turnStatuses, `${what}.status`);
  integer(turn.createdAt, `${what}.createdAt`);
  return turn as unknown as Turn;
}

function checkMeta(value: unknown): ConversationMeta {
  const meta = object(value, "conversation");
  if ("turns" in meta) fail("conversation must not carry turns");
  docId(meta.id, "conversation.id");
  string(meta.title, "conversation.title", true);
  oneOf(meta.mode, modes, "conversation.mode");
  string(meta.providerId, "conversation.providerId", true);
  string(meta.model, "conversation.model", true);
  boolean(meta.pinned, "conversation.pinned");
  boolean(meta.archived, "conversation.archived");
  integer(meta.createdAt, "conversation.createdAt");
  integer(meta.updatedAt, "conversation.updatedAt");
  if (meta.incognito === true) fail("incognito conversations are never stored");
  if (meta.savedBranches !== undefined) {
    if (!Array.isArray(meta.savedBranches))
      fail("conversation.savedBranches must be an array");
    meta.savedBranches.forEach((branch, index) => {
      const row = object(branch, `conversation.savedBranches[${index}]`);
      docId(row.id, `conversation.savedBranches[${index}].id`);
      if ("turns" in row)
        fail(`conversation.savedBranches[${index}] must not carry turns`);
    });
  }
  return meta as unknown as ConversationMeta;
}

/** Validates a stored or received turn document (schema, ids, size). */
export function parseTurnDoc(text: string | Json): TurnDoc {
  if (typeof text === "string" && byteLength(text) > webLimits.turnDocBytes)
    fail("turn document is too large");
  const json = parseJson(text);
  if (json.schema !== webDocSchema) fail("unsupported turn document schema");
  const doc: TurnDoc = {
    schema: 1,
    conversationId: docId(json.conversationId, "conversationId"),
    branchId: json.branchId === null ? null : docId(json.branchId, "branchId"),
    turnId: docId(json.turnId, "turnId"),
    ordinal: integer(json.ordinal, "ordinal"),
    turn: checkTurn(json.turn, "turn"),
  };
  if (doc.turn.id !== doc.turnId) fail("turn.id must equal turnId");
  if (typeof text !== "string") {
    if (byteLength(JSON.stringify(json)) > webLimits.turnDocBytes)
      fail("turn document is too large");
  }
  return doc;
}

export function parseConversationDoc(text: string | Json): ConversationDoc {
  const json = parseJson(text);
  if (json.schema !== webDocSchema)
    fail("unsupported conversation document schema");
  return { schema: 1, conversation: checkMeta(json.conversation) };
}

/** Splits a conversation into its row and its turn rows (live and saved). */
export function splitConversation(conversation: Conversation): {
  doc: ConversationDoc;
  turns: TurnDoc[];
} {
  if (conversation.incognito) fail("incognito conversations are never stored");
  const { turns, savedBranches, ...rest } = conversation;
  const meta: ConversationMeta = { ...rest };
  const rows: TurnDoc[] = [];
  const add = (branchId: string | null, list: Turn[]) =>
    list.forEach((turn, ordinal) =>
      rows.push({
        schema: 1,
        conversationId: conversation.id,
        branchId,
        turnId: turn.id,
        ordinal,
        turn,
      }),
    );
  add(null, turns);
  if (savedBranches) {
    meta.savedBranches = savedBranches.map(
      ({ turns: branchTurns, ...branch }) => {
        add(branch.id, branchTurns);
        return branch;
      },
    );
  }
  return { doc: { schema: 1, conversation: meta }, turns: rows };
}

/** Rebuilds a conversation from its row and turn rows (any order). */
export function joinConversation(
  doc: ConversationDoc,
  turns: TurnDoc[],
): Conversation {
  const { savedBranches, ...meta } = doc.conversation;
  const byBranch = new Map<string | null, TurnDoc[]>();
  for (const row of turns) {
    if (row.conversationId !== meta.id)
      fail(`turn ${row.turnId} belongs to another conversation`);
    const list = byBranch.get(row.branchId) ?? [];
    list.push(row);
    byBranch.set(row.branchId, list);
  }
  const ordered = (branchId: string | null) =>
    (byBranch.get(branchId) ?? [])
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => row.turn);
  const known = new Set<string | null>([
    null,
    ...(savedBranches ?? []).map((branch) => branch.id),
  ]);
  for (const branchId of byBranch.keys())
    if (!known.has(branchId)) fail(`unknown branch ${branchId}`);
  const conversation: Conversation = { ...meta, turns: ordered(null) };
  if (savedBranches)
    conversation.savedBranches = savedBranches.map((branch) => ({
      ...branch,
      turns: ordered(branch.id),
    }));
  return conversation;
}
