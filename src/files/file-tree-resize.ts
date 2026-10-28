import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from "react";

/** O14/cf3dc7910:24–339, shared by Files and diff trees. */
export const fileTreeSize = {
  default: 240,
  min: 160,
  max: 640,
  editorMin: 160,
  hideBelow: 80,
} as const;
export const fileTreeMaximum = (paneWidth: number) =>
  Math.max(0, Math.min(fileTreeSize.max, paneWidth - fileTreeSize.editorMin));
export function normaliseFileTreeWidth(width: unknown) {
  return typeof width === "number" && Number.isFinite(width)
    ? Math.max(fileTreeSize.min, Math.min(fileTreeSize.max, Math.round(width)))
    : fileTreeSize.default;
}
export function boundedFileTreeWidth(width: number, paneWidth: number) {
  const max = fileTreeMaximum(paneWidth);
  return Math.min(max, Math.max(Math.min(fileTreeSize.min, max), width));
}
const eventName = "claudex-files-tree-width";
const memory = new Map<string, number>();
const keyFor = (account: string) =>
  `claudex.filesTree.width.v1.${encodeURIComponent(account)}`;
function readWidth(account: string) {
  if (memory.has(account)) return memory.get(account)!;
  try {
    const raw = window.localStorage.getItem(keyFor(account));
    return raw?.trim()
      ? normaliseFileTreeWidth(Number(raw))
      : fileTreeSize.default;
  } catch {
    return fileTreeSize.default;
  }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (
      event.key?.startsWith("claudex.filesTree.width.v1.") ||
      event.key === null
    ) {
      memory.clear();
      listener();
    }
  };
  window.addEventListener(eventName, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener("storage", storage);
  };
}
export function saveFileTreeWidth(account: string, width: number) {
  const value = normaliseFileTreeWidth(width);
  try {
    window.localStorage.setItem(keyFor(account), String(value));
    memory.delete(account);
  } catch {
    memory.set(account, value);
  }
  window.dispatchEvent(new window.Event(eventName));
}
type Drag = {
  pointerId: number;
  x: number;
  width: number;
  edge: boolean;
  raw: number;
  direction: number;
};

export function useFileTreeResize(
  account: string,
  shown: boolean,
  onShownChange: (shown: boolean) => void,
  /** The tree on the pane's right: dragging left widens it. */
  onRight = false,
) {
  const sign = () =>
    (document.documentElement.dir === "rtl" ? -1 : 1) * (onRight ? -1 : 1);
  const preferred = useSyncExternalStore(
    subscribe,
    () => readWidth(account),
    () => fileTreeSize.default,
  );
  const body = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState<number>(
    fileTreeSize.max + fileTreeSize.editorMin,
  );
  const [preview, setPreview] = useState<number>();
  const [edgeDrag, setEdgeDrag] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | undefined>(undefined);
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth > 0) setPaneWidth(node.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const width =
    preview === undefined
      ? boundedFileTreeWidth(preferred, paneWidth)
      : Math.max(0, Math.min(fileTreeMaximum(paneWidth), preview));
  const down = (event: PointerEvent<HTMLDivElement>, edge: boolean) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: edge ? 0 : width,
      edge,
      raw: edge ? 0 : width,
      direction: sign(),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    setEdgeDrag(edge);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || event.pointerId !== start.pointerId) return;
    start.raw = start.width + (event.clientX - start.x) * start.direction;
    setPreview(start.raw);
    if (start.edge && start.raw >= fileTreeSize.hideBelow) onShownChange(true);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const start = drag.current;
    if (!start || event.pointerId !== start.pointerId) return;
    drag.current = undefined;
    if (!cancel) {
      const click = Math.abs(event.clientX - start.x) < 2;
      if (start.edge && click) onShownChange(true);
      else if (start.raw < fileTreeSize.hideBelow || (!start.edge && click))
        onShownChange(false);
      else {
        saveFileTreeWidth(account, boundedFileTreeWidth(start.raw, paneWidth));
        onShownChange(true);
      }
    } else if (start.edge) onShownChange(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setPreview(undefined);
    setDragging(false);
    setEdgeDrag(false);
  };
  const props = (edge: boolean) => ({
    dragging,
    "aria-valuenow": edge && !shown ? 0 : width,
    "aria-valuemin":
      edge && !shown
        ? 0
        : Math.min(fileTreeSize.min, fileTreeMaximum(paneWidth)),
    "aria-valuemax": fileTreeMaximum(paneWidth),
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => down(e, edge),
    onPointerMove: move,
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => finish(e),
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => finish(e, true),
    onLostPointerCapture: (e: PointerEvent<HTMLDivElement>) => finish(e, true),
    onStep: (step: number) => {
      if (!shown) {
        onShownChange(true);
        return;
      }
      const direction = sign();
      saveFileTreeWidth(
        account,
        boundedFileTreeWidth(width + step * direction, paneWidth),
      );
    },
    onActivate: () => onShownChange(!shown),
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        onShownChange(true);
        saveFileTreeWidth(
          account,
          e.key === "Home"
            ? Math.min(fileTreeSize.min, fileTreeMaximum(paneWidth))
            : fileTreeMaximum(paneWidth),
        );
      }
    },
  });
  return { body, width, dragging, edgeDrag, props };
}
