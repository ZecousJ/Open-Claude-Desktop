import { useEffect } from "react";
import {
  setShellCommandHandler,
  isPinChord,
  paneToClose,
  sendBrowserCommand,
  browserTabNumber,
} from "./shell-menu";
import {
  useJumpHints,
  rowForDigit,
  shownJumpHints,
  hideJumpHints,
  shownRowIds,
} from "../sidebar/jump-hints";
import { isMacPlatform } from "../host/keys";
import { api } from "../desktop-api";
import type { AppCommand, Conversation } from "../../shared/types";
import { requestFilesContentSearch } from "../files/files-search";
import { isSplitCommand } from "../split-view/useSplitCommands";
import {
  primaryOnlyNotice,
  sideChatPrimaryOnly,
} from "../split-view/split-notices";
import { toggleSideChat } from "../side-chat/side-chat-store";
import { sideChatAvailability } from "../side-chat/side-chat-model";
import { closeArtifact, openArtifact } from "./ArtifactHost";
import { toggleExpandPane } from "./pane-expand";
import {
  chatKeyOwner,
  focusForChatKeys,
  jumpTarget,
  listedIds,
  drawnIds,
  cycleTarget,
} from "./session-cycle";
import { openFromSidebar } from "./AppSidebar";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import type { ClosedSessions } from "./shell-menu";
import type { AppController } from "./AppContext";
import type { ActionDispatch } from "react";
import type { SplitMenuState, MenuState } from "../../shared/menu-state";

/** What useShellMenuActions needs from ShellMenuHost.tsx. */
export interface UseShellMenuActionsKit {
  app: AppController;
  closed: React.RefObject<ClosedSessions>;
  cycleRun: React.RefObject<{ mode: string; at: string | undefined } | null>;
  desktop: boolean;
  latest: React.RefObject<AppController>;
  listChanged: ActionDispatch<[]>;
  mainWindow: boolean;
  reopenable: (id: string) => boolean;
  reopening: React.RefObject<boolean>;
  splitRef: React.RefObject<{
    menu: SplitMenuState;
    secondaryFocused: boolean;
    run: (command: AppCommand) => boolean;
  }>;
  stateRef: React.RefObject<MenuState>;
}

export function useShellMenuActions(kit: UseShellMenuActionsKit) {
  const {
    app,
    closed,
    cycleRun,
    desktop,
    latest,
    listChanged,
    mainWindow,
    reopenable,
    reopening,
    splitRef,
    stateRef,
  } = kit;
  useEffect(() => {
    if (!mainWindow) return;
    return setShellCommandHandler((command) => run(command));
  }, [mainWindow]);

  // Holding ⌘ (Ctrl elsewhere) on the desktop, or Ctrl+Shift, numbers the
  // sidebar's rows; Ctrl+Shift+1…9 opens one (src/sidebar/jump-hints.ts).
  useJumpHints({
    enabled: mainWindow && !app.incognitoShown,
    desktop,
    mac: isMacPlatform(app.snapshot.platform),
    onJump: openRow,
  });

  // A run of Next / Previous lasts while its keys stay held: pressing or
  // letting go of Ctrl, ⌘ or Alt, or the window losing the focus, starts the
  // next press from the open row.
  useEffect(() => {
    if (!mainWindow) return;
    const modifier = (key: string) =>
      key === "Control" || key === "Meta" || key === "Alt";
    const down = (event: KeyboardEvent) => {
      if (modifier(event.key) && !event.repeat) cycleRun.current = null;
    };
    const up = (event: KeyboardEvent) => {
      if (
        modifier(event.key) ||
        (!event.ctrlKey && !event.metaKey && !event.altKey)
      )
        cycleRun.current = null;
    };
    const blur = () => (cycleRun.current = null);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [mainWindow]);

  // Ctrl+Alt+P (Cmd+Option+P on macOS) pins or unpins the open chat: the
  // original's "Pin / unpin chat" key works on the conversation on screen,
  // not only on a focused sidebar row (which handles the key first).
  useEffect(() => {
    if (!mainWindow) return;
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isPinChord(event)) return;
      const { active, page, incognitoShown } = latest.current;
      if (!active || page !== "chat" || incognitoShown || active.archived)
        return;
      event.preventDefault();
      // A held chord pins once.
      if (event.repeat) return;
      void api
        .reorderConversations({
          sourceId: active.id,
          section: active.pinned ? "recent" : "pinned",
          position: "before",
        })
        .then((conversations) =>
          latest.current.setSnapshot((current) =>
            current ? { ...current, conversations } : current,
          ),
        )
        .catch(latest.current.report);
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [mainWindow]);

  /** Runs one command; false when it is not one of the host's. */
  function run(command: AppCommand) {
    const app = latest.current;
    if (command === "area-chat" || command === "area-code") {
      app.newChat(command === "area-code" ? "code" : "chat");
      return true;
    }
    if (command === "close-context") {
      if (stateRef.current.closeTarget === "Pane") return run("close-pane");
      if (app.mode === "code" && splitRef.current.menu.split)
        return splitRef.current.run("split-close");
      app.newChat(app.mode);
      return true;
    }
    if (command === "find-in-files") {
      if (stateRef.current.findInFiles) {
        app.toolPanels.setPanel("files");
        app.setArtifact(undefined);
        requestFilesContentSearch(app.activeId!);
      }
      return true;
    }
    const panes = {
      "toggle-terminal": "terminal",
      "toggle-changes": "changes",
      "toggle-browser": "browser",
      "toggle-files": "files",
    } as const;
    if (isSplitCommand(command)) return splitRef.current.run(command);
    if (command === "toggle-background") {
      if (app.mode === "code" && app.activeId) {
        app.toolPanels.toggle("background");
        app.setArtifact(undefined);
      }
      return true;
    }
    if (command in panes) {
      // A pane beside the primary pane has the focus: say where they open.
      if (splitRef.current.secondaryFocused) {
        app.notify(primaryOnlyNotice);
        return true;
      }
      const panel = panes[command as keyof typeof panes];
      const enabled = stateRef.current.panes[panel]?.enabled ?? false;
      if (enabled) {
        app.toolPanels.toggle(panel);
        app.setArtifact(undefined);
      }
      return true;
    }
    if (command === "toggle-side-chat") {
      if (splitRef.current.secondaryFocused) app.notify(sideChatPrimaryOnly);
      else if (stateRef.current.sideChat.enabled && app.activeId)
        toggleSideChat(app.activeId);
      // The key works where the menu item is greyed: say why nothing opened.
      else {
        const { reason } = sideChatAvailability(
          app.page === "chat" ? app.active : undefined,
          app.active?.mode ?? app.mode,
        );
        if (reason) app.notify(reason);
      }
      return true;
    }
    if (command === "close-pane") {
      // The panels and the file viewer are the primary pane's.
      if (splitRef.current.secondaryFocused) return true;
      const target = paneToClose({
        artifact: Boolean(app.artifact),
        single: app.toolPanels.single,
        dock: app.toolPanels.dock,
      });
      if (target === "artifact") closeArtifact(app);
      else if (target) app.toolPanels.close(target);
      return true;
    }
    if (command === "toggle-expand-pane") {
      // The cards are the primary pane's.
      if (!splitRef.current.secondaryFocused) toggleExpandPane();
      return true;
    }
    if (command === "browser-select-element") {
      // ⇧⌘S: Select element in the open Browser (toggleSelectionMode);
      // elsewhere a Cowork task's Activity panel.
      if (splitRef.current.secondaryFocused) return true;
      if (app.toolPanels.isOpen("browser"))
        sendBrowserCommand("select-element");
      else if (app.active?.mode === "cowork" && app.page === "chat")
        app.toolPanels.toggle("progress");
      return true;
    }
    if (command === "browser-sketch") {
      // Sketch on the open Browser's page (toggleSketchMode).
      if (
        !splitRef.current.secondaryFocused &&
        app.toolPanels.isOpen("browser")
      )
        sendBrowserCommand("sketch");
      return true;
    }
    if (command === "open-file") {
      void openLocalFile();
      return true;
    }
    if (command === "reopen-closed-session") {
      // With the Browser open, the same keys bring back its closed tab.
      if (app.toolPanels.isOpen("browser") && sendBrowserCommand("reopen-tab"))
        return true;
      reopenClosedSession();
      return true;
    }
    if (command === "previous-session" || command === "next-session") {
      cycleSession(command === "next-session" ? 1 : -1);
      return true;
    }
    if (command === "new-browser-tab") {
      sendBrowserCommand("new-tab");
      return true;
    }
    if (command === "browser-focus-address") {
      sendBrowserCommand("focus-address");
      return true;
    }
    // Ctrl+Tab, Ctrl+Shift+Tab and ⌘1 to ⌘9 are Next chat, Previous chat and
    // Jump to chat; they switch the Browser's tabs instead while the focus is
    // in the Browser.
    if (command === "browser-next-tab" || command === "browser-previous-tab") {
      const owner = keyOwner();
      const next = command === "browser-next-tab";
      if (owner === "browser")
        sendBrowserCommand(next ? "next-tab" : "previous-tab");
      else if (owner === "chats") cycleSession(next ? 1 : -1);
      return true;
    }
    const tab = browserTabNumber(command);
    if (tab) {
      const owner = keyOwner();
      if (owner === "browser") sendBrowserCommand({ tab });
      else if (owner === "chats") jumpToChat(tab);
      return true;
    }
    return false;
  }

  /** Whether the chat keys switch chats or the Browser's tabs now. */
  function keyOwner() {
    return chatKeyOwner(
      focusForChatKeys(document, latest.current.toolPanels.isOpen("browser")),
    );
  }

  /**
   * ⌘1 to ⌘9: the row with that number while the sidebar numbers its rows,
   * else the n-th row the sidebar shows (the default order while no
   * sidebar is drawn).
   */
  function jumpToChat(number: number) {
    const app = latest.current;
    if (app.incognitoShown) return;
    const numbered = rowForDigit(shownJumpHints(), String(number));
    hideJumpHints();
    openRow(
      numbered ??
        jumpTarget(
          document.querySelector(".sidebar-scroll")
            ? shownRowIds(document)
            : listedIds(app.snapshot.conversations, app.mode),
          app.page === "chat" ? app.activeId : undefined,
          number,
        ),
    );
  }

  /** Opens a sidebar row by its conversation's id, unless it is on screen. */
  function openRow(id: string | undefined) {
    const app = latest.current;
    if (id === undefined || (app.page === "chat" && app.activeId === id))
      return;
    const conversation = app.snapshot.conversations.find((c) => c.id === id);
    if (conversation) void openFromSidebar(app, conversation).catch(app.report);
  }

  /**
   * Go ▸ Previous and Next: the neighbour of the open conversation in the
   * sidebar's rows as drawn, or in the default order while no sidebar is
   * there to read; the stop before the first row is a new conversation.
   */
  function cycleSession(direction: 1 | -1) {
    const app = latest.current;
    if (app.incognitoShown) return;
    const ids = document.querySelector(".sidebar-scroll")
      ? drawnIds(document)
      : listedIds(app.snapshot.conversations, app.mode);
    // While the keys stay held the steps go on from the last stop, not from the
    // conversation still opening.
    const run = cycleRun.current;
    const from =
      run && run.mode === app.mode
        ? run.at
        : app.page === "chat"
          ? app.activeId
          : undefined;
    const target = cycleTarget(ids, from, direction);
    if (!target) return;
    cycleRun.current = {
      mode: app.mode,
      at: target.kind === "new" ? undefined : target.id,
    };
    if (target.kind === "new") {
      app.newChat(app.mode);
      return;
    }
    const conversation = app.snapshot.conversations.find(
      (c) => c.id === target.id,
    );
    if (conversation) void openFromSidebar(app, conversation).catch(app.report);
  }

  /** File ▸ Open File…: the system picker, then the file viewer. */
  async function openLocalFile() {
    const app = latest.current;
    try {
      const file = await api.chooseLocalFile();
      if (!file) return;
      const artifact = generatedArtifact(file);
      if (!artifact) {
        app.report(new Error(file.error ?? "This file can't be previewed."));
        return;
      }
      openArtifact(app, { ...artifact, surface: "file" });
    } catch (error) {
      app.report(error);
    }
  }

  /** File ▸ Reopen Closed Session: the conversation left or closed last. */
  function reopenClosedSession() {
    const app = latest.current;
    const id = closed.current.take(reopenable);
    const conversation: Conversation | undefined =
      id === undefined
        ? undefined
        : app.snapshot.conversations.find((c) => c.id === id);
    if (!conversation) return;
    reopening.current = true;
    app.openConversation(conversation);
    listChanged();
  }
}
