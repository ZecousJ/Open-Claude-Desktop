import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEventHandler,
  type KeyboardEventHandler,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useApp } from "./AppContext";
import { CodeWorkspaceContext } from "./CodeWorkspaceContext";
import { dockPanels, type DockPanel } from "./useToolPanels";
import type { SidePanel } from "../conversation/ToolSidePanel";
import { arrangePane } from "./pane-expand";
import {
  codeTileIds,
  applyCodeDrop,
  codeTilePath,
  moveCodeTileToEdge,
  resolveCodeLayout,
  type CodeLayout,
  type CodeEdge,
  type CodeRect,
  type CodeDrop,
} from "./code-pane-layout-model";
import {
  codePaneStateKey,
  readCodePaneState,
  reconcileCodePaneState,
  type CodePaneState,
} from "./code-pane-state";
import { NativePaneControls, PaneMoveButton } from "./NativePaneControls";
import "./code-workspace-layout.css";
import {
  codeDragSnapshot,
  codeDragResult,
  codeDropIndicator,
  type CodeDragSnapshot,
} from "./code-pane-drag";
import { CodeTile, CodePaneDivider } from "./CodePaneParts";
import { WorkspaceContext } from "./CodePaneParts";

export type Workspace = {
  root: HTMLDivElement | null;
  layout: CodeLayout;
  rects: Map<string, CodeRect>;
  width: number;
  height: number;
  filled?: string;
  focused: string;
  moving?: { id: string; x: number; y: number };
  focus: (id: string) => void;
  register: (ids: readonly DockPanel[]) => void;
  change: (fn: (layout: CodeLayout) => CodeLayout) => void;
  move: (id: string, edge: CodeEdge) => void;
  drag: (id: string) => {
    onPointerDown: PointerEventHandler<HTMLButtonElement>;
    onPointerMove: PointerEventHandler<HTMLButtonElement>;
    onPointerUp: PointerEventHandler<HTMLButtonElement>;
    onPointerCancel: PointerEventHandler<HTMLButtonElement>;
    onLostPointerCapture: PointerEventHandler<HTMLButtonElement>;
    onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  };
};
const bridge = { Tools: CodeToolTiles };

/** Native tiles include Chat. The tree contains geometry only: stable leaf hosts
 * retain CodeMirror, selection, iframes and dirty documents when a pane moves.
 * Reference: ca67f2c9d contentHosts; c03935b01 opening; cf53e1812 tree/weights. */
export function CodeWorkspaceLayout({
  header,
  main,
  panels,
}: {
  header: ReactNode;
  main: ReactNode;
  panels: ReactNode;
}) {
  const app = useApp();
  const key = codePaneStateKey(
    app.accountId ?? "local",
    app.active?.id ?? "draft",
  );
  const [saved, setSaved] = useState<{ key: string; value: CodePaneState }>(
    () => ({ key, value: readCodePaneState(localStorage, key, dockPanels) }),
  );
  let current = saved;
  if (current.key !== key) {
    current = { key, value: readCodePaneState(localStorage, key, dockPanels) };
    setSaved(current);
  }
  const latest = useRef(current);
  latest.current = current;
  const write = (fn: (state: CodePaneState) => CodePaneState) => {
    const value = fn(latest.current.value);
    if (value === latest.current.value) return;
    const next = { key: latest.current.key, value };
    latest.current = next;
    setSaved(next);
  };
  useEffect(() => {
    try {
      localStorage.setItem(current.key, JSON.stringify(current.value));
    } catch {
      /* Layout remains usable when storage is unavailable. */
    }
  }, [current]);
  const root = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    setElement(node);
    const measure = () =>
      setSize((previous) =>
        previous.width === node.clientWidth &&
        previous.height === node.clientHeight
          ? previous
          : { width: node.clientWidth, height: node.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const [focused, focus] = useState("chat");
  const [filled, setFilled] = useState<string>();
  // Existing cards own Expand and its keyboard shortcut. Observe the result,
  // and tile every host with the same geometry without remounting any of them.
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const update = () => {
      const id = [
        ...node.querySelectorAll<HTMLElement>("[data-code-tile]"),
      ].find((tile) =>
        tile.querySelector(
          ":scope > .work-panel.expanded, :scope > .file-viewer[data-expanded=true]",
        ),
      )?.dataset.codeTile;
      setFilled(id);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(node, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "data-expanded"],
    });
    return () => observer.disconnect();
  }, []);
  // An open artifact or file shows as its own tile without being in the dock
  // (ToolPanelHost adds it), so it counts as shown here too: when it closes,
  // its tile gives its room back.
  const dock = app.toolPanels.dock;
  const visible = useMemo(
    () =>
      app.artifact && !dock.includes("artifact")
        ? [...dock, "artifact" as DockPanel]
        : dock,
    [dock, Boolean(app.artifact)],
  );
  const hydrated = useRef<{ key: string; pending: boolean } | undefined>(
    undefined,
  );
  // RightPanels unmounts after the final close; its lazy host has no remaining
  // registration effect. Reconcile that empty state here as well.
  useLayoutEffect(() => {
    if (hydrated.current?.key !== key) {
      const restorable = new Set([
        "files",
        "changes",
        "terminal",
        "browser",
        "background",
        "runs",
        "plan",
      ]);
      const wanted = codeTileIds(latest.current.value.layout.root).filter(
        (id) => restorable.has(id),
      ) as DockPanel[];
      const pending =
        !visible.length &&
        !!wanted.length &&
        typeof app.toolPanels.setPanel === "function";
      hydrated.current = { key, pending };
      // Transient agent/widget/artifact panes require their real payload first.
      if (pending) {
        for (const pane of wanted) app.toolPanels.setPanel(pane);
        return;
      }
    }
    if (visible.length) hydrated.current!.pending = false;
    if (hydrated.current!.pending) return;
    if (!visible.length) write((value) => reconcileCodePaneState(value, []));
  }, [visible.join(), key]);
  const layout = current.value.layout;
  const geometry = useMemo(
    () => resolveCodeLayout(layout, size.width, size.height),
    [layout, size],
  );
  const change: Workspace["change"] = (fn) =>
    write((value) => ({ ...value, layout: fn(value.layout) }));
  const dragRef = useRef<
    | {
        pointer: number;
        layout: CodeLayout;
        snapshot: CodeDragSnapshot;
        pending?: CodeLayout;
      }
    | undefined
  >(undefined);
  const [dragFeedback, setDragFeedback] = useState<{
    id: string;
    rect?: CodeRect;
  }>();
  const [moving, setMoving] = useState<Workspace["moving"]>();
  const keyDrop = useRef<{ id: string; target: CodeDrop } | undefined>(
    undefined,
  );
  const resetDrag = () => {
    dragRef.current = undefined;
    keyDrop.current = undefined;
    setDragFeedback(undefined);
    setMoving(undefined);
  };
  useEffect(() => resetDrag(), [key]);
  const drag: Workspace["drag"] = (id) => ({
    onPointerDown: (event) => {
      if (event.button !== 0 || dragRef.current || !root.current) return;
      const box = root.current.getBoundingClientRect(),
        start = { x: event.clientX - box.left, y: event.clientY - box.top };
      const snapshot = codeDragSnapshot(layout, geometry.rects, id, start);
      if (!snapshot) return;
      event.preventDefault();
      event.currentTarget.focus();
      dragRef.current = { pointer: event.pointerId, layout, snapshot };
      keyDrop.current = undefined;
      setDragFeedback(undefined);
      setMoving({ id, x: 0, y: 0 });
      focus(id);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event) => {
      const active = dragRef.current;
      if (!active || active.pointer !== event.pointerId || !root.current)
        return;
      const box = root.current.getBoundingClientRect();
      setMoving({
        id,
        x: event.clientX - box.left - active.snapshot.start.x,
        y: event.clientY - box.top - active.snapshot.start.y,
      });
      const result = codeDragResult(active.layout, active.snapshot, {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
      active.pending = result.layout;
      setDragFeedback(
        result.layout
          ? {
              id,
              rect:
                result.target &&
                codeDropIndicator(
                  active.layout,
                  active.snapshot.rects,
                  result.target,
                ),
            }
          : undefined,
      );
    },
    onPointerUp: (event) => {
      const active = dragRef.current;
      if (!active || active.pointer !== event.pointerId) return;
      if (active.pending) change(() => active.pending!);
      resetDrag();
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: () => resetDrag(),
    // Native titlebar regions can release element capture while the window
    // continues receiving pointer events. Source listens on the window.
    onLostPointerCapture: () => {},
    onKeyDown: (event) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.nativeEvent.isComposing
      )
        return;
      if (["Enter", " ", "Escape"].includes(event.key)) {
        if (!keyDrop.current || keyDrop.current.id !== id) return;
        event.preventDefault();
        if (event.key !== "Escape")
          change((layout) =>
            applyCodeDrop(layout, id, keyDrop.current!.target),
          );
        resetDrag();
        return;
      }
      if (
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(event.key)
      )
        return;
      event.preventDefault();
      const path = codeTilePath(layout.root, id);
      if (!path?.length) return;
      let parent = layout.root;
      for (const at of path.slice(0, -1)) {
        const child = parent.children[at];
        if (child.kind !== "stack") return;
        parent = child;
      }
      const row = parent.direction === "row",
        rtl = document.documentElement.dir === "rtl";
      const perpendicular = row
        ? event.key === "ArrowUp"
          ? 0
          : event.key === "ArrowDown"
            ? 1
            : undefined
        : event.key === "ArrowLeft"
          ? +rtl
          : event.key === "ArrowRight"
            ? +!rtl
            : undefined;
      if (perpendicular !== undefined) {
        const target: CodeDrop = {
          kind: "split",
          stackId: parent.id,
          direction: row ? "column" : "row",
          index: perpendicular,
        };
        keyDrop.current = { id, target };
        setDragFeedback({
          id,
          rect: codeDropIndicator(layout, geometry.rects, target),
        });
        return;
      }
      const at = path.at(-1)!,
        last = parent.children.length - 1;
      const delta =
        event.key === "ArrowLeft"
          ? rtl
            ? 1
            : -1
          : event.key === "ArrowRight"
            ? rtl
              ? -1
              : 1
            : event.key === "ArrowUp"
              ? -1
              : 1;
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : Math.max(0, Math.min(last, at + delta));
      resetDrag();
      if (index !== at)
        change((layout) =>
          applyCodeDrop(layout, id, {
            kind: "insert",
            stackId: parent.id,
            index,
          }),
        );
    },
  });
  const windowDrag = useRef(drag);
  windowDrag.current = drag;
  const cancelDrag = useRef(resetDrag);
  cancelDrag.current = resetDrag;
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = dragRef.current;
      if (active)
        windowDrag
          .current(active.snapshot.id)
          .onPointerMove(
            event as unknown as ReactPointerEvent<HTMLButtonElement>,
          );
    };
    const end = (event: PointerEvent) => {
      const active = dragRef.current;
      if (active)
        windowDrag
          .current(active.snapshot.id)
          .onPointerUp(
            event as unknown as ReactPointerEvent<HTMLButtonElement>,
          );
    };
    const cancel = (event: PointerEvent) => {
      if (dragRef.current?.pointer === event.pointerId) cancelDrag.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.isComposing &&
        !event.defaultPrevented &&
        dragRef.current
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelDrag.current();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
    };
  }, []);
  const value: Workspace = {
    root: element,
    layout,
    rects: geometry.rects,
    ...size,
    filled,
    focused,
    moving,
    focus,
    register: (ids) => {
      if (!ids.length && !visible.length) return;
      const previous = codeTileIds(latest.current.value.layout.root);
      const opened = ids.filter((id) => !previous.includes(id));
      write((value) => reconcileCodePaneState(value, ids));
      if (opened.length) focus(opened.at(-1)!);
      else if (focused !== "chat" && !ids.includes(focused as DockPanel))
        focus(ids.at(-1) ?? "chat");
    },
    change,
    drag,
    move: (id, edge) => {
      if (id !== "chat") arrangePane(id as DockPanel, false);
      change((layout) => moveCodeTileToEdge(layout, id, edge));
      focus(id);
    },
  };
  const solo = codeTileIds(layout.root).length === 1;
  return (
    <CodeWorkspaceContext.Provider value={bridge}>
      <WorkspaceContext.Provider value={value}>
        <div
          ref={root}
          className="code-workspace-layout"
          data-solo={solo || undefined}
          data-focus={focused}
          data-dragging={moving?.id}
        >
          <CodeTile id="chat">
            <div className="code-chat-content">
              {header}
              {main}
            </div>
            {!solo && <PaneMoveButton {...drag("chat")} />}
          </CodeTile>
          {panels}
          {!filled &&
            geometry.dividers.map((divider) => (
              <CodePaneDivider
                key={`${divider.stackId}:${divider.index}`}
                divider={divider}
              />
            ))}
          {dragFeedback?.rect && (
            <div
              className="code-drop-feedback"
              aria-hidden="true"
              style={dragFeedback.rect}
            />
          )}
        </div>
      </WorkspaceContext.Provider>
    </CodeWorkspaceContext.Provider>
  );
}

function CodeToolTiles({
  panels,
  card,
}: {
  panels: DockPanel[];
  card: (panel: SidePanel) => ReactNode;
}) {
  const workspace = useContext(WorkspaceContext)!;
  const ids = panels.join();
  useLayoutEffect(
    () => workspace.register(panels),
    [ids, workspace.root, workspace.layout],
  );
  return (
    <>
      {panels.map((pane) => (
        <CodeTile key={pane} id={pane}>
          {card(pane)}
          <NativePaneControls
            pane={pane}
            root={workspace.root}
            layout={workspace.layout}
            filled={workspace.filled === pane}
            onMove={(edge) => workspace.move(pane, edge)}
            moveHandlers={workspace.drag(pane)}
          />
        </CodeTile>
      ))}
    </>
  );
}
