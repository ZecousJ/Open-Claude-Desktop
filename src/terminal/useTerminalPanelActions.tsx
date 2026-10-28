import { busyTabs, closeRequest, stillPending } from "./terminal-close";
import {
  forgetTab,
  tabNumber,
  tabLabel,
  hasTabName,
  cleanTabName,
} from "./terminal-tabs";
import { useEffect, useContext, useRef } from "react";
import { isMacPlatform } from "../host/keys";
import { ShortcutPlatform } from "../ui/Tooltip";
import type { MenuEntry, MenuPosition } from "../ui/Menu";
import { terminalCanvasMenu } from "./terminal-menu";
import { t, formatText, tc } from "../i18n";
import {
  useStoredPanelWidth,
  terminalPanelBounds,
  useRailWidth,
} from "../conversation/BackgroundPanelResize";
import type { TerminalSessionInfo, DesktopAPI } from "../../shared/types";
import type { PendingClose } from "./terminal-close";
import { setTerminalPrefs, cursorStyles, scrollbacks } from "./terminal-prefs";
import { terminalPanelView } from "./TerminalPanelView";
import type { TerminalControls, PillPlace } from "./TerminalCanvas";
import type { TerminalPrefs } from "./terminal-prefs";

/** What useTerminalPanelActions needs from TerminalPanel.tsx. */
export interface UseTerminalPanelActionsKit {
  accountId: string | undefined;
  activeId: string | undefined;
  add: (shell?: string | undefined) => Promise<void>;
  announce: string;
  api: DesktopAPI;
  busy: boolean;
  cancelRename: React.RefObject<boolean>;
  controls: React.RefObject<TerminalControls | null>;
  conversationId: string;
  current: React.RefObject<TerminalSessionInfo[]>;
  defaultShell: string;
  error: string;
  expanded: boolean;
  findInput: React.RefObject<HTMLInputElement | null>;
  finding: boolean;
  menu:
    | { position: MenuPosition; tab?: string | undefined; selection: string }
    | undefined;
  noResults: boolean;
  onAttachSelection: ((text: string, label: string) => void) | undefined;
  onClose: () => void;
  onError: (reason: unknown) => void;
  optionsMenu: MenuPosition | undefined;
  overflowMenu: MenuPosition | undefined;
  overflowing: boolean;
  ownShell: string;
  pendingClose: PendingClose | undefined;
  pill: PillPlace;
  prefs: TerminalPrefs;
  query: string;
  renamed: React.Dispatch<React.SetStateAction<number>>;
  renaming: string | undefined;
  restart: (id: string) => Promise<void>;
  sessions: TerminalSessionInfo[];
  setActiveId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setAnnounce: React.Dispatch<React.SetStateAction<string>>;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setFinding: React.Dispatch<React.SetStateAction<boolean>>;
  setMenu: React.Dispatch<
    React.SetStateAction<
      | { position: MenuPosition; tab?: string | undefined; selection: string }
      | undefined
    >
  >;
  setNoResults: React.Dispatch<React.SetStateAction<boolean>>;
  setOptionsMenu: React.Dispatch<
    React.SetStateAction<MenuPosition | undefined>
  >;
  setOverflowMenu: React.Dispatch<
    React.SetStateAction<MenuPosition | undefined>
  >;
  setOverflowing: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingClose: React.Dispatch<
    React.SetStateAction<PendingClose | undefined>
  >;
  setPill: React.Dispatch<React.SetStateAction<PillPlace>>;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  setRenaming: React.Dispatch<React.SetStateAction<string | undefined>>;
  setRetry: React.Dispatch<React.SetStateAction<number>>;
  setSessions: React.Dispatch<React.SetStateAction<TerminalSessionInfo[]>>;
  setShellMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  shellMenu: MenuPosition | undefined;
  shells: { id: string; name: string }[];
  startFailed: boolean;
  tabStrip: React.RefObject<HTMLDivElement | null>;
}

export function useTerminalPanelActions(kit: UseTerminalPanelActionsKit) {
  const {
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
  } = kit;
  /** Moves a tab one place left or right (Control+Shift+Arrow). */
  const move = (id: string, step: -1 | 1) =>
    setSessions((items) => {
      const at = items.findIndex((item) => item.id === id);
      const to = at + step;
      if (at < 0 || to < 0 || to >= items.length) return items;
      const next = [...items];
      [next[at], next[to]] = [next[to], next[at]];
      return next;
    });
  /**
   * Which tabs have a command running, asked of the main process at the
   * moment of closing; what the window last heard when it can't answer.
   * The tabs it names are marked busy here too, so the question stays up
   * until the window hears the commands end.
   */
  const probeBusy = async () => {
    const busy = await api
      .terminalBusy(conversationId)
      .catch(() => busyTabs(current.current));
    if (busy.length)
      setSessions((items) =>
        items.map((item) =>
          busy.includes(item.id) && item.busy !== true
            ? { ...item, busy: true }
            : item,
        ),
      );
    return busy;
  };
  const closeNow = async (id: string) => {
    try {
      await api.terminalClose(conversationId, id);
      forgetTab(conversationId, id);
      setSessions((current) => current.filter((item) => item.id !== id));
      setActiveId((active) =>
        active === id
          ? current.current.find((item) => item.id !== id)?.id
          : active,
      );
    } catch (reason) {
      onError(reason);
    }
  };
  /** Close terminal: asks first while a command is running in the tab. */
  const close = async (id: string) => {
    const busy = await probeBusy();
    const tabs = current.current;
    if (!tabs.some((item) => item.id === id)) return;
    const pending = closeRequest({ kind: "close", id }, tabs, busy);
    if (pending) setPendingClose(pending);
    else await closeNow(id);
  };
  /** Close other terminals: asks first while a command runs in any of them. */
  const closeOthers = async (keep: string) => {
    const busy = await probeBusy();
    const pending = closeRequest(
      { kind: "closeOthers", keep },
      current.current,
      busy,
    );
    if (pending) setPendingClose(pending);
    else if (current.current.some((item) => item.id === keep))
      await closeOthersNow(keep);
  };
  // The question goes away by itself once the commands it is about end.
  useEffect(() => {
    if (pendingClose && !stillPending(pendingClose, sessions))
      setPendingClose(undefined);
  }, [pendingClose, sessions]);
  /** Every tab but this one, which stays on screen. */
  const closeOthersNow = async (keep: string) => {
    const others = current.current.filter((item) => item.id !== keep);
    const results = await Promise.allSettled(
      others.map((item) => api.terminalClose(conversationId, item.id)),
    );
    const closed = others.filter(
      (_, index) => results[index].status === "fulfilled",
    );
    for (const item of closed) forgetTab(conversationId, item.id);
    setSessions((current) =>
      current.filter((item) => !closed.some((value) => value.id === item.id)),
    );
    setActiveId(keep);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) onError((failed as PromiseRejectedResult).reason);
  };
  const paste = async () => {
    try {
      controls.current?.paste(await navigator.clipboard.readText());
    } catch (reason) {
      onError(reason);
    }
  };
  const copy = (text: string) =>
    void (
      api.copyText ? api.copyText(text) : navigator.clipboard.writeText(text)
    ).catch(onError);
  const mac = isMacPlatform(useContext(ShortcutPlatform));
  /** The menu of a tab (right click) or of the terminal canvas. */
  function menuEntries(): MenuEntry[] {
    if (!menu) return [];
    const clear: MenuEntry = {
      label: "Clear terminal",
      onSelect: () => controls.current?.clear(),
    };
    if (menu.tab === undefined) {
      const shown = active ? label(active) : "Terminal";
      return terminalCanvasMenu(
        menu.selection,
        {
          attach: onAttachSelection && ((text) => attachText(text, shown)),
          copy,
          paste: () => void paste(),
          selectAll: () => controls.current?.selectAll(),
          clear: () => controls.current?.clear(),
        },
        mac,
      );
    }
    const tab = menu.tab;
    // The original's tab menu: Rename, Clear (only for the terminal on
    // screen), then the closing ones.
    const clearReason = !controls.current
      ? t("No terminal to clear")
      : tab !== activeId
        ? t("Switch to this terminal first")
        : undefined;
    return [
      {
        label: "Rename terminal",
        // After the menu has closed and given focus back, or the field loses it at once.
        onSelect: () => requestAnimationFrame(() => setRenaming(tab)),
      },
      { ...clear, disabled: clearReason !== undefined, title: clearReason },
      { separator: true },
      { label: "Close terminal", onSelect: () => void close(tab) },
      ...(sessions.length > 1
        ? [
            {
              label: "Close other terminals",
              onSelect: () => void closeOthers(tab),
            },
          ]
        : []),
    ];
  }
  // The card's left edge drags like the Background rail's: the width is
  // published as --terminal-panel-width and, once set, replaces the 299px
  // default (terminal-panel.css). Expanded, the card is full width.
  const panelRef = useRef<HTMLElement>(null);
  const { width, setWidth, persist } = useStoredPanelWidth(
    "terminal",
    accountId,
    terminalPanelBounds,
  );
  useRailWidth(
    panelRef,
    expanded ? undefined : width,
    "--terminal-panel-width",
  );
  const active = sessions.find((session) => session.id === activeId);
  // One terminal is just "Terminal"; with more, the title becomes a row of
  // "Terminal N" tabs, each with its own ×.
  for (const session of sessions) tabNumber(conversationId, session.id);
  const label = (session: TerminalSessionInfo) =>
    tabLabel(
      conversationId,
      session.id,
      sessions.length,
      tabNumber(conversationId, session.id),
    );
  /**
   * The tab "Close terminal?" names, as its tab shows it: a name it was
   * given as typed, "Terminal" or "Terminal N" in the window's language.
   */
  const closingName = (pending: PendingClose) => {
    const session =
      pending.kind === "close"
        ? sessions.find((item) => item.id === pending.id)
        : undefined;
    if (!session) return "";
    const shown = label(session);
    return hasTabName(conversationId, session.id) ? shown : t(shown);
  };
  /** A tab's menu; Clear terminal there acts only on the terminal on screen. */
  const tabMenu = (id: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({
      position: { left: event.clientX, top: event.clientY },
      tab: id,
      selection: "",
    });
  };
  /** The name field that replaces a tab's label while it is renamed. */
  const renameField = (session: TerminalSessionInfo) => (
    <input
      className="terminal-tab-rename"
      aria-label="Terminal name"
      autoFocus
      maxLength={40}
      defaultValue={label(session)}
      onFocus={(event) => {
        cancelRename.current = false;
        event.currentTarget.select();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.stopPropagation();
          cancelRename.current = true;
          setRenaming(undefined);
        }
      }}
      onBlur={(event) => {
        if (cancelRename.current) cancelRename.current = false;
        else if (renaming === session.id) {
          // Leaving the field as it was keeps the tab as it was.
          if (event.currentTarget.value !== label(session))
            cleanTabName(conversationId, session.id, event.currentTarget.value);
          renamed((value) => value + 1);
          setRenaming(undefined);
        }
      }}
    />
  );
  /** A tab's label in the window's language (a given name stays as typed). */
  const shownLabel = (session: TerminalSessionInfo) => {
    if (hasTabName(conversationId, session.id)) return label(session);
    return sessions.length > 1
      ? formatText("Terminal {number}", {
          number: tabNumber(conversationId, session.id),
        })
      : t("Terminal");
  };
  /** Attach as context, said aloud. */
  const attachText = (text: string, name: string) => {
    onAttachSelection?.(text, name);
    setAnnounce("");
    requestAnimationFrame(() =>
      setAnnounce(t("Terminal output attached to chat")),
    );
  };
  const step = (direction: "next" | "previous") => {
    if (!query) return;
    setNoResults(!controls.current?.find(query, direction, false));
  };
  const endFind = () => {
    setFinding(false);
    setNoResults(false);
    controls.current?.endFind();
    controls.current?.focus();
  };
  // More terminals: shown once the tabs no longer fit their strip.
  useEffect(() => {
    const strip = tabStrip.current;
    if (!strip) return;
    const check = () =>
      setOverflowing(strip.scrollWidth > strip.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [sessions.length, expanded]);
  /** Choose shell: each shell ("default" on the default one), then Default shell. */
  const shellEntries = (): MenuEntry[] => [
    ...shells.map((shell) => ({
      label: shell.name,
      noTranslate: true,
      hint: shell.id === defaultShell ? t("default") : undefined,
      onSelect: () => void add(shell.id),
    })),
    { separator: true as const },
    {
      label: "Default shell",
      submenu: shells.map((shell) => ({
        label: shell.name,
        noTranslate: true,
        checked: shell.id === defaultShell,
        onSelect: () =>
          setTerminalPrefs({
            defaultShell: shell.id === ownShell ? "" : shell.id,
          }),
      })),
    },
  ];
  /** The pane menu's view settings (cursor, blink, copy on select, scrollback). */
  const cursorNames: Record<string, string> = {
    block: "Block",
    bar: "Bar",
    underline: "Underline",
  };
  const lines = (count: number) =>
    formatText("{lines} lines", { lines: count.toLocaleString() });
  const optionEntries = (): MenuEntry[] => [
    {
      label: "Cursor style",
      value: tc("cursor", cursorNames[prefs.cursorStyle]),
      submenu: cursorStyles.map((style) => ({
        label: tc("cursor", cursorNames[style]),
        noTranslate: true,
        checked: prefs.cursorStyle === style,
        onSelect: () => setTerminalPrefs({ cursorStyle: style }),
      })),
    },
    {
      label: "Blink cursor",
      checked: prefs.cursorBlink,
      keepOpen: true,
      onSelect: () => setTerminalPrefs({ cursorBlink: !prefs.cursorBlink }),
    },
    {
      label: "Copy on select",
      checked: prefs.copyOnSelect,
      keepOpen: true,
      onSelect: () => setTerminalPrefs({ copyOnSelect: !prefs.copyOnSelect }),
    },
    {
      label: "Scrollback",
      value: lines(prefs.scrollback),
      submenu: scrollbacks.map((count) => ({
        label: lines(count),
        noTranslate: true,
        checked: prefs.scrollback === count,
        onSelect: () => setTerminalPrefs({ scrollback: count }),
      })),
    },
  ];
  const terminalPanelViewView = terminalPanelView({
    active,
    activeId,
    add,
    announce,
    attachText,
    busy,
    close,
    closeNow,
    closeOthersNow,
    closingName,
    controls,
    conversationId,
    copy,
    endFind,
    error,
    expanded,
    findInput,
    finding,
    label,
    mac,
    menu,
    menuEntries,
    move,
    noResults,
    onAttachSelection,
    onClose,
    onError,
    optionEntries,
    optionsMenu,
    overflowMenu,
    overflowing,
    panelRef,
    paste,
    pendingClose,
    persist,
    pill,
    prefs,
    query,
    renameField,
    renaming,
    restart,
    sessions,
    setActiveId,
    setExpanded,
    setFinding,
    setMenu,
    setNoResults,
    setOptionsMenu,
    setOverflowMenu,
    setPendingClose,
    setPill,
    setQuery,
    setRetry,
    setShellMenu,
    setWidth,
    shellEntries,
    shellMenu,
    shells,
    shownLabel,
    startFailed,
    step,
    tabMenu,
    tabStrip,
    width,
  });
  return { terminalPanelViewView } as const;
}
