import { useSyncExternalStore } from "react";
export type VoiceInputAction = "dictation" | "voice";
export interface VoiceInputChoice {
  value: VoiceInputAction;
  choose(value: VoiceInputAction): void;
}
const memory = new Map<string, VoiceInputAction>();
const listeners = new Set<() => void>();
const key = (account: string) =>
  `claudex.voice.pinned-input-action.${encodeURIComponent(account)}`;
function read(account: string): VoiceInputAction {
  try {
    const stored = window.localStorage.getItem(key(account));
    if (stored === "voice" || stored === "dictation") return stored;
  } catch {
    /* Blocked storage retains this page's preference. */
  }
  return memory.get(account) ?? "dictation";
}
export function useVoiceInputPreference(account: string): VoiceInputChoice {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      window.addEventListener("storage", listener);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", listener);
      };
    },
    () => read(account),
    () => "dictation" as const,
  );
  return {
    value,
    choose(next) {
      memory.set(account, next);
      try {
        window.localStorage.setItem(key(account), next);
      } catch {
        /* Page memory above. */
      }
      listeners.forEach((listener) => listener());
    },
  };
}
