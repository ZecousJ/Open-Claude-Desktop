import { useSyncExternalStore } from "react";
import type { AppEvent } from "../../shared/types";
import { api } from "../desktop-api";

/** One line of a side chat: a question, or the answer to the one before it. */
export interface SideMessage {
  role: "user" | "assistant";
  text: string;
  /** For an answer: the question it answers. */
  question?: string;
  /** For a question: the passage it was asked about. */
  context?: string;
}

export interface SideChatState {
  open: boolean;
  /** Names the engine's fork of the conversation's thread. */
  sideChatId: string;
  messages: SideMessage[];
  /** A question is being answered. */
  thinking: boolean;
  /** The answer written so far, while the engine is still writing it (the "side-chat-text" events). */
  partial?: string;
  /** Stop was pressed and the engine has not ended the answer yet. */
  stopping?: boolean;
  /** Why the last question was not answered. */
  error?: string;
  /** The question being written; kept while the panel is closed. */
  draft: string;
  /** A passage selected in a reply, waiting to go with the next question. */
  context?: string;
}

/** How much of a selected passage a side chat takes along. */
export const sideChatContextLimit = 1500;

/**
 * The text the engine is asked: a staged passage goes first as an attached
 * quote, the way the original's side chat prefixes it ("<!-- attach -->" and
 * the passage in Markdown quote lines), then the question.
 */
export function withContext(question: string, context: string | undefined) {
  if (!context) return question;
  const quoted = context
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return `<!-- attach -->\n${quoted}\n\n${question}`;
}

/**
 * The side chats of the conversations in this window, by conversation id.
 * They live here, not in the panel, so closing the panel (or switching to
 * another conversation and back) keeps the short list of questions and
 * answers until Clear, as the original's does. Nothing here is stored: a
 * side chat ends with the window, like its fork of the thread.
 */
const states = new Map<string, SideChatState>();
const listeners = new Set<() => void>();
/** Which question each conversation is waiting for, so a cleared one is ignored. */
const asking = new Map<string, number>();
let questions = 0;

function emit() {
  for (const listener of listeners) listener();
}
function update(id: string, patch: Partial<SideChatState>) {
  const current = states.get(id) ?? fresh();
  states.set(id, { ...current, ...patch });
  emit();
}
function fresh(): SideChatState {
  return {
    open: false,
    sideChatId: crypto.randomUUID(),
    messages: [],
    thinking: false,
    draft: "",
  };
}

export const sideChatOf = (id: string | undefined) =>
  id ? states.get(id) : undefined;

/** The conversation's side chat; undefined until it was opened once. */
export function useSideChat(id: string | undefined) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => sideChatOf(id),
    () => undefined,
  );
}

export const openSideChat = (id: string) => update(id, { open: true });

/**
 * "Start a side chat" / "Send to side chat" on text selected in a reply: the
 * card opens with the passage staged as context for the next question.
 */
export function openSideChatWithContext(id: string, text: string) {
  const context = text.trim().slice(0, sideChatContextLimit);
  update(id, context ? { open: true, context } : { open: true });
}

/** Takes the staged passage off the next question (its remove button). */
export const clearSideChatContext = (id: string) =>
  update(id, { context: undefined });

/**
 * Whether the conversation's side chat has been used: the selection menu
 * then reads "Send to side chat" instead of "Start a side chat".
 */
export const sideChatStarted = (id: string | undefined) =>
  Boolean(sideChatOf(id)?.messages.length);

/**
 * `/btw <question>`: opens the card and asks at once. A question still being
 * answered cannot take another, so the text waits in the field instead.
 */
export async function askSideChatNow(id: string, text: string) {
  const question = text.trim();
  openSideChat(id);
  if (!question) return;
  if (states.get(id)?.thinking) return setSideChatDraft(id, question);
  await askSideChat(id, question);
}
export const closeSideChat = (id: string) => {
  if (states.get(id)?.open) update(id, { open: false });
};
export function toggleSideChat(id: string) {
  update(id, { open: !states.get(id)?.open });
}
export const setSideChatDraft = (id: string, draft: string) =>
  update(id, { draft });

/** Asks a question on the side; the answer joins the list when it arrives. */
export async function askSideChat(id: string, text: string) {
  const question = text.trim();
  const state = states.get(id);
  if (!state || state.thinking || !question) return;
  const token = ++questions;
  asking.set(id, token);
  update(id, {
    messages: [
      ...state.messages,
      state.context
        ? { role: "user", text: question, context: state.context }
        : { role: "user", text: question },
    ],
    thinking: true,
    partial: undefined,
    stopping: false,
    error: undefined,
    draft: "",
    context: undefined,
  });
  try {
    const answer = await api.askSideChat(
      id,
      state.sideChatId,
      withContext(question, state.context),
    );
    if (asking.get(id) !== token) return;
    const now = states.get(id)!;
    update(id, {
      messages: [
        ...now.messages,
        { role: "assistant", text: answer, question },
      ],
      thinking: false,
      partial: undefined,
      stopping: false,
    });
  } catch (error) {
    if (asking.get(id) !== token) return;
    // The unanswered question goes back into the field to be sent again.
    // One that was stopped before anything was written is not a failure.
    const now = states.get(id)!;
    update(id, {
      messages: now.messages.slice(0, -1),
      thinking: false,
      partial: undefined,
      stopping: false,
      error: now.stopping
        ? undefined
        : (error as Error).message || "Couldn’t get an answer. Try again.",
      draft: now.draft || question,
      context: now.context ?? state.context,
    });
  } finally {
    if (asking.get(id) === token) asking.delete(id);
  }
}

/**
 * The answer so far, from the engine ("side-chat-text"; it carries the whole
 * text, so a missed event costs nothing). Ignored once the question is
 * answered, stopped for good, or cleared.
 */
export function applySideChatText(
  event: Extract<AppEvent, { type: "side-chat-text" }>,
) {
  const state = states.get(event.conversationId);
  if (
    !state ||
    !state.thinking ||
    state.sideChatId !== event.sideChatId ||
    !asking.has(event.conversationId) ||
    state.partial === event.text
  )
    return;
  update(event.conversationId, { partial: event.text });
}

/**
 * Stop: the engine ends the answer where it is. What was written stays as the
 * answer; a question stopped before any text goes back into the field.
 */
export async function stopSideChat(id: string) {
  const state = states.get(id);
  if (!state?.thinking || state.stopping) return;
  update(id, { stopping: true });
  try {
    await api.interruptSideChat(id, state.sideChatId);
  } catch {
    // The engine could not be reached: Stop can be pressed again.
    if (states.get(id)?.thinking) update(id, { stopping: false });
  }
}

/** Clear side chat: the list goes, a question still being answered is stopped, the fork is released. */
export function clearSideChat(id: string) {
  const state = states.get(id);
  if (!state) return;
  asking.delete(id);
  // A new fork for the next question: this one is let go.
  void Promise.resolve(api.endSideChat(id, state.sideChatId)).catch(() => {});
  states.set(id, { ...fresh(), open: state.open });
  emit();
}

/** Forgets every side chat (tests). */
export function resetSideChats() {
  states.clear();
  asking.clear();
  emit();
}
