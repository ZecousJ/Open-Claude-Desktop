import { useSyncExternalStore } from "react";

/** Whether the Language dialog is open; the account menu opens it, its overlay draws it. */
let open = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function openLanguageDialog(value = true) {
  open = value;
  listeners.forEach((listener) => listener());
}

export function useLanguageDialog(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}
