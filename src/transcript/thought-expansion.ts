import { useSyncExternalStore } from "react";

/** Expansion keys. */
const expanded = new Map<string, boolean>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function thoughtExpanded(key: string) {
  return expanded.get(key) ?? true;
}

export function setThoughtExpanded(key: string, open: boolean) {
  expanded.set(key, open);
  for (const listener of listeners) listener();
}

export function useThoughtExpansion(key: string) {
  const open = useSyncExternalStore(
    subscribe,
    () => thoughtExpanded(key),
    () => thoughtExpanded(key),
  );
  return [open, (value: boolean) => setThoughtExpanded(key, value)] as const;
}
