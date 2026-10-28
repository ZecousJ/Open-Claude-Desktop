/**
 * The microphone menu's two choices: which input device dictation records from
 * and "Hold to record". Device ids only mean something on this computer and
 * profile, so both are kept in the page's own storage rather than in the
 * account's settings; the page works without it.
 */
import { useSyncExternalStore } from "react";

const deviceKey = "claudex.microphone.device";
const holdKey = "claudex.microphone.hold";
const changed = "claudex-microphone-preferences";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage keep the choice for this page only.
    memory.set(key, value);
  }
  dispatchEvent(new Event(changed));
}
const memory = new Map<string, string>();
const get = (key: string) => read(key) ?? memory.get(key) ?? null;

/** The chosen input device, or undefined for the system default. */
export const microphoneDeviceId = () => {
  const id = get(deviceKey);
  return id && id !== "default" ? id : undefined;
};
/** "Hold to record" is on unless it was turned off. */
export const holdToRecord = () => get(holdKey) !== "off";

export const setMicrophoneDevice = (id: string) => write(deviceKey, id);
export const setHoldToRecord = (on: boolean) =>
  write(holdKey, on ? "on" : "off");

function subscribe(listener: () => void) {
  addEventListener(changed, listener);
  addEventListener("storage", listener);
  return () => {
    removeEventListener(changed, listener);
    removeEventListener("storage", listener);
  };
}

export function useMicrophonePreferences() {
  const device = useSyncExternalStore(
    subscribe,
    () => get(deviceKey) ?? "default",
  );
  const hold = useSyncExternalStore(subscribe, holdToRecord);
  return { device, hold };
}
