/**
 * The past-chats index (R3 design 3.5): a full-text index over the titles
 * and messages of this computer's Chat and Cowork conversations, which the
 * `conversation_search` and `recent_chats` tools query.
 *
 * It lives in memory only, is built from the conversations the app already
 * holds, and is refreshed by comparing each conversation with what was
 * indexed: nothing is written to disk and nothing leaves the computer
 * except what the model asks for through the tool, one small result at a
 * time. Incognito chats are never indexed, the current chat is left out
 * of its own results, and a chat in a project only sees that project's
 * chats while a chat outside projects never sees project chats.
 */
import type { Conversation, Item, Turn } from "../../shared/types";

/** Longest text kept per message (the rest is not searchable). */
const messageChars = 4_000;
/** Most messages kept per conversation. */
const messagesPerChat = 400;
/** Longest snippet a result carries. */
export const snippetChars = 300;

export interface ChatSearchScope {
  /** The conversation asking; it never finds itself. */
  currentId?: string;
  /** The asking conversation's project: only that project's chats, or none. */
  projectId?: string;
}

export interface ChatHit {
  id: string;
  title: string;
  updatedAt: number;
  archived: boolean;
  snippets: string[];
}

interface Entry {
  signature: string;
  id: string;
  title: string;
  updatedAt: number;
  archived: boolean;
  projectId?: string;
  messages: string[];
  /** Term counts over the title (counted three times) and messages. */
  terms: Map<string, number>;
  length: number;
  last?: { prompt: string; reply: string };
}

const stopWords = new Set(
  "a an and are as at be but by for from has have i in is it its of on or that the this to was we with you your me my do does did not can could would should will about what when where which who how".split(
    " ",
  ),
);

const cjk = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

/** Lowercased words; each CJK character also counts with its neighbour. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (!cjk.test(word)) {
      out.push(word);
      continue;
    }
    // Text without spaces cannot be split into words: characters and pairs.
    const chars = [...word];
    for (let i = 0; i < chars.length; i++) {
      out.push(chars[i]);
      if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
    }
  }
  return out;
}

function queryTerms(query: string): string[] {
  const all = tokenize(query);
  const useful = all.filter((term) => !stopWords.has(term));
  return [...new Set(useful.length ? useful : all)];
}

function assistantText(items: Item[]) {
  return items
    .filter(
      (item) => item.type === "agentMessage" && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("\n\n");
}

const clip = (text: string, chars: number) =>
  text.length > chars ? text.slice(0, chars) : text;

/** Chat and Cowork conversations carry memory; Code sessions do not. */
export function searchable(conversation: Conversation) {
  return (
    !conversation.incognito &&
    (conversation.mode === "chat" || conversation.mode === "cowork")
  );
}

function signature(conversation: Conversation) {
  const last = conversation.turns[conversation.turns.length - 1];
  return [
    conversation.title,
    conversation.updatedAt,
    conversation.archived ? 1 : 0,
    conversation.projectId ?? "",
    conversation.turns.length,
    last?.status ?? "",
    last?.items.length ?? 0,
    last?.prompt.length ?? 0,
    // A reply still being written grows without a new item.
    last ? assistantText(last.items).length : 0,
  ].join("|");
}

function build(conversation: Conversation, signatureText: string): Entry {
  const messages: string[] = [];
  let lastTurn: Turn | undefined;
  for (const turn of conversation.turns) {
    if (messages.length >= messagesPerChat) break;
    if (turn.prompt.trim()) messages.push(clip(turn.prompt, messageChars));
    const reply = assistantText(turn.items);
    if (reply.trim()) messages.push(clip(reply, messageChars));
    lastTurn = turn;
  }
  const terms = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const term of tokenize(text))
      terms.set(term, (terms.get(term) ?? 0) + weight);
  };
  add(conversation.title, 3);
  for (const message of messages) add(message, 1);
  let length = 0;
  for (const count of terms.values()) length += count;
  return {
    signature: signatureText,
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    archived: conversation.archived,
    ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
    messages,
    terms,
    length: Math.max(length, 1),
    ...(lastTurn
      ? {
          last: {
            prompt: clip(lastTurn.prompt, snippetChars),
            reply: clip(assistantText(lastTurn.items), snippetChars),
          },
        }
      : {}),
  };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** About `snippetChars` of text around the first of `terms` it contains. */
function excerpt(message: string, terms: string[]) {
  const text = oneLine(message);
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return undefined;
  const start = Math.max(0, at - Math.floor(snippetChars / 3));
  const end = Math.min(text.length, start + snippetChars);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export interface RecentOptions {
  n: number;
  before?: number;
  after?: number;
  order: "asc" | "desc";
}

export class ChatSearchIndex {
  private entries = new Map<string, Entry>();
  constructor(private conversations: () => readonly Conversation[]) {}

  /** Brings the index up to date with the conversations. */
  private sync() {
    const seen = new Set<string>();
    for (const conversation of this.conversations()) {
      if (!searchable(conversation)) continue;
      seen.add(conversation.id);
      const sig = signature(conversation);
      if (this.entries.get(conversation.id)?.signature !== sig)
        this.entries.set(conversation.id, build(conversation, sig));
    }
    for (const id of [...this.entries.keys()])
      if (!seen.has(id)) this.entries.delete(id);
  }

  /** Number of conversations indexed now. */
  size() {
    this.sync();
    return this.entries.size;
  }

  /** Drops everything indexed (sign-out, memory turned off). */
  clear() {
    this.entries.clear();
  }

  private visible(scope: ChatSearchScope): Entry[] {
    this.sync();
    return [...this.entries.values()].filter(
      (entry) =>
        entry.id !== scope.currentId &&
        (entry.projectId ?? "") === (scope.projectId ?? ""),
    );
  }

  /** Conversations matching the words, best first (BM25 over titles and messages). */
  search(query: string, scope: ChatSearchScope, limit = 5): ChatHit[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const pool = this.visible(scope);
    if (!pool.length) return [];
    const average =
      pool.reduce((sum, entry) => sum + entry.length, 0) / pool.length;
    const documents = new Map<string, number>();
    for (const term of terms)
      documents.set(
        term,
        pool.reduce((sum, entry) => sum + (entry.terms.has(term) ? 1 : 0), 0),
      );
    const scored: { entry: Entry; score: number }[] = [];
    for (const entry of pool) {
      let score = 0;
      for (const term of terms) {
        const count = entry.terms.get(term);
        if (!count) continue;
        const df = documents.get(term) ?? 0;
        const idf = Math.log(1 + (pool.length - df + 0.5) / (df + 0.5));
        const k = 1.2 * (0.25 + (0.75 * entry.length) / average);
        score += (idf * count * 2.2) / (count + k);
      }
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt,
    );
    return scored.slice(0, limit).map(({ entry }) => {
      const snippets: string[] = [];
      for (const message of entry.messages) {
        const found = excerpt(message, terms);
        if (found) snippets.push(found);
        if (snippets.length === 2) break;
      }
      return this.hit(entry, snippets);
    });
  }

  /** The newest (or oldest) conversations, each with its last exchange. */
  recent(options: RecentOptions, scope: ChatSearchScope): ChatHit[] {
    const sorted = this.visible(scope)
      .filter(
        (entry) =>
          (options.before === undefined || entry.updatedAt < options.before) &&
          (options.after === undefined || entry.updatedAt > options.after),
      )
      .sort((a, b) =>
        options.order === "asc"
          ? a.updatedAt - b.updatedAt
          : b.updatedAt - a.updatedAt,
      );
    return sorted.slice(0, options.n).map((entry) => {
      const snippets = [
        entry.last?.prompt && `User: ${oneLine(entry.last.prompt)}`,
        entry.last?.reply && `Assistant: ${oneLine(entry.last.reply)}`,
      ].filter((value): value is string => !!value);
      return this.hit(entry, snippets);
    });
  }

  private hit(entry: Entry, snippets: string[]): ChatHit {
    return {
      id: entry.id,
      title: entry.title,
      updatedAt: entry.updatedAt,
      archived: entry.archived,
      snippets,
    };
  }
}
