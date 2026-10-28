import "@xterm/xterm/css/xterm.css";
import "./terminal-panel.css";
import { useEffect, useRef, type MutableRefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { AppEvent, TerminalSessionInfo } from "../../shared/types";
import { type MenuPosition } from "../ui/Menu";
import { type TerminalPrefs } from "./terminal-prefs";
import { terminalTheme, windowMode } from "./terminal-theme";
import { terminalKey } from "./terminal-menu";

function decode(base64: string) {
  const binary = atob(base64),
    bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function TerminalCanvas({
  conversationId,
  session,
  label,
  controls,
  mac,
  onMenu,
  onKey,
  onError,
  prefs,
  onSelection,
  onFind,
  onCopySelection,
}: {
  conversationId: string;
  session: TerminalSessionInfo;
  label: string;
  controls: MutableRefObject<TerminalControls | null>;
  /** Cursor, blink, copy on select and scrollback (terminal-prefs.ts). */
  prefs: TerminalPrefs;
  /** The selection's pill place as the selection changes. */
  onSelection: (place: PillPlace) => void;
  /** ⌘F (Ctrl+F elsewhere) in the normal buffer: Find in terminal. */
  onFind: () => void;
  /** Copy on select. */
  onCopySelection: (text: string) => void;
  /** Whether the window is on macOS, which decides the menu's keys. */
  mac: boolean;
  /** A right click on the terminal: where its menu goes. */
  onMenu: (position: MenuPosition) => void;
  /**
   * One of the menu's keys xterm leaves alone, with the selection then;
   * answers whether it acted (else xterm handles the key as usual).
   */
  onKey: (action: "attach" | "copy" | "paste", selection: string) => boolean;
  onError: (error: unknown) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const keyHandler = useRef({ mac, onKey, onFind });
  keyHandler.current = { mac, onKey, onFind };
  const selectionHandler = useRef({ onSelection, onCopySelection, prefs });
  selectionHandler.current = { onSelection, onCopySelection, prefs };
  const terminalRef = useRef<Terminal | null>(null);
  // The view settings apply to the open terminal as they change.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorStyle = prefs.cursorStyle;
    terminal.options.cursorInactiveStyle =
      prefs.cursorStyle === "block" ? "outline" : prefs.cursorStyle;
    terminal.options.cursorBlink = prefs.cursorBlink;
    terminal.options.scrollback = prefs.scrollback;
  }, [prefs.cursorStyle, prefs.cursorBlink, prefs.scrollback]);
  useEffect(() => {
    const api = window.desktop;
    const host = container.current;
    if (!host) return;
    let live = true,
      ready = false;
    const queued: Extract<AppEvent, { type: "terminal-output" }>[] = [];
    // 7.0 x 15.0 cells (39 characters in 271.5px, 7 rows in 89px), #ebebed text
    // on the panel's #1a1a1a, and a solid #4397f9 block cursor that blinks
    // every 600ms (terminal-panel.css).
    const start = selectionHandler.current.prefs;
    const terminal = new Terminal({
      cursorBlink: start.cursorBlink,
      cursorStyle: start.cursorStyle,
      cursorInactiveStyle:
        start.cursorStyle === "block" ? "outline" : start.cursorStyle,
      scrollback: start.scrollback,
      // xterm rounds letterSpacing to whole device pixels, so -0.22 did
      // nothing: the 7.0px advance comes from the font size instead.
      fontSize: 11.6,
      lineHeight: 1.1,
      letterSpacing: 0,
      // The Settings code font, when set, comes first (see useAppearance).
      fontFamily: `${getComputedStyle(document.documentElement).getPropertyValue("--code-font-custom").trim()} Menlo, Monaco, Consolas, "Courier New", monospace`,
      allowTransparency: false,
      // The original's claude-dark / claude-light (terminal-theme.ts).
      theme: terminalTheme(windowMode()),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const search = new SearchAddon();
    terminal.loadAddon(search);
    terminal.open(host);
    terminalRef.current = terminal;
    // The window's light or dark theme, as it changes.
    const retheme = () => {
      terminal.options.theme = terminalTheme(windowMode());
    };
    const themeWatch = new MutationObserver(retheme);
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    media?.addEventListener?.("change", retheme);
    // The pill above the selection, and Copy on select.
    const placePill = () => {
      const {
        onSelection: place,
        onCopySelection: copySelection,
        prefs: now,
      } = selectionHandler.current;
      const position = terminal.hasSelection()
        ? terminal.getSelectionPosition()
        : undefined;
      if (!position || !terminal.getSelection().trim()) return place(null);
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return place(null);
      const row = position.start.y - terminal.buffer.active.viewportY;
      if (row < 0 || row >= terminal.rows) return place(null);
      const cellWidth = screen.clientWidth / terminal.cols;
      const cellHeight = screen.clientHeight / terminal.rows;
      const end =
        position.end.y === position.start.y ? position.end.x : terminal.cols;
      const box = host.getBoundingClientRect();
      const at = screen.getBoundingClientRect();
      place({
        left: at.left - box.left + ((position.start.x + end) / 2) * cellWidth,
        top: at.top - box.top + row * cellHeight - 6,
      });
      if (now.copyOnSelect) copySelection(terminal.getSelection());
    };
    const selecting = terminal.onSelectionChange(placePill);
    const scrolling = terminal.onScroll(placePill);
    // The menu's keys xterm does not take itself (terminal-menu.ts): they
    // act here and never reach the shell or the window's shortcuts.
    terminal.attachCustomKeyEventHandler((event) => {
      const { mac: onMac, onKey: act, onFind: find } = keyHandler.current;
      // Find in terminal, in the normal buffer (a full-screen program keeps the keys).
      if (
        event.type === "keydown" &&
        event.key.toLowerCase() === "f" &&
        !event.shiftKey &&
        !event.altKey &&
        (onMac
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey) &&
        terminal.buffer.active.type === "normal"
      ) {
        event.preventDefault();
        find();
        return false;
      }
      const action = terminalKey(event, onMac);
      if (!action || !act(action, terminal.getSelection())) return true;
      event.preventDefault();
      event.stopPropagation();
      return false;
    });
    controls.current = {
      selection: () => terminal.getSelection(),
      selectAll: () => terminal.selectAll(),
      clear: () => terminal.clear(),
      paste: (text) => terminal.paste(text),
      find: (query, direction, fresh) => {
        if (fresh) terminal.clearSelection();
        if (!query) return false;
        return direction === "next"
          ? search.findNext(query)
          : search.findPrevious(query);
      },
      endFind: () => {
        search.clearDecorations();
        terminal.clearSelection();
      },
      focus: () => terminal.focus(),
    };
    const apply = (event: Extract<AppEvent, { type: "terminal-output" }>) => {
      if (event.id === session.id && event.conversationId === conversationId)
        terminal.write(decode(event.deltaBase64));
    };
    const unsubscribe = api.onEvent((event) => {
      if (
        event.type !== "terminal-output" ||
        event.id !== session.id ||
        event.conversationId !== conversationId
      )
        return;
      if (!ready) queued.push(event);
      else apply(event);
    });
    void api
      .terminalList(conversationId)
      .then((list) => {
        if (!live) return;
        const current = list.find((item) => item.id === session.id);
        if (current?.outputBase64) terminal.write(decode(current.outputBase64));
        ready = true;
        for (const event of queued)
          if (event.sequence > (current?.sequence ?? 0)) apply(event);
        queued.length = 0;
      })
      .catch(onError);
    const input = terminal.onData((data) => {
      if (session.running)
        void api
          .terminalWrite(conversationId, session.id, encode(data))
          .catch(onError);
    });
    const resize = terminal.onResize(({ rows, cols }) => {
      if (session.running)
        void api
          .terminalResize(conversationId, session.id, rows, cols)
          .catch(onError);
    });
    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    });
    observer.observe(host);
    requestAnimationFrame(() => {
      if (live && host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    });
    return () => {
      live = false;
      observer.disconnect();
      themeWatch.disconnect();
      media?.removeEventListener?.("change", retheme);
      selecting.dispose();
      scrolling.dispose();
      terminalRef.current = null;
      unsubscribe();
      input.dispose();
      resize.dispose();
      controls.current = null;
      terminal.dispose();
    };
  }, [conversationId, session.id, session.running, onError]);
  return (
    <div
      className="terminal-canvas"
      ref={container}
      aria-label={label}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ left: event.clientX, top: event.clientY });
      }}
    />
  );
}

/** What the canvas's right-click menu and the tab menu do to the terminal on screen. */
export interface TerminalControls {
  selection(): string;
  selectAll(): void;
  clear(): void;
  paste(text: string): void;
  /** Find in terminal: whether `query` was found going that way. */
  find(query: string, direction: "next" | "previous", fresh: boolean): boolean;
  /** Ends a search's highlight. */
  endFind(): void;
  focus(): void;
}

/** Where the selection's pill goes, inside the canvas (null: no pill). */
export type PillPlace = { left: number; top: number } | null;
