import { useSyncExternalStore } from "react";

/**
 * Whether the web bridge's event stream is up (`stream-connection` events;
 * the desktop's engine is local and never sends them). While it is down a
 * running reply cannot arrive: the turn says so and offers Check now, which
 * reads the whole state again over the service's HTTP calls.
 */
export interface StreamConnection {
  connected: boolean;
  /** When the stream last went down (kept after it comes back). */
  lostAt?: number;
}

let state: StreamConnection = { connected: true };
const listeners = new Set<() => void>();
let checker: (() => Promise<void>) | undefined;

export function setStreamConnected(connected: boolean, now = Date.now()) {
  if (state.connected === connected) return;
  state = connected ? { ...state, connected } : { connected, lostAt: now };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useStreamConnection() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** The window's resync (useDesktopEvents registers it). */
export function registerConnectionCheck(check?: () => Promise<void>) {
  checker = check;
}

/** Check now: reads the state again; resolves when it has been applied. */
export function checkConnectionNow() {
  return checker ? checker() : Promise.resolve();
}
