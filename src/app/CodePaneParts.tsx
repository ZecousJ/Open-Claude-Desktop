import { createContext } from "react";
import { t } from "../i18n";

import type { Workspace } from "./CodeWorkspaceLayout";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  codePaneConfig,
  resizeCodeDivider,
  type CodeLayout,
  type CodeDivider,
} from "./code-pane-layout-model";
import { surface } from "../../shared/host";
import { PaneSideContext } from "./pane-side";
import { ResizeHandle } from "../ui/ResizeHandle";
import { formatText } from "../i18n";
import "./code-workspace-layout.css";

export function CodeTile({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const workspace = useContext(WorkspaceContext)!;
  const hidden = !!workspace.filled && workspace.filled !== id;
  const placed =
    workspace.filled === id
      ? {
          left: 9,
          top: 9,
          width: Math.max(0, workspace.width - 18),
          height: Math.max(0, workspace.height - 18),
        }
      : workspace.rects.get(id);
  // On the web the conversation's card reaches into the window's end when
  // nothing follows it, and gives way before a pane that does.
  const chatEnd =
    surface === "web" && id === "chat" && placed
      ? placed.left + placed.width >=
        workspace.width - codePaneConfig.padding - codePaneConfig.border - 1
        ? "bleed"
        : "shave"
      : undefined;
  const chatRect = workspace.rects.get("chat");
  const side =
    placed && chatRect && placed.left < chatRect.left ? "left" : "right";
  const rect =
    placed && chatEnd === "bleed"
      ? { ...placed, width: placed.width + codePaneConfig.padding }
      : placed;
  return (
    <div
      className="code-tile"
      data-code-tile={id}
      data-chat-end={chatEnd}
      data-top-left={
        (placed &&
          placed.left <= codePaneConfig.padding + codePaneConfig.border + 1 &&
          placed.top <= codePaneConfig.padding + codePaneConfig.border + 1) ||
        undefined
      }
      data-inactive={workspace.focused !== id || undefined}
      data-hidden={hidden || undefined}
      inert={hidden || undefined}
      style={
        (rect
          ? {
              ...rect,
              // The conversation's bar fits what shows of the tile while its
              // column runs on at 320px (code-workspace-layout.css).
              "--tile-width": `${rect.width}px`,
              visibility: hidden ? "hidden" : undefined,
              ...(workspace.moving?.id === id
                ? {
                    transform: `translate3d(${workspace.moving.x}px,${workspace.moving.y}px,24px)`,
                    zIndex: 30,
                  }
                : undefined),
            }
          : { visibility: "hidden" }) as CSSProperties
      }
      onPointerDownCapture={() => workspace.focus(id)}
      onFocusCapture={() => workspace.focus(id)}
    >
      <PaneSideContext.Provider value={side}>
        {children}
      </PaneSideContext.Provider>
    </div>
  );
}

export function CodePaneDivider({ divider }: { divider: CodeDivider }) {
  const workspace = useContext(WorkspaceContext)!;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<
    | {
        pointer: number;
        coordinate: number;
        layout: CodeLayout;
        divider: CodeDivider;
      }
    | undefined
  >(undefined);
  const vertical = divider.direction === "row";
  const coordinate = (event: ReactPointerEvent) =>
    vertical ? event.clientX : event.clientY;
  const resize = (pixels: number) =>
    workspace.change((layout) => resizeCodeDivider(layout, divider, pixels));
  const equal = () =>
    resize(
      ((divider.weights[divider.index + 1] - divider.weights[divider.index]) /
        2 /
        divider.weights.reduce((a, b) => a + b, 0)) *
        divider.available,
    );
  const end = (event: ReactPointerEvent) => {
    if (!drag.current || event.pointerId !== drag.current.pointer) return;
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent) => {
    const initial = drag.current;
    if (!initial || event.pointerId !== initial.pointer) return;
    const pixels = coordinate(event) - initial.coordinate;
    workspace.change(() =>
      resizeCodeDivider(
        initial.layout,
        initial.divider,
        vertical && document.documentElement.dir === "rtl" ? -pixels : pixels,
      ),
    );
  };
  const cancel = () => {
    const initial = drag.current;
    if (!initial) return;
    drag.current = undefined;
    workspace.change(() => initial.layout);
    setDragging(false);
  };
  const pointerHandlers = useRef({ move, end, cancel });
  pointerHandlers.current = { move, end, cancel };
  useEffect(() => {
    const move = (event: PointerEvent) =>
      pointerHandlers.current.move(event as unknown as ReactPointerEvent);
    const end = (event: PointerEvent) =>
      pointerHandlers.current.end(event as unknown as ReactPointerEvent);
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === drag.current?.pointer)
        pointerHandlers.current.cancel();
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        drag.current
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pointerHandlers.current.cancel();
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
  return (
    <ResizeHandle
      className="code-pane-divider"
      label={formatText("Resize {left} and {right}", {
        left: divider.before.map(codePaneName).join(", "),
        right: divider.after.map(codePaneName).join(", "),
      })}
      style={divider.rect}
      orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={divider.min}
      aria-valuemax={divider.max}
      aria-valuenow={divider.value}
      dragging={dragging}
      onStep={(pixels) =>
        resize(
          vertical && document.documentElement.dir === "rtl" ? -pixels : pixels,
        )
      }
      onActivate={equal}
      onDoubleClick={equal}
      onKeyDown={(event) => {
        if (
          (event.key === "Home" || event.key === "End") &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          resize(event.key === "Home" ? -Infinity : Infinity);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = {
          pointer: event.pointerId,
          coordinate: coordinate(event),
          layout: workspace.layout,
          divider,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancel}
    />
  );
}

export const WorkspaceContext = createContext<Workspace | null>(null);

export const codePaneName = (id: string) => t(names[id] ?? id);

export const names: Record<string, string> = {
  chat: "Chat",
  files: "Files",
  changes: "Changes",
  terminal: "Terminal",
  browser: "Browser",
  background: "Background tasks",
  runs: "Runs",
  session: "Session",
  pr: "Pull request",
  widget: "Widget",
  plan: "Plan",
  agent: "Agent",
  artifact: "Artifact",
  "ios-simulator": "iOS Simulator",
  "android-emulator": "Android Emulator",
};
