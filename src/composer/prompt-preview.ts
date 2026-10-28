import { useSyncExternalStore } from "react";

/*
 * The prompt a home suggestion would write, while the pointer or the
 * keyboard is on it: the home composer shows it in place of its own text
 * (the original's suggestion preview). One window has one home, so one value
 * is enough.
 */
let preview: string | null = null;
const listeners = new Set<() => void>();

/** Shows `text` in the home composer, or puts its own text back with null. */
export function setPromptPreview(text: string | null) {
  if (text === preview) return;
  preview = text;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePromptPreview(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => preview,
    () => null,
  );
}
