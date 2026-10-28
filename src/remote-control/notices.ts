import { useSyncExternalStore } from "react";
import type { RemoteControlNotice } from "./model";

const notices = new Map<string, RemoteControlNotice>();
const listeners = new Set<() => void>();
const dismissed = new Map<string, string>();
/** Shows a notice, or removes it when none is given; a notice the person dismissed stays away. */
export function setRemoteNotice(id: string, notice?: RemoteControlNotice) {
  if (notice && dismissed.get(id) === JSON.stringify(notice)) return;
  if (notice) notices.set(id, notice);
  else notices.delete(id);
  listeners.forEach((listener) => listener());
}
/** The banner's ×: the notice goes and the same one stays away. */
export function dismissRemoteNotice(id: string) {
  const notice = notices.get(id);
  if (notice) dismissed.set(id, JSON.stringify(notice));
  setRemoteNotice(id);
}
/** Turning Remote Control on or off forgets what was dismissed, so its result shows. */
export function forgetRemoteDismissal(id: string) {
  dismissed.delete(id);
}
export function useRemoteNotice(id: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices.get(id),
    () => notices.get(id),
  );
}
export const remoteNotice = (id: string) => notices.get(id);
