import { useSyncExternalStore } from "react";

const sessions = new Set<object>();
const listeners = new Set<() => void>();

export function setVoiceSurface(session: object, active: boolean) {
  const previous = sessions.size > 0;
  if (active) sessions.add(session);
  else sessions.delete(session);
  if (previous !== sessions.size > 0)
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useVoiceSurface() {
  return useSyncExternalStore(
    subscribe,
    () => sessions.size > 0,
    () => false,
  );
}
