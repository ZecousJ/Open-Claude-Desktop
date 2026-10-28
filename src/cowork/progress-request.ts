/**
 * "Updated tasks ›" in a Cowork transcript (plan/ChatPlanRow.tsx) opens the
 * Progress panel with its task list unfolded; opened any other way the
 * section starts folded, as captured (cowork/ProgressPanel.tsx). The panel
 * is lazily loaded, so the request waits here for it, and an open panel
 * hears it as an event.
 */
const event = "claudex:progress-steps";
let pending: string | undefined;

export function requestProgressSteps(conversationId: string) {
  pending = conversationId;
  window.dispatchEvent(new CustomEvent(event, { detail: conversationId }));
}

/** Whether a request for this conversation is waiting (and takes it). */
export function takeProgressSteps(conversationId: string) {
  if (pending !== conversationId) return false;
  pending = undefined;
  return true;
}

export function onProgressSteps(conversationId: string, listener: () => void) {
  const handle = (e: Event) => {
    if ((e as CustomEvent<string>).detail !== conversationId) return;
    pending = undefined;
    listener();
  };
  window.addEventListener(event, handle);
  return () => window.removeEventListener(event, handle);
}
