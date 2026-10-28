import { useEffect, useLayoutEffect, type RefObject } from "react";
import { useApp } from "../app/AppContext";
import { maxColumnsFor } from "./split-layout";
import { setFocus, setMaxColumns } from "./split-actions";
import { loadSplitFor, setSplitState, useSplitState } from "./split-state";

/** How long the window's size must hold still before the columns that fit are counted again. */
const settleMs = 120;

/**
 * The width the panes share: the window less the sidebar's column, read from
 * the grid the way the browser lays it out (the sidebar column is the first
 * track and is 0 while the sidebar is hidden).
 */
export function hostWidth(app: HTMLElement) {
  const style = getComputedStyle(app);
  const tracks = style.gridTemplateColumns.split(" ");
  return (
    app.clientWidth -
    (parseFloat(tracks[0]) || 0) -
    (parseFloat(style.paddingInlineStart) || 0) -
    (parseFloat(style.paddingInlineEnd) || 0) -
    (parseFloat(style.columnGap) || 0) * (tracks.length - 1)
  );
}

/**
 * What the window's page needs of the split view: the panes are on screen
 * (the desktop's main window, a Code page, panes to show), which one has the
 * focus, and the count of columns the window has room for, kept up to date
 * as the window and the sidebar change size. The saved panes are read here,
 * the first time the account is known.
 */
export function useSplitPanes(workspace: RefObject<HTMLElement | null>) {
  const app = useApp();
  const desktopMain =
    app.host?.kind === "desktop" && app.windowRole.kind === "main";
  if (desktopMain) loadSplitFor(app.accountId);
  const state = useSplitState();
  const eligible = desktopMain && app.page === "chat" && app.mode === "code";
  const shown = eligible && state.panes.length > 0;
  useEffect(() => {
    setSplitState({ shown });
    return () => setSplitState({ shown: false });
  }, [shown]);
  useLayoutEffect(() => {
    const host = workspace.current?.closest<HTMLElement>(".app");
    if (!desktopMain || !host) return;
    const measure = () => setMaxColumns(maxColumnsFor(hostWidth(host)));
    measure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(measure, settleMs);
    };
    const observer = new ResizeObserver(settle);
    observer.observe(host);
    // The sidebar slides and is dragged without the window changing size.
    if (workspace.current) observer.observe(workspace.current);
    host.addEventListener("transitionend", settle);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      host.removeEventListener("transitionend", settle);
    };
  }, [desktopMain, workspace]);
  // The primary pane's part of the grid: it names itself, dims when another
  // pane has the focus and takes the focus back when it is used.
  const primary = shown
    ? ({
        "aria-label": "Primary pane",
        "data-pane-index": 0,
        "data-focused": state.focus === 0 ? "" : undefined,
        onPointerDownCapture: () => setFocus(0),
        onFocusCapture: () => setFocus(0),
      } as const)
    : undefined;
  return { shown, primary };
}
