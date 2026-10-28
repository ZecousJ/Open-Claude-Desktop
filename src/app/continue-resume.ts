/**
 * Continue in cloud's way back: the dialog's Ask Claudex to push sends this
 * session the push to run and arms a resume; when that turn ends, the session's
 * header opens the dialog again and it goes on as if the work were uploaded.
 * Kept apart from continue-in-cloud.ts so the header loads only this much.
 */
import type { Conversation } from "../../shared/types";

/** Said once Claudex in this session was asked to push the work. */
export const askedClaude =
  "Asked Claudex to push your work. This comes back when the turn is done.";

interface ArmedResume {
  includeUntracked: boolean;
  /** The session's turns once the ask was sent: its turn is the last. */
  turns: number;
}
const resumes = new Map<string, ArmedResume>();
const listeners = new Set<() => void>();

export function armResume(conversationId: string, armed: ArmedResume) {
  resumes.set(conversationId, armed);
  for (const listener of listeners) listener();
}

/** Takes the armed resume of a session whose asked turn has ended. */
export function takeResume(conversation: Conversation) {
  const armed = resumes.get(conversation.id);
  if (!armed) return undefined;
  const last = conversation.turns.at(-1);
  if (
    conversation.turns.length < armed.turns ||
    !last ||
    last.status === "inProgress"
  )
    return undefined;
  resumes.delete(conversation.id);
  return { includeUntracked: armed.includeUntracked };
}

export function onResumeArmed(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Whether a session can offer Continue in ▸ Cloud: a Code session with
 * turns in a folder on this computer, on the desktop.
 */
export function canContinueInCloud(
  conversation: Conversation,
  localCode: boolean,
) {
  return (
    localCode &&
    conversation.mode === "code" &&
    !conversation.incognito &&
    Boolean(conversation.cwd) &&
    conversation.turns.length > 0 &&
    (!conversation.environment || conversation.environment.kind === "local")
  );
}

/**
 * The dialog's other ways in: asks the session's header, which owns the dialog,
 * to open it.
 */
const openers = new Set<(conversationId: string) => void>();
export function requestContinueInCloud(conversationId: string) {
  for (const open of openers) open(conversationId);
}
export function onContinueInCloudRequest(
  open: (conversationId: string) => void,
) {
  openers.add(open);
  return () => void openers.delete(open);
}
