import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { useTerminalPanelActions } from "./useTerminalPanelActions";
// After xterm's sheet: its rules meet ours at equal strength. Both load
// with the panel (no other sheet sets the panel's properties as strongly).
import "./terminal-panel.css";
import type { TerminalSessionInfo } from "../../shared/types";
import { type MenuPosition } from "../ui/Menu";
import { inheritTab } from "./terminal-tabs";
import { useTerminalPrefs } from "./terminal-prefs";
import { type PendingClose } from "./terminal-close";
import "./terminal-panel.css";
import { onTerminalTabRequest, takeTerminalTab } from "../code-run/run-store";
import { usePaneExpandToggle } from "../app/pane-expand";
import { type TerminalControls, type PillPlace } from "./TerminalCanvas";
export function TerminalPanel({
  conversationId,
  accountId,
  onAttachSelection,
  onClose,
}: {
  conversationId: string;
  /**
   * Keeps a dragged width per account; without one it lasts only while the
   * panel is open.
   */
  accountId?: string;
  /**
   * Attach selection as context: puts the selected text in this
   * conversation's composer, named after the terminal. Left out where the
   * composer can't take it, which hides the menu item.
   */
  onAttachSelection?: (text: string, label: string) => void;
  onClose: () => void;
}) {
  const api = window.desktop;
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState(false),
    [error, setError] = useState("");
  // ⇧⌘\ expands or restores the card (src/app/pane-expand.ts).
  usePaneExpandToggle("terminal", () => setExpanded((value) => !value));
  // The tab and canvas menus, and the tab being renamed. A tab's number is
  // its place in the order the terminals were opened, kept when another one
  // closes (terminal-tabs.ts).
  const [menu, setMenu] = useState<{
    position: MenuPosition;
    /** The tab it was opened on; absent for the terminal canvas. */
    tab?: string;
    selection: string;
  }>();
  const [renaming, setRenaming] = useState<string>();
  const prefs = useTerminalPrefs();
  // The shells a new tab can start with (Choose shell, two or more).
  const [shells, setShells] = useState<{ id: string; name: string }[]>([]);
  const [ownShell, setOwnShell] = useState("");
  // Failed to start shell: the overlay with Try again.
  const [startFailed, setStartFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // Find in terminal: open, its text, and whether the last search found nothing.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [noResults, setNoResults] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const [pill, setPill] = useState<PillPlace>(null);
  const [announce, setAnnounce] = useState("");
  const [shellMenu, setShellMenu] = useState<MenuPosition>();
  const [optionsMenu, setOptionsMenu] = useState<MenuPosition>();
  const [overflowMenu, setOverflowMenu] = useState<MenuPosition>();
  const [overflowing, setOverflowing] = useState(false);
  const tabStrip = useRef<HTMLDivElement>(null);
  const [, renamed] = useState(0);
  // Close terminal? / Close other terminals?, while a command runs in a
  // tab being closed (terminal-close.ts).
  const [pendingClose, setPendingClose] = useState<PendingClose>();
  const current = useRef(sessions);
  current.current = sessions;
  const controls = useRef<TerminalControls | null>(null);
  const cancelRename = useRef(false);
  const onError = useCallback(
    (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    [],
  );
  useEffect(() => {
    let live = true;
    const unsubscribe = api.onEvent((event) => {
      if (!live) return;
      if (
        event.type === "terminal-exit" &&
        event.conversationId === conversationId
      ) {
        setSessions((current) =>
          current.map((session) =>
            session.id === event.id ? { ...session, running: false } : session,
          ),
        );
        if (event.error) setError(event.error);
      }
      if (
        event.type === "terminal-busy" &&
        event.conversationId === conversationId
      )
        setSessions((current) =>
          current.map((session) =>
            session.id === event.id
              ? { ...session, busy: event.busy }
              : session,
          ),
        );
      if (event.type === "terminal-reset") {
        setSessions([]);
        setActiveId(undefined);
      }
    });
    setStartFailed(false);
    void api
      .terminalEnsure(conversationId)
      .then((items) => {
        if (!live) return;
        setSessions(items);
        setActiveId((current) =>
          items.some((item) => item.id === current) ? current : items[0]?.id,
        );
      })
      .catch(() => {
        if (live) setStartFailed(true);
      });
    Promise.resolve()
      .then(() => api.terminalShells(conversationId))
      .then(
        (result) => {
          if (!live) return;
          setShells(result.shells);
          setOwnShell(result.defaultId);
        },
        () => undefined,
      );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [conversationId, retry]);
  // Open in terminal (a code block's run): that tab, listed again first.
  useEffect(() => {
    const show = () => {
      const wanted = takeTerminalTab(conversationId);
      if (!wanted) return;
      void api
        .terminalList(conversationId)
        .then((items) => {
          setSessions(items);
          if (items.some((item) => item.id === wanted)) setActiveId(wanted);
        })
        .catch(onError);
    };
    show();
    return onTerminalTabRequest(show);
  }, [conversationId]);
  /** The default shell: the one chosen under Default shell when it is still here. */
  const defaultShell = shells.some((shell) => shell.id === prefs.defaultShell)
    ? prefs.defaultShell
    : ownShell;
  const add = async (shell?: string) => {
    setBusy(true);
    setError("");
    try {
      const chosen =
        shell ??
        (defaultShell && defaultShell !== ownShell ? defaultShell : undefined);
      const next = await api.terminalStart(conversationId, chosen);
      setSessions((current) => [...current, next]);
      setActiveId(next.id);
      setStartFailed(false);
    } catch (reason) {
      if (!current.current.length) setStartFailed(true);
      else onError(reason);
    } finally {
      setBusy(false);
    }
  };
  /** Restart shell: a new shell with the same program in the exited tab's place and name. */
  const restart = async (id: string) => {
    const old = current.current.find((item) => item.id === id);
    if (!old) return;
    setBusy(true);
    setError("");
    try {
      const next = await api.terminalStart(conversationId, old.shell);
      inheritTab(conversationId, id, next.id);
      await api.terminalClose(conversationId, id).catch(() => undefined);
      setSessions((items) =>
        items.map((item) => (item.id === id ? next : item)),
      );
      setActiveId(next.id);
    } catch (reason) {
      onError(reason);
    } finally {
      setBusy(false);
    }
  };
  const { terminalPanelViewView } = useTerminalPanelActions({
    accountId,
    activeId,
    add,
    announce,
    api,
    busy,
    cancelRename,
    controls,
    conversationId,
    current,
    defaultShell,
    error,
    expanded,
    findInput,
    finding,
    menu,
    noResults,
    onAttachSelection,
    onClose,
    onError,
    optionsMenu,
    overflowMenu,
    overflowing,
    ownShell,
    pendingClose,
    pill,
    prefs,
    query,
    renamed,
    renaming,
    restart,
    sessions,
    setActiveId,
    setAnnounce,
    setExpanded,
    setFinding,
    setMenu,
    setNoResults,
    setOptionsMenu,
    setOverflowMenu,
    setOverflowing,
    setPendingClose,
    setPill,
    setQuery,
    setRenaming,
    setRetry,
    setSessions,
    setShellMenu,
    shellMenu,
    shells,
    startFailed,
    tabStrip,
  });
  return terminalPanelViewView;
}
