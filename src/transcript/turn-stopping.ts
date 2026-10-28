import { useSyncExternalStore } from "react";
import type { Conversation } from "../../shared/types";

/*
 * Turns the person asked to stop that have not ended yet. Between the Stop
 * press and the engine's turn/completed the Code status line reads "Stopping…".
 * A stop that fails takes the mark off again; the status line drops it once the
 * turn has ended.
 */
const stopping = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** Marks the conversation's running turn as stopping while `stop` runs. */
export function trackStopping<T>(
  conversation: Conversation | undefined,
  stop: Promise<T>,
): Promise<T> {
  const turn = [...(conversation?.turns ?? [])]
    .reverse()
    .find((value) => value.status === "inProgress");
  if (!turn) return stop;
  stopping.add(turn.id);
  changed();
  return stop.catch((error) => {
    clearStopping(turn.id);
    throw error;
  });
}

export function clearStopping(turnId: string) {
  if (stopping.delete(turnId)) changed();
}

export function useTurnStopping(turnId: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => stopping.has(turnId),
    () => false,
  );
}
