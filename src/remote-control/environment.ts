import { useSyncExternalStore } from "react";

let current: { id: string; name: string; folder?: string } | undefined;
const listeners = new Set<() => void>();
export const remoteEnvironment = () => current;
export function setRemoteEnvironment(next: typeof current) {
  current = next;
  listeners.forEach((listener) => listener());
}
export function useRemoteEnvironment() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    remoteEnvironment,
    remoteEnvironment,
  );
}
