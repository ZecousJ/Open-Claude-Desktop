import type { Store } from "../store/store";
import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
const accounts = new WeakMap<
  Store,
  Map<string, { window: BrowserWindow; cwd: string }>
>();
export function createDraftBrowser(
  store: Store,
  window: BrowserWindow,
  cwd: string,
) {
  let drafts = accounts.get(store);
  if (!drafts) {
    drafts = new Map();
    accounts.set(store, drafts);
  }
  const id = "browser-draft-" + randomUUID();
  drafts.set(id, { window, cwd });
  return id;
}
export function ownsDraftBrowser(
  store: Store,
  id: string,
  window: BrowserWindow | undefined,
) {
  return !!window && accounts.get(store)?.get(id)?.window === window;
}
export function draftBrowserIds(store: Store) {
  return [...(accounts.get(store)?.keys() ?? [])];
}
export function forgetDraftBrowser(store: Store, id: string) {
  accounts.get(store)?.delete(id);
}
export function resetDraftBrowsers(store: Store) {
  accounts.delete(store);
}
