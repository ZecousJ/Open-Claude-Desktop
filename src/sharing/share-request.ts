/**
 * Share from a sidebar row: the row opens the session, and its title bar, which
 * owns the share dialog, takes the request once it is on screen.
 */
let pending: string | null = null;
const listeners = new Set<() => void>();

export function requestShare(conversationId: string) {
  pending = conversationId;
  listeners.forEach((listener) => listener());
}

/** The request for this conversation, once; null when there is none. */
export function takeShareRequest(conversationId: string) {
  if (pending !== conversationId) return false;
  pending = null;
  return true;
}

export function onShareRequest(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
