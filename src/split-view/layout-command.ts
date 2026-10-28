import type {
  LayoutCommand,
  LayoutCommandResult,
} from "../../shared/window-layout";
import type { AppController } from "../app/AppContext";
import { api } from "../desktop-api";
import { splitState, setSplitState } from "./split-state";
import { closePane, openInSplit } from "./split-actions";

const openedBy = new Map<string, string>();

// .
export async function runLayoutCommand(
  command: LayoutCommand,
  app: AppController,
): Promise<LayoutCommandResult> {
  const windowState = await api.windowLayoutState();
  const popouts = windowState.popoutSessionIds;
  const state = splitState();
  const callerIndex = state.panes.findIndex(
    (pane) =>
      pane.ref.kind === "session" && pane.ref.id === command.callerSessionId,
  );
  const primary =
    app.mode === "code" && app.activeId === command.callerSessionId;
  const inMain =
    app.mode === "code" &&
    app.page === "chat" &&
    (primary || callerIndex !== -1);
  const popout = popouts.includes(command.callerSessionId);
  let primaryId = app.activeId;
  let sidebarCollapsed = !app.sidebarView.open;
  const finish = (
    outcome: LayoutCommandResult["outcome"],
    reason?: string,
    paneIndex?: number,
  ): LayoutCommandResult => {
    const current = splitState();
    return {
      requestId: command.requestId,
      outcome,
      reason,
      paneIndex,
      layout: {
        mode: app.mode,
        sidebarCollapsed,
        primarySessionId: app.mode === "code" ? primaryId : undefined,
        primaryFocused: current.focus === 0,
        panes:
          app.mode !== "code"
            ? []
            : current.panes.map((pane, index) => ({
                index: index + 1,
                ...pane.pos,
                kind: pane.ref.kind,
                sessionId:
                  pane.ref.kind === "session" ? pane.ref.id : undefined,
                focused: current.focus === index + 1,
              })),
        popoutSessionIds: popouts,
        otherPopoutCount: windowState.otherPopoutCount,
        caller: {
          primary: app.mode === "code" && primaryId === command.callerSessionId,
          paneIndex: callerIndex === -1 ? undefined : callerIndex + 1,
          popout,
        },
      },
    };
  };
  if (command.kind !== "get_layout" && Date.now() > command.deadline)
    return finish("failed", "expired");
  if (command.kind === "get_layout") return finish("done");
  const mainVisible =
    inMain &&
    !command.mainWindowHidden &&
    document.visibilityState !== "hidden";
  const popoutVisible = windowState.visibleSessionIds.includes(
    command.callerSessionId,
  );
  if (!mainVisible && !popoutVisible)
    return finish(
      "refused",
      inMain || popout ? "window_hidden" : "caller_not_visible",
    );
  if (document.querySelector('[role="dialog"], [aria-modal="true"]'))
    return finish("refused", "dialog_open");
  if (
    ["open_in_split", "close_split", "set_sidebar_collapsed"].includes(
      command.kind,
    ) &&
    !inMain
  )
    return finish(
      "refused",
      command.kind === "set_sidebar_collapsed"
        ? "popout_has_no_sidebar"
        : "popout_has_no_panes",
    );
  const targetId = command.targetSessionId;
  const target = app.snapshot.conversations.find(
    (entry) => entry.id === targetId && !entry.incognito,
  );
  const targetIndex = state.panes.findIndex(
    (pane) => pane.ref.kind === "session" && pane.ref.id === targetId,
  );
  switch (command.kind) {
    case "open_in_split": {
      if (!targetId) return finish("failed", "missing_target");
      if (!target || target.mode !== "code")
        return finish("failed", "split_unavailable");
      if (targetId === app.activeId)
        return finish("noop", "already_in_primary");
      if (targetIndex !== -1) return finish("noop", "already_in_pane");
      const focus = state.focus;
      const paneIndex = openInSplit(targetId, app.activeId);
      if (paneIndex === null) return finish("refused", "no_room");
      const pane = splitState().panes[paneIndex - 1];
      if (pane) openedBy.set(pane.key, command.callerSessionId);
      setSplitState({ focus });
      return finish("done", undefined, paneIndex);
    }
    case "open_in_window":
      if (!targetId) return finish("failed", "missing_target");
      if (popouts.includes(targetId))
        return finish("noop", "already_in_window");
      if (!target) return finish("failed", "popout_unavailable");
      await api.openConversationWindow(targetId, undefined, {
        showInactive: true,
      });
      popouts.push(targetId);
      return finish("done");
    case "focus": {
      if (!targetId) return finish("failed", "missing_target");
      if (
        popouts.includes(targetId) &&
        targetIndex === -1 &&
        app.activeId !== targetId
      )
        return finish("noop", "already_in_window");
      if (!inMain) return finish("refused", "popout_has_no_panes");
      const element = document.activeElement;
      if (
        element instanceof HTMLElement &&
        (element.isContentEditable ||
          element.matches(
            "textarea, iframe, input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=range])",
          ))
      )
        return finish("refused", "user_typing");
      if (app.activeId === targetId && state.focus === 0)
        return finish("noop", "already_in_primary");
      if (targetIndex !== -1 && state.focus === targetIndex + 1)
        return finish("noop", "already_in_pane");
      if (targetIndex !== -1 || app.activeId === targetId) {
        setSplitState({ focus: targetIndex + 1 });
        return finish(
          "done",
          "focused_pane",
          targetIndex === -1 ? undefined : targetIndex + 1,
        );
      }
      if (!target) return finish("failed", "missing_target");
      app.openConversation(target);
      primaryId = targetId;
      return finish("done", primary ? "replaced_caller" : undefined);
    }
    case "close_split": {
      const last = [...state.panes]
        .reverse()
        .find((pane) => openedBy.get(pane.key) === command.callerSessionId);
      const index = targetId
        ? targetIndex
        : last
          ? state.panes.indexOf(last)
          : -1;
      if (index === -1) return finish("noop", "no_split_to_close");
      const pane = state.panes[index];
      if (openedBy.get(pane.key) !== command.callerSessionId)
        return finish("refused", "not_opened_by_you");
      if (state.focus === index + 1 && document.activeElement !== document.body)
        return finish("refused", "pane_in_use");
      closePane(pane.key);
      openedBy.delete(pane.key);
      return finish("done", undefined, index + 1);
    }
    case "set_sidebar_collapsed": {
      const collapsed = command.collapsed === true;
      if (collapsed === !app.sidebarView.open)
        return finish(
          "noop",
          collapsed ? "already_collapsed" : "already_expanded",
        );
      if (!collapsed && app.sidebarView.narrow)
        return finish("refused", "sidebar_constrained");
      if (
        collapsed &&
        document.activeElement instanceof Element &&
        document.activeElement.closest(".sidebar, [data-compact-mode-switcher]")
      )
        return finish("refused", "sidebar_in_use");
      app.sidebarView.toggle();
      sidebarCollapsed = collapsed;
      return finish("done");
    }
  }
}
