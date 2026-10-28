import {
  useEffect,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { SidePanel } from "../conversation/ToolSidePanel";
import {
  BackgroundPanelResize,
  useStoredPanelWidth,
  type PanelWidthBounds,
} from "../conversation/BackgroundPanelResize";
import { ResizeHandle } from "../ui/ResizeHandle";
import { prefersReducedMotion } from "../ui/usePresence";
import type { DockPanel } from "./useToolPanels";
import { moveRowDivider, rowVariable } from "./tool-dock-rows";
import {
  dockCardClass as cardClass,
  dockPanelOf as panelOf,
} from "./pane-expand";
import "./tool-dock.css";
import { lazyPiece } from "../ui/lazy-piece";
import { reconcileDock, moveDockPane, type DockLayout } from "./dock-layout";
import { CodeWorkspaceContext } from "./CodeWorkspaceContext";

const PaneHeaderControls = lazyPiece(
  () => import("./PaneHeaderControls"),
  "PaneHeaderControls",
);
/** An expanded card's growth, and its siblings' collapse (tool-dock.css). */
const EXPAND_MS = 200;
const EXPAND_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const EXPANDED_CARD =
  ":scope > .work-panel.expanded, :scope > .tool-dock-column > .work-panel.expanded";

/**
 * The Code tool cards side by side: Background tasks, Changes and Browser stack
 * in one column, 10px apart; Terminal is a column of its own on the right. The
 * column's left edge drags like the Background rail (its width is kept per
 * account); the Terminal keeps its own edge. The dock's width is published to
 * the workspace as --tool-dock-width, so the conversation and its title bar
 * make room for it.
 *
 * With two or more cards it behaves like the original's split panes: the card
 * last pressed or focused is the focused one, the others dim (filter opacity
 * .75, saturate .85, 120ms) and show their header buttons only on hover; a card
 * opened later fades in (180ms); the divider between two stacked cards drags
 * their heights; and an expanded card grows over the conversation while the
 * others fold away (200ms), instead of jumping.
 */
export function ToolDock({
  panels,
  accountId,
  card,
}: {
  panels: DockPanel[];
  accountId: string | undefined;
  card: (panel: SidePanel) => ReactNode;
}) {
  const workspace = useContext(CodeWorkspaceContext);
  return workspace ? (
    <workspace.Tools panels={panels} card={card} />
  ) : (
    <LegacyToolDock panels={panels} accountId={accountId} card={card} />
  );
}

function LegacyToolDock({
  panels,
  accountId,
  card,
}: {
  panels: DockPanel[];
  accountId: string | undefined;
  card: (panel: SidePanel) => ReactNode;
}) {
  const [storedLayout, setLayout] = useState<DockLayout>([]);
  const layout = reconcileDock(storedLayout, panels);
  const column = layout[0] ?? [];
  const dock = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => setRoot(dock.current), []);
  const columnRef = useRef<HTMLDivElement>(null);
  // Changes, Browser and the simulators need room; Background tasks alone is
  // the 282px rail.
  const wide =
    column.some((pane) =>
      ["session", "pr", "widget", "artifact", "files"].includes(pane),
    ) ||
    column.includes("changes") ||
    column.includes("browser") ||
    column.includes("ios-simulator") ||
    column.includes("android-emulator");
  const bounds: PanelWidthBounds = {
    min: 260,
    initial: wide ? 537 : 282,
    max: 1000,
  };
  const { width, setWidth, persist } = useStoredPanelWidth(
    "tool-column",
    accountId,
    bounds,
  );
  // The dock's last box, so an expanded card can grow from where it was.
  const lastBox = useRef<DOMRect>(undefined);
  const publish = () => {
    const element = dock.current;
    if (!element) return;
    lastBox.current = element.getBoundingClientRect();
    element
      .closest<HTMLElement>(".workspace")
      ?.style.setProperty(
        "--tool-dock-width",
        `${Math.round(lastBox.current.width)}px`,
      );
  };
  // Measured after every render that can change it (the column's width,
  // the cards shown) and whenever the dock resizes (the Terminal's drag).
  useLayoutEffect(publish, [width, panels.join()]);
  useLayoutEffect(() => {
    const element = dock.current;
    const workspace = element?.closest<HTMLElement>(".workspace");
    if (!element || !workspace) return;
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      workspace.style.removeProperty("--tool-dock-width");
    };
  }, []);
  const [focused, focus] = useFocusedCard(panels);
  useExpandMotion(dock, panels, lastBox, publish);
  const rows = useRowWeights(columnRef, column);
  return (
    <div
      ref={dock}
      className="tool-dock"
      data-split={panels.length > 1 || undefined}
      data-focus={focused}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      {layout.map((group, columnIndex) =>
        group.length === 1 && group[0] === "terminal" ? (
          card("terminal")
        ) : (
          <div
            key={`column:${columnIndex}`}
            ref={columnIndex === 0 ? columnRef : undefined}
            className="tool-dock-column"
            data-wide={wide || undefined}
            style={{
              ...(width ? { width } : undefined),
              ...(columnIndex === 0 ? rows.style : {}),
            }}
          >
            {columnIndex === 0 && (
              <BackgroundPanelResize
                panel={columnRef}
                width={width}
                onResize={setWidth}
                persist={persist}
                label="Resize Chat and tool panels"
                bounds={bounds}
              />
            )}
            {group.map((panel, index) => [
              columnIndex === 0 && index > 0 && (
                <div key={`divider:${panel}`} className="tool-dock-row-divider">
                  <ResizeHandle
                    label="Resize tool panels"
                    orientation="horizontal"
                    dragging={rows.dragging === index - 1}
                    onStep={(pixels) => rows.move(index - 1, pixels)}
                    {...rows.drag(index - 1)}
                  />
                </div>
              ),
              card(panel),
            ])}
          </div>
        ),
      )}
      <Suspense fallback={null}>
        <PaneHeaderControls
          root={root}
          layout={layout}
          onMove={(pane, edge) => setLayout(moveDockPane(layout, pane, edge))}
        />
      </Suspense>
    </div>
  );
}

function cardElement(dock: HTMLElement | null, panel: DockPanel) {
  return dock?.querySelector<HTMLElement>(
    `:scope > .${cardClass[panel]}, :scope > .tool-dock-column > .${cardClass[panel]}`,
  );
}

/**
 * Which card is focused: the one last pressed or focused in, or else the
 * one opened last (the first that is left when it closes). The dock
 * carries it as `data-focus`, which the stylesheet reads, so a card that
 * mounts late is drawn right too.
 */
function useFocusedCard(panels: DockPanel[]) {
  const [state, setState] = useState<{
    focused?: DockPanel;
    seen: DockPanel[];
  }>(() => ({ focused: panels.at(-1), seen: panels }));
  let focused = state.focused;
  if (panels.join() !== state.seen.join()) {
    const opened = panels.filter((panel) => !state.seen.includes(panel));
    focused = opened.length
      ? opened.at(-1)
      : focused && panels.includes(focused)
        ? focused
        : panels[0];
    setState({ focused, seen: panels });
  }
  const focus = (event: { target: EventTarget }) => {
    const panel = panelOf(event.target as Element);
    if (panel && panel !== focused)
      setState((current) => ({ ...current, focused: panel }));
  };
  return [focused, focus] as const;
}

/**
 * An expanded card grows over the conversation from where the dock was
 * instead of jumping there, and shrinks back on Restore: the dock's left
 * edge moves over 200ms on the snap curve while the other cards fold away
 * (their transitions are in tool-dock.css) and, on Restore, unfold
 * (`data-restoring` on the dock, the card that was expanded marked
 * `data-was-expanded`, for 200ms). The cards keep their expanded state
 * themselves, so the dock watches their classes.
 */
function useExpandMotion(
  dock: React.RefObject<HTMLDivElement | null>,
  panels: DockPanel[],
  lastBox: React.RefObject<DOMRect | undefined>,
  publish: () => void,
) {
  const expanded = useRef<Element | null>(null);
  useEffect(() => {
    const element = dock.current;
    if (!element) return;
    expanded.current = element.querySelector(EXPANDED_CARD);
    const observer = new MutationObserver(() => {
      const card = element.querySelector(EXPANDED_CARD);
      if (Boolean(card) === Boolean(expanded.current)) return;
      const was = expanded.current;
      expanded.current = card;
      const before = lastBox.current;
      const parent = element.parentElement?.getBoundingClientRect();
      if (!before || !parent || prefersReducedMotion()) return publish();
      // Where the dock ends up, measured before the other cards start
      // unfolding from nothing.
      const after = element.getBoundingClientRect();
      if (!card && was) {
        // The other cards unfold back (tool-dock.css).
        element.setAttribute("data-restoring", "");
        was.setAttribute("data-was-expanded", "");
        setTimeout(() => {
          element.removeAttribute("data-restoring");
          was.removeAttribute("data-was-expanded");
        }, EXPAND_MS);
      }
      element.animate(
        [
          { left: `${before.left - parent.left}px`, maxWidth: "none" },
          { left: `${after.left - parent.left}px`, maxWidth: "none" },
        ],
        { duration: EXPAND_MS, easing: EXPAND_EASE },
      );
    });
    for (const panel of panels) {
      const card = cardElement(element, panel);
      if (card) observer.observe(card, { attributeFilter: ["class"] });
    }
    return () => observer.disconnect();
  });
}

/**
 * The stacked cards' heights, by weight: undefined (the stylesheet's
 * shares) until a divider is dragged, and back to it when the cards in the
 * column change.
 */
function useRowWeights(
  columnRef: React.RefObject<HTMLDivElement | null>,
  column: DockPanel[],
) {
  const key = column.join();
  const [weights, setWeights] = useState<{ key: string; values: number[] }>();
  const [dragging, setDragging] = useState<number>();
  const gesture = useRef<{ y: number; heights: number[]; index: number }>(
    undefined,
  );
  const heights = () =>
    column.map(
      (panel) =>
        cardElement(
          columnRef.current?.parentElement ?? null,
          panel,
        )?.getBoundingClientRect().height ?? 0,
    );
  const apply = (values: number[]) => setWeights({ key, values });
  const current = weights?.key === key ? weights.values : undefined;
  const style = Object.fromEntries(
    (current ?? []).map((value, i) => [
      rowVariable(column[i]),
      String(Math.round(value)),
    ]),
  ) as CSSProperties;
  return {
    style,
    dragging,
    move: (index: number, pixels: number) =>
      apply(moveRowDivider(heights(), index, pixels)),
    drag: (index: number) => ({
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { y: event.clientY, heights: heights(), index };
        setDragging(index);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const active = gesture.current;
        if (!active) return;
        apply(
          moveRowDivider(
            active.heights,
            active.index,
            event.clientY - active.y,
          ),
        );
      },
      onPointerUp: () => {
        gesture.current = undefined;
        setDragging(undefined);
      },
      onPointerCancel: () => {
        const active = gesture.current;
        gesture.current = undefined;
        setDragging(undefined);
        if (active) apply(active.heights);
      },
    }),
  };
}
