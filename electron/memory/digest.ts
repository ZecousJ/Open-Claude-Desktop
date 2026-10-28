/**
 * What the memory summary reads (R3 design 3.6 steps 1 and 5): which
 * conversations are new since the last run, and each one boiled down to a
 * short digest of who said what.
 *
 * Only Chat and Cowork conversations that are not incognito count, and only
 * when they hold a finished reply. A chat in a project belongs to that
 * project's memory (a project without a usable id has none, so its chats are
 * not read at all, rather than leaking into the global memory). Text that
 * looks like a credential is replaced before it is sent anywhere.
 */
import type { Conversation, Item, Turn } from "../../shared/types";
import { searchable } from "./chat-search";
import { projectScope, secretPatterns, type MemoryScope } from "./types";

/** Most conversations in one batch. */
export const batchChats = 20;
/** Most characters of digests in one batch. */
export const batchChars = 60_000;
/** Most characters one conversation's digest takes. */
export const chatDigestChars = 6_000;
const promptChars = 1_500;
const replyChars = 900;

/** The conversation's last processed `updatedAt`, by id. */
export type MemoryCursor = Record<string, number>;

const replacement = "[redacted]";

/** The text with credential-shaped parts replaced. */
export function redactSecrets(text: string) {
  let out = text;
  for (const pattern of secretPatterns) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    out = out.replace(new RegExp(pattern.source, flags), replacement);
  }
  // Card numbers (13 to 19 digits, spaces or dashes allowed).
  return out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (match) =>
    /^[\d -]+$/.test(match) ? replacement : match,
  );
}

function replyText(items: Item[]) {
  return items
    .filter(
      (item) => item.type === "agentMessage" && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("\n")
    .trim();
}

const clip = (text: string, chars: number) =>
  text.length <= chars ? text : `${text.slice(0, chars).trimEnd()}…`;

const finished = (turn: Turn) =>
  turn.status === "completed" && replyText(turn.items).length > 0;

/** The scope the conversation's memory belongs to; undefined when it has none. */
export function synthesisScope(
  conversation: Pick<Conversation, "projectId">,
): MemoryScope | undefined {
  return conversation.projectId
    ? projectScope(conversation.projectId)
    : "global";
}

export interface Candidate {
  conversation: Conversation;
  scope: MemoryScope;
}

/**
 * Conversations changed since the cursor, oldest change first. Left out:
 * incognito chats, Code sessions, chats without a finished reply, chats
 * whose latest turn is still running (they are read once it finishes) and
 * chats of a project that cannot keep memory.
 */
export function candidates(
  conversations: readonly Conversation[],
  cursor: MemoryCursor,
): Candidate[] {
  const result: Candidate[] = [];
  for (const conversation of conversations) {
    if (!searchable(conversation)) continue;
    if ((cursor[conversation.id] ?? 0) >= conversation.updatedAt) continue;
    const last = conversation.turns[conversation.turns.length - 1];
    if (!last || last.status === "inProgress") continue;
    if (!conversation.turns.some(finished)) continue;
    const scope = synthesisScope(conversation);
    if (!scope) continue;
    result.push({ conversation, scope });
  }
  return result.sort(
    (a, b) => a.conversation.updatedAt - b.conversation.updatedAt,
  );
}

/** One conversation as text: the title, then the exchanges (the middle is dropped when long). */
export function conversationDigest(conversation: Conversation): string {
  const exchanges = conversation.turns
    .filter(finished)
    .map(
      (turn) =>
        `User: ${clip(redactSecrets(turn.prompt.trim()), promptChars)}\nAssistant: ${clip(redactSecrets(replyText(turn.items)), replyChars)}`,
    );
  const date = new Date(conversation.updatedAt).toISOString().slice(0, 10);
  const title = redactSecrets(conversation.title).replace(/\s+/g, " ").trim();
  const head = `<chat title="${title.replace(/"/g, "'").replace(/</g, "&lt;")}" date="${date}">`;
  const tail = "</chat>";
  let body = exchanges.join("\n\n");
  const room = chatDigestChars - head.length - tail.length - 4;
  if (body.length > room) {
    // Keep the start and the end, where topics and outcomes are.
    const first = Math.floor(room * 0.4);
    const last = room - first - 20;
    body = `${body.slice(0, first)}\n[…]\n${body.slice(body.length - last)}`;
  }
  return `${head}\n${body}\n${tail}`;
}

export interface Batch {
  scope: MemoryScope;
  chats: Candidate[];
  digests: string[];
  /** Candidates of this scope left for the next run. */
  remaining: number;
}

/**
 * The next batch for a scope: at most `batchChats` conversations and
 * `batchChars` characters of digests, oldest first; the rest wait.
 */
export function nextBatch(
  scope: MemoryScope,
  pool: Candidate[],
): Batch | undefined {
  const mine = pool.filter((candidate) => candidate.scope === scope);
  const chats: Candidate[] = [];
  const digests: string[] = [];
  let used = 0;
  for (const candidate of mine) {
    if (chats.length >= batchChats) break;
    const digest = conversationDigest(candidate.conversation);
    if (chats.length && used + digest.length > batchChars) break;
    chats.push(candidate);
    digests.push(digest);
    used += digest.length;
  }
  if (!chats.length) return undefined;
  return { scope, chats, digests, remaining: mine.length - chats.length };
}

/** The scopes with something new, "global" first. */
export function scopesWithNews(pool: Candidate[]): MemoryScope[] {
  const scopes = [...new Set(pool.map((candidate) => candidate.scope))];
  return scopes.sort((a, b) =>
    a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b),
  );
}
