import { useSyncExternalStore } from "react";

/** The Rewind confirmation waiting to show (RewindDialog), one at a time. */
export interface RewindAsk {
  conversationId: string;
  turnId: string;
  text: string;
}

let current: RewindAsk | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function askRewind(ask: RewindAsk | null) {
  current = ask;
  emit();
}

export function useRewindAsk() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
