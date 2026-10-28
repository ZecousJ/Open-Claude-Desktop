/**
 * "Updated tasks ›" in a Code transcript (PlanRow.tsx) opens the Plan panel
 * and points at the step being worked on: it scrolls into view and its row
 * lights up briefly (PlanPanel.tsx). The panel may mount only after the
 * request, so it waits here; an open panel hears it as an event.
 */
const event = "claudex:plan-reveal";
let pending: string | undefined;

export function requestPlanReveal(conversationId: string) {
  pending = conversationId;
  window.dispatchEvent(new CustomEvent(event, { detail: conversationId }));
}

/** Whether a request for this conversation is waiting (and takes it). */
export function takePlanReveal(conversationId: string) {
  if (pending !== conversationId) return false;
  pending = undefined;
  return true;
}

export function onPlanReveal(conversationId: string, listener: () => void) {
  const handle = (e: Event) => {
    if ((e as CustomEvent<string>).detail !== conversationId) return;
    pending = undefined;
    listener();
  };
  window.addEventListener(event, handle);
  return () => window.removeEventListener(event, handle);
}
