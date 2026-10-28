import type { Conversation } from "./types";

/**
 * The words of the "a turn finished" notification, shared by the desktop's
 * banners (electron/attention-rules.ts) and the web's browser notifications
 * (src/web-notifications.ts). After the original's idle banner: the session's
 * title, else the product it belongs to ("Claude Code", "Cowork"); "Claude
 * finished a task", or "Claude is waiting for your input" when the turn stopped
 * with an error.
 */

/** What a banner falls back to when its session has no title. */
export function productName(mode: Conversation["mode"]) {
  return mode === "code"
    ? "Claudex Code"
    : mode === "cowork"
      ? "Cowork"
      : "Claudex";
}

/** One line of at most `limit` characters, cut with an ellipsis. */
export function clip(text: string | undefined, limit = 100) {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : line;
}

export const finishedText = "Claudex finished a task";
export const waitingText = "Claudex is waiting for your input";

/**
 * The notice for a conversation whose turn just ended, or undefined when
 * it says nothing (interrupted by the person, or no turn).
 */
export function finishedNotice(
  c: Pick<Conversation, "title" | "mode" | "turns">,
): { title: string; body: string; failed: boolean } | undefined {
  const last = c.turns.at(-1);
  if (!last || last.status === "interrupted" || last.status === "inProgress")
    return undefined;
  const failed = last.status === "failed";
  return {
    title: clip(c.title) || productName(c.mode),
    body: failed ? waitingText : finishedText,
    failed,
  };
}
