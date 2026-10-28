import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  defaultBackgroundPanelWidth,
  fitBackgroundPanelWidth,
  maximumBackgroundPanelWidth,
  minimumBackgroundPanelWidth,
  minimumConversationWidth,
} from "../../shared/background-panel-layout";
import { ResizeHandle } from "../ui/ResizeHandle";

/** The widths a resizable side card may take, before the layout clamps them. */
export type PanelWidthBounds = { min: number; initial: number; max: number };

const backgroundBounds: PanelWidthBounds = {
  min: minimumBackgroundPanelWidth,
  initial: defaultBackgroundPanelWidth,
  max: maximumBackgroundPanelWidth,
};

/**
 * The Code terminal card: 299px at rest. R-0887 (drag) was not captured, so the
 * stops reuse the Background rail's gesture with a narrower floor that still
 * fits the 34px header's controls.
 */
export const terminalPanelBounds: PanelWidthBounds = {
  min: 240,
  initial: 299,
  max: 720,
};

/**
 * Fits a card width to the layout the way fitBackgroundPanelWidth does for
 * the Background rail: the conversation keeps 260px, and the minimum only
 * contracts (to 220px at most) when the layout is very narrow.
 */
export function fitPanelWidth(
  width: number,
  layoutWidth: number,
  bounds: PanelWidthBounds = backgroundBounds,
) {
  if (bounds === backgroundBounds)
    return fitBackgroundPanelWidth(width, layoutWidth);
  const room = Math.floor(layoutWidth - minimumConversationWidth);
  const floor = Math.min(bounds.min, Math.max(220, room));
  const ceiling = Math.max(floor, Math.min(bounds.max, room));
  return Math.round(
    Math.max(floor, Math.min(ceiling, Number.isFinite(width) ? width : floor)),
  );
}

/**
 * A dragged card width kept per account under `claudex:<name>-width:<id>`;
 * undefined keeps the card's default width.
 */
export function useStoredPanelWidth(
  name: string,
  accountId: string | undefined,
  bounds: PanelWidthBounds,
) {
  const key = accountId && `claudex:${name}-width:${accountId}`;
  const [width, setWidth] = useState<number | undefined>(() => {
    if (!key) return;
    try {
      const stored = Number(localStorage.getItem(key));
      return Number.isInteger(stored) &&
        stored >= bounds.min &&
        stored <= bounds.max
        ? stored
        : undefined;
    } catch {
      return undefined;
    }
  });
  const persist = (value: number) => {
    if (!key) return;
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // The width then lasts only while the panel stays open.
    }
  };
  return { width, setWidth, persist };
}

/**
 * The Background tasks rail's width, shared by the task list and an Agent
 * transcript opened beside the conversation: undefined keeps the default 282px;
 * a width set by dragging is kept per account.
 */
export function useBackgroundPanelWidth(accountId?: string) {
  return useStoredPanelWidth("background", accountId, backgroundBounds);
}

/**
 * Publishes the rail's width to the workspace, where the panel card, the
 * conversation column and its title bar all read it (92-reference-panels.css).
 */
export function useRailWidth(
  panel: RefObject<HTMLElement | null>,
  width: number | undefined,
  property = "--background-panel-width",
) {
  useLayoutEffect(() => {
    const workspace = panel.current?.closest<HTMLElement>(".workspace");
    if (!workspace) return;
    if (width) workspace.style.setProperty(property, `${width}px`);
    else workspace.style.removeProperty(property);
    return () => {
      workspace.style.removeProperty(property);
    };
  }, [panel, width, property]);
}

type Gesture = {
  pointerId: number;
  initialX: number;
  initialWidth: number;
  currentWidth: number;
};
export function BackgroundPanelResize({
  panel,
  width,
  onResize,
  persist,
  label = "Resize Chat and Background tasks",
  bounds = backgroundBounds,
}: {
  panel: RefObject<HTMLElement | null>;
  width?: number;
  onResize: (width: number) => void;
  persist: (width: number) => void;
  /** The separator's accessible name; the terminal names its own card. */
  label?: string;
  /** Defaults to the Background rail's 260–620px, 282px at rest. */
  bounds?: PanelWidthBounds;
}) {
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | undefined>(undefined);
  const targetRef = useRef<HTMLDivElement | null>(null);
  const cancel = () => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = undefined;
    setDragging(false);
    onResize(current.initialWidth);
    const target = targetRef.current;
    if (target?.hasPointerCapture(current.pointerId))
      target.releasePointerCapture(current.pointerId);
  };
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        cancel();
      }
    };
    const blur = () => cancel();
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
    };
  }, [onResize]);
  // The room a card may take: its parent's width, or, inside the tool dock
  // (app/ToolDock.tsx), the conversation layout's width less the dock's
  // other columns.
  const parentWidth = () => {
    const element = panel.current;
    const dock = element?.closest(".tool-dock");
    const layout = element?.closest(".chat-layout");
    if (element && dock && layout)
      return (
        layout.getBoundingClientRect().width -
        (dock.getBoundingClientRect().width -
          element.getBoundingClientRect().width)
      );
    return (
      element?.parentElement?.getBoundingClientRect().width ??
      (typeof window === "undefined" ? 840 : window.innerWidth)
    );
  };
  const fit = (value: number) => fitPanelWidth(value, parentWidth(), bounds);
  const effective = fit(
    width ?? panel.current?.getBoundingClientRect().width ?? bounds.initial,
  );
  const move = (clientX: number) => {
    const current = gesture.current;
    if (!current) return;
    const next = fit(current.initialWidth + current.initialX - clientX);
    if (next !== current.currentWidth) {
      current.currentWidth = next;
      onResize(next);
    }
  };
  const end = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (commit) move(event.clientX);
    const target = event.currentTarget;
    gesture.current = undefined;
    targetRef.current = null;
    setDragging(false);
    if (target.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId);
    if (commit) persist(current.currentWidth);
    else onResize(current.initialWidth);
  };
  const commit = (next: number) => {
    const fitted = fit(next);
    onResize(fitted);
    persist(fitted);
  };
  // Home and End jump to the narrowest and widest card.
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    commit(event.key === "Home" ? bounds.min : bounds.max);
  };
  return (
    <ResizeHandle
      className="background-panel-resize"
      label={label}
      aria-valuemin={fit(0)}
      aria-valuemax={fit(bounds.max)}
      aria-valuenow={effective}
      dragging={dragging}
      // The card is on the right: moving the divider right narrows it.
      onStep={(pixels) => commit(effective - pixels)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const initialWidth =
          panel.current?.getBoundingClientRect().width ?? effective;
        gesture.current = {
          pointerId: event.pointerId,
          initialX: event.clientX,
          initialWidth,
          currentWidth: initialWidth,
        };
        targetRef.current = event.currentTarget;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (gesture.current?.pointerId === event.pointerId) move(event.clientX);
      }}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      onLostPointerCapture={(event) => {
        if (gesture.current?.pointerId === event.pointerId) end(event, false);
      }}
      onKeyDown={key}
    />
  );
}
