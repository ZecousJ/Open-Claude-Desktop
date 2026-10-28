import {
  BackgroundPanelResize,
  terminalPanelBounds,
} from "../conversation/BackgroundPanelResize";
import { t } from "../i18n";
import {
  X,
  ChevronDown,
  Plus,
  MoreHorizontal,
  Minimize2,
  Maximize2,
  ArrowUp,
  ArrowDown,
} from "../ui/glyphs";
import { IconButton } from "../ui/Controls";
import { TerminalCanvas } from "./TerminalCanvas";
import { attachableSelection } from "./terminal-menu";
import { TerminalCloseDialog } from "./TerminalCloseDialog";
import { Menu } from "../ui/Menu";
import { hasTabName } from "./terminal-tabs";
import type { TerminalSessionInfo } from "../../shared/types";
import type { PendingClose } from "./terminal-close";
import type { TerminalControls, PillPlace } from "./TerminalCanvas";
import type { MenuPosition, MenuEntry } from "../ui/Menu";
import type { TerminalPrefs } from "./terminal-prefs";

/** What terminalPanelView needs from TerminalPanel.tsx. */
export interface TerminalPanelViewKit {
  active: TerminalSessionInfo | undefined;
  activeId: string | undefined;
  add: (shell?: string | undefined) => Promise<void>;
  announce: string;
  attachText: (text: string, name: string) => void;
  busy: boolean;
  close: (id: string) => Promise<void>;
  closeNow: (id: string) => Promise<void>;
  closeOthersNow: (keep: string) => Promise<void>;
  closingName: (pending: PendingClose) => string;
  controls: React.RefObject<TerminalControls | null>;
  conversationId: string;
  copy: (text: string) => undefined;
  endFind: () => void;
  error: string;
  expanded: boolean;
  findInput: React.RefObject<HTMLInputElement | null>;
  finding: boolean;
  label: (session: TerminalSessionInfo) => string;
  mac: boolean;
  menu:
    | { position: MenuPosition; tab?: string | undefined; selection: string }
    | undefined;
  menuEntries: () => MenuEntry[];
  move: (id: string, step: 1 | -1) => void;
  noResults: boolean;
  onAttachSelection: ((text: string, label: string) => void) | undefined;
  onClose: () => void;
  onError: (reason: unknown) => void;
  optionEntries: () => MenuEntry[];
  optionsMenu: MenuPosition | undefined;
  overflowMenu: MenuPosition | undefined;
  overflowing: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  paste: () => Promise<void>;
  pendingClose: PendingClose | undefined;
  persist: (value: number) => void;
  pill: PillPlace;
  prefs: TerminalPrefs;
  query: string;
  renameField: (session: TerminalSessionInfo) => React.JSX.Element;
  renaming: string | undefined;
  restart: (id: string) => Promise<void>;
  sessions: TerminalSessionInfo[];
  setActiveId: React.Dispatch<React.SetStateAction<string | undefined>>;
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
  setPendingClose: React.Dispatch<
    React.SetStateAction<PendingClose | undefined>
  >;
  setPill: React.Dispatch<React.SetStateAction<PillPlace>>;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  setRetry: React.Dispatch<React.SetStateAction<number>>;
  setShellMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setWidth: React.Dispatch<React.SetStateAction<number | undefined>>;
  shellEntries: () => MenuEntry[];
  shellMenu: MenuPosition | undefined;
  shells: { id: string; name: string }[];
  shownLabel: (session: TerminalSessionInfo) => string;
  startFailed: boolean;
  step: (direction: "next" | "previous") => void;
  tabMenu: (
    id: string,
  ) => (event: React.MouseEvent<Element, MouseEvent>) => void;
  tabStrip: React.RefObject<HTMLDivElement | null>;
  width: number | undefined;
}

export function terminalPanelView(kit: TerminalPanelViewKit) {
  const {
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
  } = kit;
  const terminalPanelViewView = (
    <aside
      ref={panelRef}
      className={`work-panel terminal-panel ${expanded ? "expanded" : ""}`}
      data-width={!expanded && width ? width : undefined}
    >
      {!expanded && (
        <BackgroundPanelResize
          panel={panelRef}
          width={width}
          onResize={setWidth}
          persist={persist}
          label="Resize Chat and Terminal"
          bounds={terminalPanelBounds}
        />
      )}
      <header>
        <div className="terminal-heading">
          {sessions.length > 0 && (
            <div
              ref={tabStrip}
              className="terminal-tabs"
              role="tablist"
              aria-label={t("Terminal tabs")}
              data-overflowing={overflowing || undefined}
              onDoubleClick={(event) => {
                // A double click on the empty strip opens a terminal.
                if (event.target === event.currentTarget && !busy) void add();
              }}
              onKeyDown={(event) => {
                const at = sessions.findIndex((item) => item.id === activeId);
                if (at < 0 || renaming) return;
                const focusTab = (index: number) => {
                  const next = sessions[index];
                  if (!next) return;
                  setActiveId(next.id);
                  requestAnimationFrame(() =>
                    tabStrip.current
                      ?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)
                      ?.focus(),
                  );
                };
                const step =
                  event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowLeft"
                      ? -1
                      : 0;
                if (step && event.ctrlKey && event.shiftKey) {
                  event.preventDefault();
                  move(sessions[at].id, step);
                } else if (step) {
                  event.preventDefault();
                  focusTab((at + step + sessions.length) % sessions.length);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  focusTab(0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  focusTab(sessions.length - 1);
                } else if (
                  event.key === "Delete" ||
                  event.key === "Backspace"
                ) {
                  event.preventDefault();
                  void close(sessions[at].id);
                }
              }}
            >
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={`terminal-tab ${activeId === session.id ? "active" : ""}`}
                  onContextMenu={tabMenu(session.id)}
                >
                  {renaming === session.id ? (
                    renameField(session)
                  ) : (
                    <button
                      role="tab"
                      data-tab-id={session.id}
                      aria-selected={activeId === session.id}
                      aria-describedby="terminal-tab-close-hint terminal-tab-move-hint"
                      tabIndex={activeId === session.id ? 0 : -1}
                      onClick={() => setActiveId(session.id)}
                    >
                      <span className="terminal-tab-label">
                        {shownLabel(session)}
                      </span>
                      {!session.running && (
                        <span
                          className="terminal-exit-dot"
                          aria-label="Exited"
                        />
                      )}
                    </button>
                  )}
                  <button
                    className="terminal-tab-close"
                    tabIndex={-1}
                    aria-hidden="true"
                    aria-label={`${t("Close terminal")} ${label(session)}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void close(session.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <span id="terminal-tab-close-hint" className="sr-only">
                {t("Press Delete or Backspace to close the terminal")}
              </span>
              <span id="terminal-tab-move-hint" className="sr-only">
                {t(
                  "Press Control+Shift+Left Arrow or Right Arrow to move the terminal",
                )}
              </span>
            </div>
          )}
          {overflowing && (
            <IconButton
              label="More terminals"
              className="terminal-more"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setOverflowMenu({ left: box.left, top: box.bottom + 4 });
              }}
            >
              <ChevronDown size={14} />
            </IconButton>
          )}
          <span className="terminal-new-group">
            <IconButton
              label="New terminal"
              className="terminal-new"
              disabled={busy}
              onClick={() => void add()}
            >
              <Plus size={15} />
            </IconButton>
            {shells.length >= 2 && (
              <IconButton
                label="Choose shell"
                className="terminal-new-menu"
                disabled={busy}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setShellMenu({ left: box.left, top: box.bottom + 4 });
                }}
              >
                <ChevronDown size={12} />
              </IconButton>
            )}
          </span>
        </div>
        <div className="terminal-controls">
          <IconButton
            label="Terminal options"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setOptionsMenu({
                right: window.innerWidth - box.right,
                top: box.bottom + 4,
              });
            }}
          >
            <MoreHorizontal size={15} />
          </IconButton>
          <IconButton
            label={expanded ? "Restore terminal size" : "Expand terminal"}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
          <IconButton label="Close panel" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
      </header>
      {error && (
        <div className="terminal-error" role="alert">
          {error}
        </div>
      )}
      <div className="terminal-stage">
        {active ? (
          <TerminalCanvas
            key={active.id}
            conversationId={conversationId}
            session={active}
            label={label(active)}
            controls={controls}
            mac={mac}
            prefs={prefs}
            onSelection={setPill}
            onCopySelection={copy}
            onFind={() => {
              setFinding(true);
              requestAnimationFrame(() => {
                findInput.current?.focus();
                findInput.current?.select();
              });
            }}
            onKey={(action, selection) => {
              if (action === "paste") void paste();
              else if (action === "copy") {
                if (selection) copy(selection);
              } else {
                // Without text to attach, or a composer to take it, the key
                // goes on to the shell as before.
                const text = attachableSelection(selection);
                if (!text || !onAttachSelection) return false;
                attachText(text, label(active));
              }
              return true;
            }}
            onMenu={(position) =>
              setMenu({
                position,
                selection: controls.current?.selection() ?? "",
              })
            }
            onError={onError}
          />
        ) : (
          !startFailed && (
            <div className="panel-empty">
              {"No terminal open "}
              <button onClick={() => void add()}>New terminal</button>
            </div>
          )
        )}
        {startFailed && (
          <div className="terminal-overlay">
            <span id="terminal-overlay-title">
              {t("Failed to start shell")}
            </span>
            <button
              className="secondary"
              aria-describedby="terminal-overlay-title"
              onClick={() => setRetry((n) => n + 1)}
            >
              {t("Try again")}
            </button>
          </div>
        )}
        {!startFailed && active && !active.running && (
          <div className="terminal-overlay">
            <span id="terminal-overlay-title">{t("Shell exited")}</span>
            <button
              className="secondary"
              aria-describedby="terminal-overlay-title"
              autoFocus
              disabled={busy}
              onClick={() => void restart(active.id)}
            >
              {t("Restart shell")}
            </button>
          </div>
        )}
        {active && active.running && pill && onAttachSelection && (
          <div
            className="selection-reply terminal-attach-pill"
            role="group"
            style={{ left: pill.left, top: pill.top }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <button
              type="button"
              onClick={() => {
                const text = attachableSelection(
                  controls.current?.selection() ?? "",
                );
                if (text) attachText(text, label(active));
              }}
            >
              {t("Attach as context")}
              <kbd className="terminal-attach-keys">
                {mac ? "⇧⌘L" : "Ctrl+Shift+L"}
              </kbd>
            </button>
          </div>
        )}
        {finding && active && (
          <div
            className="terminal-find"
            role="search"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                endFind();
              }
            }}
          >
            <span className="terminal-find-field">
              <input
                ref={findInput}
                value={query}
                spellCheck={false}
                autoComplete="off"
                aria-label={t("Find in terminal")}
                placeholder={t("Find in terminal…")}
                onChange={(event) => {
                  const value = event.target.value;
                  setQuery(value);
                  setNoResults(
                    value !== "" &&
                      !controls.current?.find(value, "previous", true),
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    step(event.shiftKey ? "next" : "previous");
                  }
                }}
              />
              <span aria-live="polite" className="terminal-find-status">
                {noResults ? t("No results") : ""}
              </span>
            </span>
            <IconButton label="Previous match" onClick={() => step("previous")}>
              <ArrowUp size={14} />
            </IconButton>
            <IconButton label="Next match" onClick={() => step("next")}>
              <ArrowDown size={14} />
            </IconButton>
            <IconButton label="Close find bar" onClick={endFind}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {announce}
        </span>
      </div>
      {pendingClose && (
        <TerminalCloseDialog
          pending={pendingClose}
          name={closingName(pendingClose)}
          onCancel={() => setPendingClose(undefined)}
          onConfirm={() => {
            const pending = pendingClose;
            setPendingClose(undefined);
            if (pending.kind === "close") void closeNow(pending.id);
            else void closeOthersNow(pending.keep);
          }}
        />
      )}
      {shellMenu && (
        <Menu
          label="Choose shell"
          entries={shellEntries()}
          position={shellMenu}
          width={220}
          onClose={() => setShellMenu(undefined)}
        />
      )}
      {optionsMenu && (
        <Menu
          label="Terminal options"
          entries={optionEntries()}
          position={optionsMenu}
          width={230}
          onClose={() => setOptionsMenu(undefined)}
        />
      )}
      {overflowMenu && (
        <Menu
          label="More terminals"
          entries={sessions.map((session) => ({
            label: label(session),
            noTranslate: hasTabName(conversationId, session.id),
            checked: session.id === activeId,
            onSelect: () => {
              setActiveId(session.id);
              requestAnimationFrame(() =>
                tabStrip.current
                  ?.querySelector<HTMLElement>(`[data-tab-id="${session.id}"]`)
                  ?.scrollIntoView({ inline: "nearest", block: "nearest" }),
              );
            },
          }))}
          position={overflowMenu}
          width={200}
          onClose={() => setOverflowMenu(undefined)}
        />
      )}
      {menu && (
        <Menu
          label={menu.tab === undefined ? "Terminal" : "Terminal tab"}
          entries={menuEntries()}
          position={menu.position}
          width={190}
          onClose={() => setMenu(undefined)}
        />
      )}
    </aside>
  );
  return terminalPanelViewView;
}
