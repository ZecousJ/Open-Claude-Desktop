import { useEffect, useMemo, useRef } from "react";
import type { AppCommand } from "../../shared/types";
import { noSplitMenu, type SplitMenuState } from "../../shared/menu-state";
import { isMacPlatform } from "../host/keys";
import type { AppController } from "../app/AppContext";
import {
  closeFocused,
  dropSession,
  moveFocused,
  moveFocusToward,
  openDraft,
  stepFocusBy,
  swapWithPrimary,
} from "./split-actions";
import { closePaneAsking } from "./discard-draft";
import { focusPaneComposer } from "./split-dom";
import { splitKeyCommand } from "./split-keys";
import { splitMenuState, type Direction, type PaneRef } from "./split-layout";
import { splitState, useSplitState } from "./split-state";

const moveDirections: Partial<Record<AppCommand, Direction>> = {
  "split-move-left": "left",
  "split-move-right": "right",
  "split-move-up": "up",
  "split-move-down": "down",
  "split-focus-left": "left",
  "split-focus-right": "right",
  "split-focus-up": "up",
  "split-focus-down": "down",
};

export const isSplitCommand = (command: AppCommand) =>
  command.startsWith("split-");

/**
 * The window's side of View ▸ Split View (desktop, Code): what the menu may
 * do, the commands and their keys, and keeping the panes true to the window:
 * a pane whose session is gone closes, and a session the primary pane moves
 * to trades places with the pane that showed it.
 */
export function useSplitCommands(app: AppController, mainWindow: boolean) {
  const state = useSplitState();
  const desktop = app.host?.kind === "desktop";
  const enabled = mainWindow && desktop;
  const available = enabled && app.mode === "code" && app.page === "chat";
  const latest = useRef(app);
  latest.current = app;
  const availableNow = useRef(available);
  availableNow.current = available;
  const primary: PaneRef | null = app.activeId
    ? { kind: "session", id: app.activeId }
    : null;
  const menu: SplitMenuState = useMemo(
    () =>
      available
        ? splitMenuState(state.panes, state.focus, state.maxColumns, primary)
        : noSplitMenu,
    [available, state.panes, state.focus, state.maxColumns, app.activeId],
  );

  // A session that no longer exists leaves its pane.
  const conversations = app.snapshot.conversations;
  useEffect(() => {
    if (!enabled) return;
    const known = new Set(conversations.map((c) => c.id));
    for (const pane of [...state.panes, ...state.parked])
      if (pane.ref.kind === "session" && !known.has(pane.ref.id))
        dropSession(pane.ref.id);
  }, [enabled, conversations, state.panes, state.parked]);

  // The primary pane opens a session a pane shows: they trade places.
  const left = useRef(app.activeId);
  useEffect(() => {
    const was = left.current;
    left.current = app.activeId;
    if (!enabled || !app.activeId || was === app.activeId) return;
    swapWithPrimary(
      app.activeId,
      was && conversations.some((c) => c.id === was) ? was : undefined,
    );
  }, [enabled, app.activeId]);

  const platform = app.snapshot.platform;
  /** Runs a split command; false when it is not one. */
  const run = (command: AppCommand) => {
    if (!isSplitCommand(command)) return false;
    // Greyed in the menu, so a key that reaches here does nothing either.
    if (!availableNow.current) return true;
    const current = latest.current;
    const focusTo = (focus: number | null) => {
      if (focus !== null) focusPaneComposer(focus);
    };
    if (command === "split-new-right") focusTo(openDraft("right"));
    else if (command === "split-new-below") focusTo(openDraft("below"));
    else if (command === "split-focus-next") focusTo(stepFocusBy(1));
    else if (command === "split-focus-previous") focusTo(stepFocusBy(-1));
    else if (command === "split-close") {
      // A secondary pane with an unsent draft asks before it closes.
      const { panes, focus } = splitState();
      if (focus > 0) {
        void closePaneAsking(panes[focus - 1].key, current.accountId).then(
          (closed) => closed && focusPaneComposer(splitState().focus),
        );
        return true;
      }
      const closed = closeFocused();
      if (closed.promote) {
        const promoted = current.snapshot.conversations.find(
          (c) => c.id === closed.promote,
        );
        if (promoted) current.openConversation(promoted);
      } else if (closed.newSession) current.newChat("code");
      else focusPaneComposer(splitState().focus);
    } else {
      const direction = moveDirections[command];
      if (!direction) return true;
      if (command.startsWith("split-focus-"))
        focusTo(moveFocusToward(direction));
      else {
        const moved = moveFocused(direction, current.activeId);
        if (moved?.promoted) {
          const promoted = current.snapshot.conversations.find(
            (c) => c.id === moved.promoted,
          );
          if (promoted) current.openConversation(promoted);
        }
      }
    }
    return true;
  };
  const runRef = useRef(run);
  runRef.current = run;

  // The keys; the menu shows them without registering them, so they work
  // with the menu bar hidden too. Captured so a shortcut the window also
  // has (Ctrl+[ goes back on Windows) means the split view's while panes
  // are open.
  useEffect(() => {
    if (!enabled) return;
    const mac = isMacPlatform(platform);
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // Ctrl+[ is Escape to a shell: the terminal keeps its keys.
      if ((event.target as Element | null)?.closest?.(".xterm")) return;
      const command = splitKeyCommand(
        {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          altGraph: event.getModifierState?.("AltGraph"),
        },
        mac,
      );
      if (!command || !availableNow.current) return;
      // With nothing split only the keys that open a pane are the split
      // view's; the others stay with the window (and the system).
      if (
        !splitState().panes.length &&
        command !== "split-new-right" &&
        command !== "split-new-below"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat && command === "split-close") return;
      runRef.current(command);
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [enabled, platform]);

  return {
    menu,
    /** A pane beside the primary pane has the focus: the tool panels and the side chat are not its. */
    secondaryFocused: available && state.panes.length > 0 && state.focus > 0,
    run: (command: AppCommand) => runRef.current(command),
  };
}
