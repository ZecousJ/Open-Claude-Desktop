/**
 * The main window's report for the application menu (shared/menu-state.ts):
 * the IPC handler stores it here and the menu (app-menu.ts) rebuilds from
 * it. No Electron imports, so the handler runs under the unit tests.
 */
import { z } from "zod";
import {
  initialMenuState,
  sameMenuState,
  type MenuState,
} from "../../shared/menu-state";

const pane = z.object({ enabled: z.boolean(), open: z.boolean() }).strict();
const splitView = z
  .object({
    newRight: z.boolean(),
    newBelow: z.boolean(),
    split: z.boolean(),
    moveLeft: z.boolean(),
    moveRight: z.boolean(),
    moveUp: z.boolean(),
    moveDown: z.boolean(),
  })
  .strict();
export const menuStateSchema = z
  .object({
    closeTarget: z.enum(["Chat", "Task", "Page", "Session", "Pane"]).optional(),
    findInFiles: z.boolean().optional(),
    mode: z.enum(["chat", "cowork", "code"]),
    sidebarOpen: z.boolean(),
    sidebarEnabled: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    canCycleSession: z.boolean(),
    panes: z
      .object({
        terminal: pane,
        changes: pane,
        browser: pane,
        files: pane.optional(),
      })
      .strict(),
    sideChat: pane,
    canClosePane: z.boolean(),
    splitView,
    canReopenClosed: z.boolean(),
    areas: z
      .array(
        z
          .object({
            id: z.enum(["chat", "code"]),
            label: z.string().min(1).max(80),
            selected: z.boolean(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    viewing: z.array(z.string().max(200)).max(32).optional(),
  })
  .strict();

let current: MenuState = initialMenuState;
const listeners = new Set<() => void>();

export const menuState = () => current;

let viewing: readonly string[] = [];
const viewingListeners = new Set<() => void>();

/** The conversations the main window shows now (see `MenuState.viewing`). */
export const viewedConversations = () => viewing;

/** Calls back when the main window shows other conversations. */
export function onViewedConversations(listener: () => void) {
  viewingListeners.add(listener);
  return () => void viewingListeners.delete(listener);
}

function setViewing(next: readonly string[]) {
  if (next.join("\n") === viewing.join("\n")) return;
  viewing = next;
  for (const listener of viewingListeners) listener();
}

/** Stores a report; true when it changed what the menu shows. */
export function reportMenuState(raw: unknown) {
  const next = menuStateSchema.parse(raw);
  setViewing(next.viewing ?? []);
  if (sameMenuState(current, next)) return false;
  current = next;
  for (const listener of listeners) listener();
  return true;
}

/** Calls back when a report changes the menu. */
export function onMenuState(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Forgets the report (the window is gone or the account signed out). */
export function resetMenuState() {
  current = initialMenuState;
  setViewing([]);
  for (const listener of listeners) listener();
}
