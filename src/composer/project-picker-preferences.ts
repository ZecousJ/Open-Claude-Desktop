import { useSyncExternalStore } from "react";

export type ProjectPickerSort = "recent" | "created" | "name";
const changed = "claudex-project-picker-preferences";
const memory = new Map<string, string | null>();
const keyFor = (accountId: string, field: string) =>
  `claudex.project-picker.${encodeURIComponent(accountId)}.${field}`;

function read(key: string) {
  if (memory.has(key)) return memory.get(key) ?? undefined;
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function write(key: string, value: string | undefined) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    // Keep this page's choice when storage is unavailable.
    memory.set(key, value ?? null);
  }
  if (typeof dispatchEvent === "function") dispatchEvent(new Event(changed));
}

/** The root applies this only to an ordinary new draft and a live project. */
export const defaultProjectId = (accountId: string) =>
  read(keyFor(accountId, "default"));
export const setDefaultProjectId = (accountId: string, id?: string) => {
  if (id) write(keyFor(accountId, "folder"), undefined);
  write(keyFor(accountId, "default"), id);
};
export function projectPickerSort(accountId: string): ProjectPickerSort {
  const value = read(keyFor(accountId, "sort"));
  return value === "created" || value === "name" ? value : "recent";
}
export const setProjectPickerSort = (
  accountId: string,
  value: ProjectPickerSort,
) => write(keyFor(accountId, "sort"), value);

export function subscribeProjectPickerPreferences(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key) memory.delete(event.key);
    else memory.clear();
    listener();
  };
  addEventListener(changed, listener);
  addEventListener("storage", storage);
  return () => {
    removeEventListener(changed, listener);
    removeEventListener("storage", storage);
  };
}
/** Extra native picker fields share the same account isolation and event. */
export const readProjectPickerPreference = (accountId: string, field: string) =>
  read(keyFor(accountId, field));
export const writeProjectPickerPreference = (
  accountId: string,
  field: string,
  value?: string,
) => write(keyFor(accountId, field), value);
export function useProjectPickerPreferences(accountId: string) {
  const defaultId = useSyncExternalStore(
    subscribeProjectPickerPreferences,
    () => defaultProjectId(accountId),
    () => undefined,
  );
  const sort = useSyncExternalStore(
    subscribeProjectPickerPreferences,
    () => projectPickerSort(accountId),
    () => "recent" as const,
  );
  return { defaultId, sort };
}
