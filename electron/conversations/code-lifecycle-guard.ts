import type { Conversation } from "../../shared/types";

// Shared with the real Engine: another window cannot send while lifecycle work awaits.
const pending = new WeakSet<Conversation>();
export const codeSessionLifecyclePending = (c: Conversation) => pending.has(c);

export function beginCodeSessionLifecycle(c: Conversation) {
  if (pending.has(c))
    throw Error("A Code session change is already in progress.");
  pending.add(c);
  return () => pending.delete(c);
}
export function assertCodeSessionSendAvailable(c: Conversation) {
  if (c.importedSessionResumePending)
    throw Error("Confirm that you trust this imported session before resuming it.");
  if (pending.has(c))
    throw Error("Wait for the Code session change to finish before sending.");
  if (c.mode !== "code") return;
  if (c.archived || c.worktree?.state === "deleted")
    throw Error(
      "Restore this Code session and its workspace before sending a message.",
    );
}
