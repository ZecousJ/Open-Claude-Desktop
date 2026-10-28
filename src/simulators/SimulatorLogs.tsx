import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowDown,
  Maximize2,
  Minimize2,
  Search,
  Trash2,
  X,
} from "../ui/glyphs";
import {
  logScope,
  logScopeFull,
  type SimulatorKind,
  type SimulatorLogBatch,
  type SimulatorLogEntry,
  type SimulatorLogLevel,
} from "../../shared/simulators";
import { formatText } from "../i18n";
import { IconButton } from "../ui/Controls";
import { Menu, type MenuPosition } from "../ui/Menu";
import { ResizeHandle } from "../ui/ResizeHandle";
import { below } from "./SimulatorScreens";
import {
  defaultLogLevel,
  filterLogs,
  logLevelName,
  logLevelTag,
  logTime,
  menuLogLevels,
  mergeLogs,
  scopeColumnChars,
  clampScopeWidth,
} from "./simulator-controls";

/** The drawer asks for new lines this often while it is open. */
export const logPollMs = 1000;
/** Rows drawn at most; the count above says how many match. */
const drawnRows = 1500;
/** A log line that reports a crash (iOS fault, Android's FATAL EXCEPTION). */
export function isCrashEntry(entry: SimulatorLogEntry) {
  return (
    entry.level === "crash" ||
    ((entry.level === "fault" || entry.level === "error") &&
      /FATAL EXCEPTION|Fatal error|crashed|EXC_BAD_ACCESS|SIGABRT|SIGSEGV|Terminating app due to uncaught exception/i.test(
        entry.message,
      ))
  );
}

/** Within this many pixels of the end the list follows new lines. */
const followSlop = 8;
/** The drawer's least height, and the room it leaves the screen above. */
const drawerMinPx = 96;
const stageMinPx = 120;

/**
 * Simulator logs: the device's log under the screen. The head has the Min level
 * menu, the filter, the line count, Full height, Clear view and Close logs; the
 * list has Time, Level, Scope and Message columns, follows new lines while it
 * is at the end and offers "Jump to latest" otherwise. A scope chip filters by
 * it.
 */
export function LogsDrawer({
  kind,
  read,
  stop,
  fullHeight,
  onToggleFullHeight,
  onClose,
}: {
  kind: SimulatorKind;
  /** The lines after `since` (starts the device's log stream). */
  read: (since: number) => Promise<SimulatorLogBatch>;
  stop: () => void;
  fullHeight: boolean;
  onToggleFullHeight: () => void;
  onClose: () => void;
}) {
  const [held, setHeld] = useState<{
    captureId: number | undefined;
    entries: SimulatorLogEntry[];
    dropped: number;
  }>({ captureId: undefined, entries: [], dropped: 0 });
  const [loading, setLoading] = useState(true);
  const [ended, setEnded] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [minLevel, setMinLevel] = useState<SimulatorLogLevel>(defaultLogLevel);
  const [query, setQuery] = useState("");
  const [levelMenu, setLevelMenu] = useState<MenuPosition>();
  const [following, setFollowing] = useState(true);
  // How many of the newest matching lines are drawn (Load older lines adds more).
  const [cap, setCap] = useState(drawnRows);
  // The crash the banner shows, until it is dismissed.
  const [dismissedCrash, setDismissedCrash] = useState(0);
  const levelButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const latest = useRef(held);
  latest.current = held;

  // The drawer's height: two fifths of the pane until dragged.
  const drawer = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y: number; height: number }>(undefined);
  const clampHeight = (value: number) => {
    const pane = drawer.current?.parentElement?.clientHeight ?? 0;
    return Math.round(
      Math.max(drawerMinPx, Math.min(value, pane - stageMinPx)),
    );
  };
  const resizeBy = (pixels: number) =>
    setHeight(
      clampHeight((height ?? drawer.current?.offsetHeight ?? 0) - pixels),
    );

  // Reads new lines once a second while open; closing stops the stream.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const poll = async () => {
      try {
        const since = first ? 0 : (latest.current.entries.at(-1)?.seq ?? 0);
        const batch = await read(since);
        if (stopped) return;
        first = false;
        setHeld((current) =>
          mergeLogs(current, batch.captureId, batch.entries),
        );
        setEnded(batch.ended);
        setFailed(undefined);
      } catch (error) {
        if (stopped) return;
        setFailed(error instanceof Error ? error.message : String(error));
      } finally {
        if (!stopped) {
          setLoading(false);
          timer = setTimeout(poll, logPollMs);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stop();
    };
  }, []);

  const shown = useMemo(
    () => filterLogs(held.entries, minLevel, query),
    [held.entries, minLevel, query],
  );
  const rows = shown.length > cap ? shown.slice(-cap) : shown;
  const older = shown.length - rows.length;
  const crash = useMemo(
    () => [...held.entries].reverse().find(isCrashEntry),
    [held.entries],
  );
  const shownCrash = crash && crash.seq > dismissedCrash ? crash : undefined;
  const goToCrash = (seq: number) => {
    setMinLevel("debug");
    setQuery("");
    const index = held.entries.findIndex((entry) => entry.seq === seq);
    if (index >= 0 && held.entries.length - index > cap)
      setCap(held.entries.length - index);
    setFollowing(false);
    requestAnimationFrame(() =>
      list.current
        ?.querySelector(`[data-seq="${seq}"]`)
        ?.scrollIntoView({ block: "center" }),
    );
  };
  const scopeChars = useMemo(
    () => scopeColumnChars(shown.map((entry) => logScope(entry))),
    [shown],
  );
  // The reference design.
  const [scopeWidth, setScopeWidth] = useState<number | null>(null);
  const [scopeDragging, setScopeDragging] = useState(false);
  const scopeColumn = useRef<HTMLSpanElement>(null);
  const scopeDrag = useRef<{ x: number; width: number; moved: boolean }>(
    undefined,
  );
  const scopeDirection = () =>
    drawer.current && getComputedStyle(drawer.current).direction === "rtl"
      ? -1
      : 1;
  const resizeScope = (pixels: number) =>
    setScopeWidth(
      clampScopeWidth(
        (scopeWidth ?? scopeColumn.current?.offsetWidth ?? 48) +
          pixels * scopeDirection(),
      ),
    );

  // Following: new lines keep the end in view.
  useLayoutEffect(() => {
    const element = list.current;
    if (element && following) element.scrollTop = element.scrollHeight;
  }, [rows, following]);
  const onScroll = () => {
    const element = list.current;
    if (!element) return;
    const end = element.scrollHeight - element.clientHeight;
    setFollowing(end - element.scrollTop <= followSlop);
  };
  const jump = () => {
    setFollowing(true);
    const element = list.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
      element.focus({ preventScroll: true });
    }
  };

  const levelText = logLevelName(minLevel, kind);
  const count =
    shown.length === held.entries.length
      ? held.entries.length === 1
        ? "1 line"
        : formatText("{count} lines", { count: held.entries.length })
      : formatText("{shown} of {total} lines", {
          shown: shown.length,
          total: held.entries.length,
        });
  const columns = {
    "--log-scope": scopeWidth === null ? `${scopeChars}ch` : `${scopeWidth}px`,
  } as CSSProperties;

  let body;
  if (!rows.length)
    body = (
      <div className="sim-logs-empty">
        {loading
          ? "Loading logs…"
          : failed
            ? failed
            : held.entries.length
              ? "No lines match the current filter."
              : "No log lines yet."}
      </div>
    );
  else
    body = (
      <div role="list">
        {rows.map((entry) => {
          const scope = logScope(entry);
          const full = logScopeFull(entry);
          return (
            <div
              key={entry.seq}
              role="listitem"
              data-seq={entry.seq}
              className="sim-log-row"
              data-log-level={entry.level}
            >
              <span className="sim-log-time" data-no-translate>
                {logTime(entry.ts)}
              </span>
              <span
                className="sim-log-level"
                aria-hidden="true"
                data-no-translate
              >
                {logLevelTag(entry.level, kind)}
              </span>
              <span className="sr-only">{logLevelName(entry.level, kind)}</span>
              {scope ? (
                <button
                  type="button"
                  className="sim-log-scope"
                  title={full}
                  aria-label={formatText("Filter by {scope}", { scope: full })}
                  onClick={() => setQuery(full)}
                >
                  <span data-no-translate>{scope}</span>
                </button>
              ) : (
                <span />
              )}
              <span className="sim-log-message" data-no-translate>
                {entry.message}
              </span>
            </div>
          );
        })}
      </div>
    );

  return (
    <section
      ref={drawer}
      className="sim-logs"
      aria-label="Simulator logs"
      style={
        height !== null && !fullHeight ? { flex: `0 0 ${height}px` } : undefined
      }
    >
      {!fullHeight && (
        <ResizeHandle
          label="Resize the logs drawer"
          orientation="horizontal"
          dragging={dragging}
          aria-valuetext={
            height === null
              ? "Two fifths of the pane"
              : formatText("{px} pixels", { px: height })
          }
          onStep={resizeBy}
          onActivate={() => setHeight(null)}
          onDoubleClick={() => setHeight(null)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              y: event.clientY,
              height: drawer.current?.offsetHeight ?? 0,
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start) return;
            setHeight(clampHeight(start.height - (event.clientY - start.y)));
          }}
          onPointerUp={() => {
            drag.current = undefined;
            setDragging(false);
          }}
          onPointerCancel={() => {
            drag.current = undefined;
            setDragging(false);
          }}
        />
      )}
      <div className="sim-logs-head">
        <button
          ref={levelButton}
          type="button"
          className="sim-logs-level"
          aria-label={formatText("Min level: {level}", { level: levelText })}
          aria-haspopup="menu"
          aria-expanded={levelMenu !== undefined}
          onClick={() =>
            setLevelMenu(levelMenu ? undefined : below(levelButton.current))
          }
        >
          {levelText}
        </button>
        <label className="sim-logs-filter">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="Filter"
            aria-label="Filter log lines"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
        </label>
        <span className="sim-logs-count">{count}</span>
        <IconButton
          label={fullHeight ? "Restore the drawer’s height" : "Full height"}
          className="sim-icon-button sim-logs-tool"
          active={fullHeight}
          onClick={onToggleFullHeight}
        >
          {fullHeight ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
        <IconButton
          label="Clear view"
          className="sim-icon-button sim-logs-tool"
          disabled={!held.entries.length}
          onClick={() => {
            setHeld((current) => ({ ...current, entries: [], dropped: 0 }));
            jump();
          }}
        >
          <Trash2 size={14} />
        </IconButton>
        <IconButton
          label="Close logs"
          className="sim-icon-button sim-logs-tool"
          onClick={onClose}
        >
          <X size={14} />
        </IconButton>
      </div>
      {shownCrash && (
        <div className="sim-logs-crash" role="alert">
          <span>
            {formatText(
              "{process} crashed at {time}. The crash report is in the log.",
              {
                process: shownCrash.process,
                time: logTime(shownCrash.ts),
              },
            )}
          </span>
          <button type="button" onClick={() => goToCrash(shownCrash.seq)}>
            Go to crash
          </button>
          <IconButton
            label="Dismiss"
            className="sim-icon-button sim-logs-tool"
            onClick={() => setDismissedCrash(shownCrash.seq)}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}
      {(ended || held.dropped > 0 || older > 0) && (
        <div className="sim-logs-note" role="status">
          {older > 0 && (
            <button
              type="button"
              className="sim-logs-older"
              onClick={() => {
                setCap((value) => value + drawnRows);
                list.current?.focus({ preventScroll: true });
              }}
            >
              Load older lines
            </button>
          )}
          {ended && <span>{ended}</span>}
          {held.dropped > 0 && (
            <span>
              {held.dropped === 1
                ? "1 older line dropped from this view"
                : formatText("{count} older lines dropped from this view", {
                    count: held.dropped,
                  })}
            </span>
          )}
        </div>
      )}
      <div className="sim-logs-columns" style={columns}>
        <span>Time</span>
        <span>Level</span>
        <span ref={scopeColumn} className="sim-logs-scope-column">
          <span>Scope</span>
          <ResizeHandle
            label="Resize the scope column"
            className="sim-logs-scope-resize"
            dragging={scopeDragging}
            aria-valuemin={48}
            aria-valuemax={640}
            aria-valuenow={scopeWidth ?? undefined}
            aria-valuetext={
              scopeWidth === null
                ? formatText("Fits the widest label")
                : undefined
            }
            onStep={resizeScope}
            onActivate={() => setScopeWidth(null)}
            onDoubleClick={() => setScopeWidth(null)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setScopeDragging(true);
              scopeDrag.current = {
                x: event.clientX,
                width: scopeColumn.current?.offsetWidth ?? 48,
                moved: false,
              };
            }}
            onPointerMove={(event) => {
              const start = scopeDrag.current;
              if (!start) return;
              if (Math.abs(event.clientX - start.x) > 3) start.moved = true;
              setScopeWidth(
                clampScopeWidth(
                  start.width + (event.clientX - start.x) * scopeDirection(),
                ),
              );
            }}
            onPointerUp={() => {
              const start = scopeDrag.current;
              if (start && !start.moved) setScopeWidth(null);
              scopeDrag.current = undefined;
              setScopeDragging(false);
            }}
            onPointerCancel={() => {
              scopeDrag.current = undefined;
              setScopeDragging(false);
              setScopeWidth(null);
            }}
          />
        </span>
        <span>Message</span>
      </div>
      <div className="sim-logs-frame">
        <div
          ref={list}
          className="sim-logs-list"
          role="log"
          tabIndex={0}
          aria-label="Log lines"
          aria-live="off"
          aria-busy={loading}
          style={columns}
          onScroll={onScroll}
        >
          {body}
        </div>
        {!following && rows.length > 0 && (
          <div className="sim-logs-jump">
            <button type="button" onClick={jump}>
              <ArrowDown size={14} aria-hidden="true" />
              Jump to latest
            </button>
          </div>
        )}
      </div>
      {levelMenu && (
        <Menu
          label="Min level"
          entries={[
            { heading: "Min level" },
            ...menuLogLevels.map((level) => ({
              label: logLevelName(level, kind),
              checked: level === minLevel,
              description:
                level === "default" && kind === "ios"
                  ? "The unified log’s normal level"
                  : undefined,
              onSelect: () => setMinLevel(level),
            })),
          ]}
          position={levelMenu}
          width={220}
          anchors={[levelButton]}
          onClose={() => setLevelMenu(undefined)}
        />
      )}
    </section>
  );
}
