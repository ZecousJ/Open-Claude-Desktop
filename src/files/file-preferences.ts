import { useMemo, useSyncExternalStore } from "react";

/** Current native Files settings. */
export interface FilePreferences {
  previewTabs: boolean;
  autoSave: boolean;
  tabIndents: boolean;
  wordWrap: boolean;
  indentGuides: boolean;
  showWhitespace: boolean;
  scrollPastEnd: boolean;
  tabSize: 2 | 4 | 8;
}
export const defaultFilePreferences: FilePreferences = {
  previewTabs: true,
  autoSave: true,
  tabIndents: true,
  wordWrap: true,
  indentGuides: true,
  showWhitespace: false,
  scrollPastEnd: false,
  tabSize: 4,
};
export function parseFilePreferences(
  raw: string | null | undefined,
): FilePreferences {
  let value: Partial<FilePreferences> = {};
  try {
    const parsed = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object") value = parsed;
  } catch {
    /* Defaults on a damaged old preference. */
  }
  const next = { ...defaultFilePreferences };
  for (const key of [
    "previewTabs",
    "autoSave",
    "tabIndents",
    "wordWrap",
    "indentGuides",
    "showWhitespace",
    "scrollPastEnd",
  ] as const)
    if (typeof value[key] === "boolean") next[key] = value[key]!;
  if (value.tabSize === 2 || value.tabSize === 4 || value.tabSize === 8)
    next.tabSize = value.tabSize;
  return next;
}
const changed = "claudex-file-preferences";
const memory = new Map<string, string>();
const keyFor = (account: string) =>
  `claudex.files.preferences.v1.${encodeURIComponent(account)}`;
function raw(account: string) {
  if (memory.has(account)) return memory.get(account)!;
  try {
    return window.localStorage.getItem(keyFor(account));
  } catch {
    return null;
  }
}
export function updateFilePreferences(
  account: string,
  patch: Partial<FilePreferences>,
) {
  const value = JSON.stringify(
    parseFilePreferences(
      JSON.stringify({ ...parseFilePreferences(raw(account)), ...patch }),
    ),
  );
  try {
    window.localStorage.setItem(keyFor(account), value);
    memory.delete(account);
  } catch {
    memory.set(account, value);
  }
  window.dispatchEvent(new window.Event(changed));
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key.startsWith("claudex.files.preferences.v1.")
    ) {
      memory.clear();
      listener();
    }
  };
  window.addEventListener(changed, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useFilePreferences(account: string) {
  const value = useSyncExternalStore(
    subscribe,
    () => raw(account),
    () => null,
  );
  const parsed = useMemo(() => parseFilePreferences(value), [value]);
  return [
    parsed,
    (patch: Partial<FilePreferences>) => updateFilePreferences(account, patch),
  ] as const;
}
