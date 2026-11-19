/** The most side chats an engine keeps threads for; the oldest is let go. */
export const maxSideChats = 8;

/** A side question is as long as a message. */
export const maxSideQuestionLength = 200_000;

/** Native notifications can arrive before turn/start returns its authoritative id. */
export const maxSideStartEvents = 128;
export const maxSideStartEventBytes = 1024 * 1024;

/**
 * What a side chat's thread is told (desktop bundle 2.31226.1: "Ask on the
 * side without touching the main chat. Claude sees the full context, and
 * nothing here is added to it."): answer from the conversation so far, in
 * words, without working.
 */
export const sideChatInstructions =
  "This is a side chat. The person is asking a quick question beside the main conversation, which you can see up to its last finished reply. Answer directly and briefly from what the conversation already shows. Do not use tools, run commands or change any file, and do not carry on the main task. Nothing said here is added to the main conversation.";

/** A side question that cannot be answered because the conversation fills the context window. */
export const sideContextFull = "This session is too long to answer from.";

/** One side chat: an ephemeral fork of a conversation's thread and the question it is answering. */
export interface SideChat {
  conversationId: string;
  threadId?: string;
  turn?: {
    /** The agent messages of the turn, by item id, in order. */
    messages: Map<string, string>;
    /** The answer so far goes to the window as it is written (a side chat's, not a handoff note's). */
    stream: boolean;
    /** The answer text last sent to the window. */
    sent?: string;
    /** Stop was asked for; the turn is interrupted as soon as it has an id. */
    stopped?: boolean;
    resolve: (answer: string) => void;
    reject: (error: Error) => void;
    turnId?: string;
    /** Keep early events private until the start response identifies this turn. */
    startPending?: boolean;
    startAttempted?: boolean;
    closedReason?: Error;
    startEvents: { method: string; params: any }[];
    startEventBytes: number;
  };
}

/** The text of a side chat's turn so far: its agent messages, one after the other. */
export function sideAnswer(messages: Map<string, string>) {
  return [...messages.values()]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");
}
