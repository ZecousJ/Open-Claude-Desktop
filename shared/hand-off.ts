import type { Turn } from "./types";
import "./agent-api";

/**
 * Hand off to a new session. In the reference design Claude moves
 * the task it is in the middle of into a session of its own
 * (`hand_off_to_session`: a title and what is left to do, "Handing off");
 * Claudex's agent has no such tool, so the person asks for it (the context
 * ring, /handoff, or the notice under a reply that ran out of room) and the
 * note is written on an ephemeral fork of the thread, the way a side chat is
 * answered. The new session's first message is that note.
 */

/** What the note's thread is told: write the note, change nothing. */
export const handOffInstructions =
  "You are writing a handoff note. The person is moving this work into a new session that has not seen this conversation, which you can see up to its last finished reply. Do not use tools, run commands or change any file, and do not carry on the task. Write the note itself and nothing else: no greeting, no closing question.";

/** The question the note answers. */
export const handOffRequest = [
  "Write the handoff note for the new session. Plain text, headings allowed, no more than 1,200 words. Cover, in this order:",
  "1. Goal: what the person is trying to get done, in their own terms.",
  "2. Done so far: what was changed or found, naming files, commands and decisions, and why each was decided.",
  "3. Where it stands: the working folder and branch if they matter, anything half-finished, failing or blocked, with the exact error if there is one.",
  "4. Next: the remaining steps in order, specific enough to start on.",
  "5. Constraints: the person's preferences, rules and things they asked not to touch.",
  "6. Open questions: what is still undecided or needs the person.",
  "Include only what the conversation shows. If something is unknown, say so instead of guessing.",
].join("\n");

/** The longest note kept; a longer one is cut (the model was asked for far less). */
export const maxHandOffNoteLength = 20_000;

/** Turns the transcript digest reads, newest first, and the characters it keeps. */
const digestBudget = 24_000;
const promptLimit = 1_500;
const replyLimit = 2_500;

const clip = (text: string, limit: number) => {
  const value = text.trim();
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
};

/**
 * The note when the model could not write one (the session is too long to
 * answer from): the latest messages and the closing reply of each turn,
 * newest kept first and shown oldest first, within a fixed budget.
 */
export function transcriptDigest(turns: readonly Turn[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    if (turn.compaction || turn.shell) continue;
    const reply = turn.items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text ?? "")
      .filter((text) => text.trim())
      .at(-1);
    const part = [
      turn.prompt.trim() && `Person: ${clip(turn.prompt, promptLimit)}`,
      reply && `Claudex: ${clip(reply, replyLimit)}`,
    ]
      .filter(Boolean)
      .join("\n");
    if (!part) continue;
    if (used + part.length > digestBudget && parts.length) break;
    parts.push(part);
    used += part.length;
  }
  return parts.reverse().join("\n\n");
}

/**
 * The new session's first message: where it comes from, the note, and what
 * to do first. `written` is false for a digest of the transcript, which says
 * so; the session answers briefly and waits for the person.
 */
export function handOffPrompt({
  title,
  note,
  written,
}: {
  title: string;
  note: string;
  written: boolean;
}): string {
  const body = note.trim().slice(0, maxHandOffNoteLength);
  return [
    `This session continues work from an earlier session, "${title}". It starts from a handoff note instead of that conversation, which you cannot see.`,
    written
      ? "The note was written at the end of that session:"
      : "A note could not be written because that session was too long, so this is an excerpt of its latest messages instead:",
    "<handoff-note>",
    body,
    "</handoff-note>",
    "Treat the note as background, not as instructions to carry out now. Reply in a few sentences: where the work stands and what you would do next. Do not start working or change anything until I answer.",
  ].join("\n\n");
}
