import { WithTooltip } from "../ui/Tooltip";
import { t } from "../i18n";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  defaultSidebarWidth,
  minimumSidebarWidth,
  maximumSidebarWidth,
  fitSidebarWidth,
  dragHidesSidebar,
} from "../../shared/sidebar-layout";

/**
 * The rail follows the pointer directly; only the released width is
 * persisted. Released under half the minimum width, the sidebar collapses
 * instead and keeps its width.
 */
export function SidebarResizeHandle({
  width,
  onPreview,
  onCommit,
  onHide,
}: {
  width: number;
  onPreview: (value: number | undefined) => void;
  onCommit: (value: number) => void;
  onHide?: () => void;
}) {
  const [viewport, setViewport] = useState(window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{
    pointerId: number;
    x: number;
    width: number;
    current: number;
    hidden: boolean;
  } | null>(null);
  const callbacks = useRef({
    move: (_x: number) => {},
    finish: (_x: number) => {},
    cancel: () => {},
  });
  const release = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    const move = (event: globalThis.MouseEvent) =>
      callbacks.current.move(event.clientX);
    const up = (event: globalThis.MouseEvent) =>
      callbacks.current.finish(event.clientX);
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && start.current) {
        event.preventDefault();
        callbacks.current.cancel();
      }
    };
    const blur = () => callbacks.current.cancel();
    window.addEventListener("resize", resize);
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const effective = fitSidebarWidth(width, viewport);
  const clear = () => {
    const captured = release.current,
      gesture = start.current;
    release.current = null;
    start.current = null;
    setDragging(false);
    onPreview(undefined);
    if (captured && gesture && captured.hasPointerCapture(gesture.pointerId))
      captured.releasePointerCapture(gesture.pointerId);
  };
  const cancel = () => {
    if (start.current) clear();
  };
  const move = (clientX: number) => {
    const gesture = start.current;
    if (!gesture) return;
    const raw = gesture.width + clientX - gesture.x;
    gesture.hidden = onHide !== undefined && dragHidesSidebar(raw);
    if (gesture.hidden) return;
    const next = fitSidebarWidth(raw, viewport);
    if (next !== gesture.current) {
      gesture.current = next;
      onPreview(next);
    }
  };
  const finish = (clientX: number) => {
    const gesture = start.current;
    if (!gesture) return;
    move(clientX);
    const final = gesture.current;
    const hidden = gesture.hidden;
    clear();
    if (hidden) onHide?.();
    else if (final !== gesture.width) onCommit(final);
  };
  callbacks.current = { move, finish, cancel };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    start.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: effective,
      current: effective,
      hidden: false,
    };
    release.current = event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "Home"
        ? minimumSidebarWidth
        : event.key === "End"
          ? maximumSidebarWidth
          : event.key === "ArrowLeft"
            ? effective - (event.shiftKey ? 20 : 10)
            : event.key === "ArrowRight"
              ? effective + (event.shiftKey ? 20 : 10)
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const fitted = fitSidebarWidth(next, viewport);
    if (fitted !== width) onCommit(fitted);
  };
  return (
    <WithTooltip
      label={t("Drag to resize")}
      placement="right"
      disabled={dragging}
    >
      {(tip) => (
        <div
          {...tip}
          className="sidebar-resize-handle"
          data-dragging={dragging}
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={minimumSidebarWidth}
          aria-valuemax={fitSidebarWidth(maximumSidebarWidth, viewport)}
          aria-valuenow={effective}
          tabIndex={0}
          onPointerDown={down}
          onPointerMove={(event) => {
            if (start.current?.pointerId === event.pointerId)
              move(event.clientX);
          }}
          onPointerUp={(event) => {
            if (start.current?.pointerId === event.pointerId)
              finish(event.clientX);
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={() => {
            if (start.current) cancel();
          }}
          onKeyDown={key}
          onDoubleClick={() => onCommit(defaultSidebarWidth)}
        />
      )}
    </WithTooltip>
  );
}
