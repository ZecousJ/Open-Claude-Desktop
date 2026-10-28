import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ResizeHandle } from "../ui/ResizeHandle";
import { DiscardDraftDialog } from "./DiscardDraftDialog";
import { SecondaryPane } from "./SecondaryPane";
import { setRowSplit, setWeights } from "./split-actions";
import {
  clampRowSplit,
  columnCount,
  columnTracks,
  columnWeights,
  hasBottom,
  hasTop,
  leastWeight,
  resizeColumns,
  rowSplitLimits,
  type PaneEntry,
} from "./split-layout";
import { splitState, useSplitState } from "./split-state";
import { hostWidth } from "./useSplitPanes";
import "./split-view.css";

/**
 * The split view's other panes. They are siblings of the primary pane in the
 * window's grid (the page's `.app`, which this turns into the pane host with
 * `data-split`): one track per column, sized by the columns' weights, and
 * two rows when a column has a pane below. Column overlays carry the
 * dividers: a drag changes two neighbouring columns' widths, and one row
 * divider moves the line between top and bottom panes in every column.
 */
export default function SplitPanes() {
  const { panes, focus, weights, rowSplit } = useSplitState();
  const anchor = useRef<HTMLDivElement>(null);
  const columns = columnCount(panes);
  const tracks = columnWeights(weights, columns);
  const stacked = (col: number) => hasTop(panes, col) && hasBottom(panes, col);
  const host = () => anchor.current?.closest<HTMLElement>(".app") ?? null;
  const stackKey = Array.from({ length: columns }, (_, col) =>
    stacked(col) ? 1 : 0,
  ).join("");

  useLayoutEffect(() => {
    const app = host();
    if (!app) return;
    app.dataset.split = "";
    return () => {
      delete app.dataset.split;
      delete app.dataset.splitCols;
      delete app.dataset.splitStack;
      app.style.removeProperty("--df-col-tracks");
      app.style.removeProperty("--df-pane-row");
    };
  }, []);
  useLayoutEffect(() => {
    const app = host();
    if (!app) return;
    app.dataset.splitCols = String(columns);
    if (stackKey[0] === "1") app.dataset.splitStack = "";
    else delete app.dataset.splitStack;
    app.style.setProperty("--df-col-tracks", columnTracks(tracks));
  }, [columns, stackKey, tracks.join(" ")]);
  // The divider keeps room for both rows when the window is short.
  useLayoutEffect(() => {
    const app = host();
    if (!app) return;
    const apply = () =>
      app.style.setProperty(
        "--df-pane-row",
        String(clampRowSplit(rowSplit, app.clientHeight)),
      );
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(app);
    return () => observer.disconnect();
  }, [rowSplit]);

  const placement = (entry: PaneEntry): CSSProperties => ({
    gridColumn: entry.pos.col + 2,
    gridRow: entry.pos.row === 1 ? 2 : stacked(entry.pos.col) ? "1" : "1 / -1",
  });
  return (
    <>
      <DiscardDraftDialog />
      {panes.map((entry, index) => (
        <SecondaryPane
          key={entry.key}
          entry={entry}
          focus={index + 1}
          focused={focus === index + 1}
          style={placement(entry)}
          captionClear={!(entry.pos.col === columns - 1 && entry.pos.row === 0)}
        />
      ))}
      {tracks.map((_, col) => (
        <div
          key={col}
          ref={col === 0 ? anchor : undefined}
          className="split-col"
          data-col={col}
          style={{ gridColumn: col + 2 }}
        >
          {col < columns - 1 && (
            <ColumnHandle index={col} weights={tracks} host={host} />
          )}
          {stacked(col) && <RowHandle value={rowSplit} host={host} />}
        </div>
      ))}
    </>
  );
}

/** The divider between column `index` and the next. */
function ColumnHandle({
  index,
  weights,
  host,
}: {
  index: number;
  weights: number[];
  host: () => HTMLElement | null;
}) {
  const drag = useRef<{
    x: number;
    base: number[];
    width: number;
    live: number[];
  }>(undefined);
  const [dragging, setDragging] = useState(false);
  /** The weights after the divider moved by `pixels` from `base`. */
  const moved = (base: number[], width: number, pixels: number) => {
    const total = base.reduce((sum, weight) => sum + weight, 0);
    return resizeColumns(
      base,
      index,
      (pixels * total) / width,
      leastWeight(width, total),
    );
  };
  const end = (event: { currentTarget: HTMLElement; pointerId: number }) => {
    const current = drag.current;
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (current && current.live.some((w, i) => w !== current.base[i]))
      setWeights(current.live);
  };
  const pair = weights[index] + weights[index + 1];
  return (
    <ResizeHandle
      className="split-col-resize"
      label="Resize pane columns"
      aria-valuenow={Math.round((100 * weights[index]) / pair)}
      dragging={dragging}
      // An arrow moves the divider 8px (32px with Shift).
      onStep={(pixels) => {
        const app = host();
        if (app) setWeights(moved(weights, hostWidth(app), pixels));
      }}
      onDoubleClick={() => setWeights(undefined)}
      onPointerDown={(event) => {
        const app = host();
        if (event.button !== 0 || !app) return;
        drag.current = {
          x: event.clientX,
          base: weights,
          width: hostWidth(app),
          live: weights,
        };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        const app = host();
        if (!current || !app) return;
        current.live = moved(
          current.base,
          current.width,
          event.clientX - current.x,
        );
        app.style.setProperty("--df-col-tracks", columnTracks(current.live));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        // Escape during a drag puts the widths back.
        const current = drag.current;
        if (event.key !== "Escape" || !current) return;
        event.preventDefault();
        event.stopPropagation();
        current.live = current.base;
        host()?.style.setProperty(
          "--df-col-tracks",
          columnTracks(current.base),
        );
        drag.current = undefined;
        setDragging(false);
      }}
    />
  );
}

/** The divider between the top and bottom panes. */
function RowHandle({
  value,
  host,
}: {
  value: number;
  host: () => HTMLElement | null;
}) {
  const drag = useRef<{
    y: number;
    base: number;
    height: number;
    live: number;
  }>(undefined);
  const [dragging, setDragging] = useState(false);
  const end = (event: { currentTarget: HTMLElement; pointerId: number }) => {
    const current = drag.current;
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (current && current.live !== current.base) setRowSplit(current.live);
  };
  return (
    <ResizeHandle
      className="split-row-resize"
      orientation="horizontal"
      label="Resize pane rows"
      aria-valuenow={Math.round(100 * value)}
      dragging={dragging}
      onStep={(pixels) => {
        const app = host();
        if (app)
          setRowSplit(
            clampRowSplit(value + pixels / app.clientHeight, app.clientHeight),
          );
      }}
      onDoubleClick={() => setRowSplit(rowSplitLimits.default)}
      onPointerDown={(event) => {
        const app = host();
        if (event.button !== 0 || !app) return;
        const height = app.clientHeight;
        const base = clampRowSplit(splitState().rowSplit, height);
        drag.current = { y: event.clientY, base, height, live: base };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        const app = host();
        if (!current || !app) return;
        current.live = clampRowSplit(
          current.base + (event.clientY - current.y) / current.height,
          current.height,
        );
        app.style.setProperty("--df-pane-row", String(current.live));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        const current = drag.current;
        if (event.key !== "Escape" || !current) return;
        event.preventDefault();
        event.stopPropagation();
        current.live = current.base;
        host()?.style.setProperty("--df-pane-row", String(current.base));
        drag.current = undefined;
        setDragging(false);
      }}
    />
  );
}
