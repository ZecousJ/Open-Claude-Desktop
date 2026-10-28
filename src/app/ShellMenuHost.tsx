import { useAppDraft } from "../composer/draft-text";
import { retireBlankArtifactCreates } from "../artifacts/blank-artifact-request";
import { filesPaneAvailable } from "../files/files-model";
import { surface } from "../../shared/host";
import {
  cancelComposerSubmitFor,
  cancelStaleComposerSubmit,
} from "../composer/submit-request";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { api } from "../desktop-api";
import { browserPolicyOf } from "../../shared/client-policy";
import { browserToggleShown } from "../browser/browser-model";
import { useApp } from "./AppContext";
import { listedIds } from "./session-cycle";
import { sideChatAvailability } from "../side-chat/side-chat-model";
import { useSplitCommands } from "../split-view/useSplitCommands";
import { useSideChat } from "../side-chat/side-chat-store";
import { splitSessionIds, useSplitState } from "../split-view/split-state";
import { ClosedSessions, closeMenuTarget, menuStateFor } from "./shell-menu";
import { useShellMenuActions } from "./useShellMenuActions";

/**
 * The window's side of the application menu and the Code pane shortcuts
 * (src/host/keys.ts, electron/app-menu-template.ts). It tells the main
 * process what the menu should show (the mode, the sidebar and panes, what
 * Back, Forward, Close Pane and Reopen Closed Session can do), and runs the
 * commands that need the window's state: Terminal, Changes, Browser, Close
 * Pane, the Browser's own keys, Open File…, Reopen Closed Session and
 * Previous and Next. It
 * renders nothing, and does nothing in a separate conversation window,
 * whose commands the main window runs.
 */
export function ShellMenuHost() {
  const app = useApp();
  const mainWindow = app.windowRole.kind === "main";
  const draftText = useAppDraft(app).text;
  const latest = useRef(app);
  latest.current = app;
  useLayoutEffect(
    () => retireBlankArtifactCreates(),
    [
      app.accountId,
      app.controllerScope,
      app.page,
      app.mode,
      app.activeId,
      app.draftSession,
      app.artifactRouteId,
      draftText,
    ],
  );
  useLayoutEffect(() => {
    const owner = app.controllerScope ?? app;
    return () => retireBlankArtifactCreates(owner);
  }, [app.controllerScope]);
  useEffect(
    () => cancelStaleComposerSubmit(),
    [
      app.accountId,
      app.controllerScope,
      app.page,
      app.mode,
      app.activeId,
      app.draftSession,
      draftText,
      app.attachments,
    ],
  );
  useEffect(() => {
    const owner = app.controllerScope ?? app;
    return () => cancelComposerSubmitFor(owner);
  }, [app.controllerScope]);
  useEffect(() => {
    if (!mainWindow || surface === "web") return;
    let disposed = false;
    const off = api.onEvent((event) => {
      if (event.type !== "layout-command") return;
      void import("../split-view/layout-command")
        .then(async ({ runLayoutCommand }) => {
          if (disposed) return;
          try {
            await api.reportLayoutCommandResult(
              await runLayoutCommand(event.command, latest.current),
            );
          } catch {
            await api.reportLayoutCommandResult({
              requestId: event.command.requestId,
              outcome: "failed",
              reason: "page_error",
            });
          }
        })
        .catch(() => {
          if (!disposed)
            void api
              .reportLayoutCommandResult({
                requestId: event.command.requestId,
                outcome: "failed",
                reason: "load_failed",
              })
              .catch(() => {});
        });
    });
    void api.setLayoutCommandListening(true).catch(() => {});
    return () => {
      disposed = true;
      off();
      void api.setLayoutCommandListening(false).catch(() => {});
    };
  }, [mainWindow]);
  const closed = useRef(new ClosedSessions());
  // A run of Next / Previous while its keys stay held: the stop it is at
  // (undefined: the new conversation).
  const cycleRun = useRef<{ mode: string; at: string | undefined } | null>(
    null,
  );
  const reopening = useRef(false);
  // The reopen list lives in a ref; changing it asks for another report.
  const [, listChanged] = useReducer((count: number) => count + 1, 0);

  // A conversation the person leaves goes on the reopen list; so does one
  // whose separate window closes.
  const previous = useRef(app.activeId);
  useEffect(() => {
    const was = previous.current;
    previous.current = app.activeId;
    if (!mainWindow || !was || was === app.activeId) return;
    // Reopening a conversation leaves the one on screen without closing it.
    if (reopening.current) reopening.current = false;
    else {
      closed.current.push(was);
      listChanged();
    }
  }, [app.activeId, mainWindow]);
  useEffect(() => {
    if (!mainWindow) return;
    return api.onEvent((event) => {
      if (event.type === "conversation-window-closed") {
        closed.current.push(event.conversationId);
        listChanged();
      }
    });
  }, [mainWindow]);

  /** A conversation that still exists, is not private and is not on screen. */
  const reopenable = (id: string) =>
    id !== latest.current.activeId &&
    latest.current.snapshot.conversations.some(
      (c) => c.id === id && !c.incognito,
    );
  const canReopenClosed =
    mainWindow && closed.current.reopenable(reopenable).length > 0;

  const code = app.active?.mode === "code" && app.page === "chat";
  const terminalAvailable = app.host?.capabilities.localTerminal ?? false;
  // The Browser's button is shown by the host, the policy and Settings alike.
  const browserAvailable = browserToggleShown({
    mode: "code",
    capability: app.host?.capabilities.browserPanel ?? false,
    policyEnabled: browserPolicyOf(app.policy).enabled,
    settings: app.snapshot.settings as unknown as Record<string, unknown>,
  });
  const { toolPanels } = app;
  // The Files pane reads a local Code session's folder on this computer.
  const filesAvailable = filesPaneAvailable(app.active);
  // View ▸ Side Chat: Chat and Code, once the open conversation has a reply.
  const sideChat = useSideChat(app.activeId);
  // Split view (desktop Code): the Split View menu and its keys. A pane
  // beside the primary pane has the focus: the tool panels and the side
  // chat are the primary pane's, so those items wait.
  const split = useSplitCommands(app, mainWindow);
  const splitRef = useRef(split);
  splitRef.current = split;
  const sideChatAvailable =
    app.page === "chat" &&
    !split.secondaryFocused &&
    sideChatAvailability(app.active, app.active?.mode ?? app.mode).available;
  // Go ▸ Previous and Next wait until the sidebar lists a conversation.
  const anyListed = useMemo(
    () => listedIds(app.snapshot.conversations, app.mode).length > 0,
    [app.snapshot.conversations, app.mode],
  );
  const canCycleSession = mainWindow && !app.incognitoShown && anyListed;
  // The sessions on screen: the main process shows no banner for them and
  // withdraws theirs (the original checks the session the window shows).
  const splitShown = useSplitState();
  const viewing = useMemo(() => {
    if (app.page !== "chat") return [];
    const ids = new Set(splitShown.shown ? splitSessionIds() : []);
    if (app.activeId) ids.add(app.activeId);
    return [...ids];
  }, [app.page, app.activeId, splitShown]);
  const state = useMemo(
    () =>
      menuStateFor({
        mode: app.mode,
        closeTarget: closeMenuTarget(
          app.mode,
          app.page === "chat",
          Boolean(app.activeId) || split.secondaryFocused,
          Boolean(app.artifact || toolPanels.single || toolPanels.dock.length),
        ),
        sidebarOpen: app.sidebarView.open && !app.incognitoShown,
        sidebarEnabled: !app.incognitoShown,
        canGoBack: Boolean(app.navigation.back),
        canGoForward: Boolean(app.navigation.forward),
        canCycleSession,
        inCodeConversation: code && !split.secondaryFocused,
        splitView: split.menu,
        isOpen: toolPanels.isOpen,
        terminalAvailable,
        browserAvailable,
        filesAvailable,
        artifactOpen: Boolean(app.artifact) && !split.secondaryFocused,
        anyPanelOpen:
          Boolean(toolPanels.single || toolPanels.dock.length) &&
          !split.secondaryFocused,
        canReopenClosed,
        sideChatAvailable,
        sideChatOpen: Boolean(sideChat?.open),
        viewing,
        // The sidebar's Chat | Code switch (src/sidebar/SurfaceSwitch.tsx).
        areas: app.incognitoShown
          ? undefined
          : [
              { id: "chat", label: "Chat", selected: app.mode !== "code" },
              { id: "code", label: "Code", selected: app.mode === "code" },
            ],
      }),
    [
      viewing,
      sideChatAvailable,
      sideChat?.open,
      app.mode,
      app.page,
      app.activeId,
      app.sidebarView.open,
      app.incognitoShown,
      app.navigation.back,
      app.navigation.forward,
      canCycleSession,
      code,
      split.menu,
      split.secondaryFocused,
      toolPanels.single,
      toolPanels.dock,
      terminalAvailable,
      browserAvailable,
      filesAvailable,
      app.artifact,
      canReopenClosed,
    ],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const reported = useRef("");
  // Only the desktop has an application menu to tell.
  const desktop = app.host?.kind === "desktop";
  useEffect(() => {
    if (!mainWindow || !desktop) return;
    const key = JSON.stringify(state);
    if (key === reported.current) return;
    reported.current = key;
    void Promise.resolve()
      .then(() => api.reportMenuState(state))
      .catch(() => {});
  }, [state, mainWindow, desktop]);
  useShellMenuActions({
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
  });
  return null;
}
