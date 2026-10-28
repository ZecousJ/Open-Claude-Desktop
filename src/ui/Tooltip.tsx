import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  tooltipOrigin,
  tooltipPosition,
  tooltipSide,
  type TooltipPlacement,
} from "./tooltip-position";
import {
  TOOLTIP_MOTION_MS,
  claim,
  createTooltipGroup,
  isWarm,
  release,
  type TooltipGroupState,
  type TooltipHandle,
} from "./tooltip-group";
import { usePresence } from "./usePresence";
import { surface } from "../../shared/host";

/**
 * The web app shows no keyboard shortcuts in its menus and hints; its tooltips
 * do, as the original's.
 */
export const showsShortcuts = surface !== "web";

/** The window's platform, so shortcuts read ⌘ on macOS and Ctrl elsewhere. */
export const ShortcutPlatform = createContext("darwin");

const macKeys: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  ctrl: "⌃",
};
const otherKeys: Record<string, string> = {
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  ctrl: "Ctrl",
};
export const keyName = (platform: string, key: string) =>
  (platform === "darwin" ? macKeys : otherKeys)[key] ?? key;

// Windows and Linux write a combination as words in the system's order, joined
// with "+": Ctrl+Shift+I, Ctrl+N.
const otherOrder = ["mod", "ctrl", "alt", "shift"];

/**
 * A shortcut's keys as the platform writes them: macOS keeps the glyphs one
 * by one in the order given; elsewhere they become "Ctrl+Alt+Shift+K" in
 * one piece.
 */
export function shortcutParts(platform: string, keys: string[]): string[] {
  if (platform === "darwin") return keys.map((key) => keyName(platform, key));
  const modifiers = keys
    .filter((key) => otherOrder.includes(key))
    .sort((a, b) => otherOrder.indexOf(a) - otherOrder.indexOf(b));
  const rest = keys.filter((key) => !otherOrder.includes(key));
  return [
    [...modifiers.map((key) => keyName(platform, key)), ...rest].join("+"),
  ];
}

/**
 * The tooltips' shared timing: 300ms of held hover before one shows, 200ms
 * after the pointer leaves, one at a time, the next shown at once while one
 * is up (src/ui/tooltip-group.ts). The whole window is one group unless a
 * TooltipGroup gives a part of it its own.
 */
const TooltipGroupContext =
  createContext<TooltipGroupState>(createTooltipGroup());

/** Gives its children their own tooltip group, optionally with other delays. */
export function TooltipGroup({
  delay,
  closeDelay,
  children,
}: {
  delay?: number;
  closeDelay?: number;
  children: ReactNode;
}) {
  const [group] = useState(() => createTooltipGroup(delay, closeDelay));
  return (
    <TooltipGroupContext.Provider value={group}>
      {children}
    </TooltipGroupContext.Provider>
  );
}

type Options = {
  /** Source path tooltips allow480px; ordinary chrome keeps240px. */
  maxWidth?: number;
  content?: ReactNode;
  shortcut?: string[];
  placement?: TooltipPlacement;
  /** Distance from the anchor; the original's 4 by default. */
  gap?: number;
  /**
   * "wrap" lets a longer explanation (a disabled item's reason) run to
   * several lines; the default is one line. Both stop at 240px.
   */
  size?: "line" | "wrap";
  /** Tooltips of a disabled button stay hidden. */
  disabled?: boolean;
  /**
   * A second, smaller line under the label: the Code home's working-directory
   * chip shows its path there, cut at the front when it is long.
   */
  detail?: string;
};

/** The tail of a long path behind an ellipsis, as the working-directory tooltip writes it. */
export const pathTail = (path: string, keep = 37) =>
  path.length > keep + 1 ? `…${path.slice(-keep)}` : path;

/**
 * A delayed tooltip for an icon button: pass the returned props to the button
 * and render `tooltip` next to it. It is drawn in a portal so the sidebar's
 * overflow does not clip it, and replaces the native `title`.
 *
 * As the original's Tooltip: it fades in and grows from 98% over 120ms on the
 * snap curve, from the side facing its button, and leaves the same way; one
 * shown at once while another is up skips the motion. The pointer may move onto
 * it without closing it, and scrolling anything that holds the button closes
 * it.
 */
export function useTooltip(
  label: string,
  {
    shortcut,
    placement = "below",
    gap,
    size = "line",
    disabled,
    detail,
    content,
    maxWidth,
  }: Options = {},
) {
  const group = useContext(TooltipGroupContext);
  const [shown, setShown] = useState<{
    left: number;
    top: number;
    transformOrigin: string;
  }>();
  const [anchor, setAnchor] = useState<HTMLElement>();
  // Shown or hidden at once, without the fade (within a warm group).
  const [instant, setInstant] = useState(false);
  const { mounted, state } = usePresence(
    Boolean(anchor),
    instant ? 0 : TOOLTIP_MOTION_MS,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bubble = useRef<HTMLSpanElement>(null);
  const handle = useRef<TooltipHandle>({ closeInstant: () => {} });
  const id = useId();
  const platform = useContext(ShortcutPlatform);
  function hide(now = false) {
    clearTimeout(timer.current);
    release(group, handle.current, Date.now());
    setInstant(now);
    setAnchor(undefined);
  }
  handle.current.closeInstant = () => hide(true);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      release(group, handle.current, Date.now());
    },
    [],
  );
  useEffect(() => {
    if (disabled) hide(true);
  }, [disabled]);
  // Gone: the next opening measures afresh.
  useEffect(() => {
    if (!mounted) setShown(undefined);
  }, [mounted]);
  // Measure the bubble before it paints (which also fixes its starting
  // style), then place it against the anchor.
  useLayoutEffect(() => {
    if (!anchor || !bubble.current) return;
    const box = anchor.getBoundingClientRect();
    const rect = bubble.current.getBoundingClientRect();
    // The entry motion scales the visual rect to98%; position the full layout
    // box so its final edge still sits the source's4px from the trigger.
    const css = bubble.current.ownerDocument.defaultView?.getComputedStyle?.(
      bubble.current,
    );
    const size = {
      width: Number.parseFloat(css?.width ?? "") || rect.width,
      height: Number.parseFloat(css?.height ?? "") || rect.height,
    };
    const view = { width: innerWidth, height: innerHeight };
    const at = tooltipPosition(box, size, view, placement, gap);
    setShown({
      ...at,
      transformOrigin: tooltipOrigin(
        box,
        at,
        size,
        tooltipSide(box, size, view, placement, gap),
      ),
    });
  }, [anchor, placement, gap, label, maxWidth]);
  // Scrolling the button away leaves no tooltip behind.
  useEffect(() => {
    if (!anchor) return;
    const scroll = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(anchor))
        hide(true);
    };
    document.addEventListener("scroll", scroll, true);
    return () => document.removeEventListener("scroll", scroll, true);
  }, [anchor]);
  const open = (element: HTMLElement, immediate: boolean) => {
    clearTimeout(timer.current);
    if (disabled || element === anchor) return;
    const show = () => {
      const warm = isWarm(group, Date.now());
      claim(group, handle.current);
      setInstant(warm);
      setAnchor(element);
    };
    if (immediate || isWarm(group, Date.now())) show();
    else timer.current = setTimeout(show, group.delay);
  };
  const leave = () => {
    clearTimeout(timer.current);
    if (anchor) timer.current = setTimeout(() => hide(), group.closeDelay);
  };
  const props = {
    "aria-describedby": anchor ? id : undefined,
    onPointerEnter: (event: { currentTarget: HTMLElement }) =>
      open(event.currentTarget, false),
    onPointerLeave: leave,
    // Keyboard focus shows it at once; a click's focus does not.
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(":focus-visible"))
        open(event.currentTarget, true);
    },
    onBlur: () => hide(),
    onPointerDown: () => hide(),
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Escape") hide();
    },
  };
  const tooltip: ReactNode =
    mounted &&
    createPortal(
      <span
        ref={bubble}
        id={id}
        role="tooltip"
        className={`chrome-tooltip ${size === "wrap" ? "wrap" : ""} ${detail ? "detail" : ""}`}
        data-open={Boolean(shown) && state === "open"}
        data-state={state}
        data-instant={instant || undefined}
        style={{
          ...(shown ?? { left: 0, top: 0 }),
          maxWidth:
            maxWidth === undefined
              ? undefined
              : `min(${maxWidth}px, calc(100vw - 16px))`,
        }}
        // Hoverable: the pointer may rest on the tooltip itself.
        onPointerEnter={() => clearTimeout(timer.current)}
        onPointerLeave={leave}
      >
        {content ??
          (detail ? (
            <span className="chrome-tooltip-title">{label}</span>
          ) : (
            label
          ))}
        {detail && <span className="chrome-tooltip-detail">{detail}</span>}
        {shortcut && (
          <span className="chrome-tooltip-keys">
            {shortcutParts(platform, shortcut).map((key) => (
              <kbd key={key}>{key}</kbd>
            ))}
          </span>
        )}
      </span>,
      document.body,
    );
  return { props, tooltip };
}

/**
 * A shortcut written inside a menu row: "⌘ U" with a space on macOS, "Ctrl+U"
 * elsewhere.
 */
export function shortcutText(platform: string, keys: string[]): string {
  return shortcutParts(platform, keys).join(platform === "darwin" ? " " : "");
}

/** A multi-line tooltip's content: each row its words and its own keys. */
export function TooltipRows({
  platform,
  rows,
}: {
  platform: string;
  rows: { label: string; keys?: string[] }[];
}) {
  return (
    <span className="chrome-tooltip-rows">
      {rows.map((row) => (
        <span key={row.label} className="chrome-tooltip-row">
          {row.label}
          {row.keys && showsShortcuts && (
            <span className="chrome-tooltip-keys">
              {shortcutParts(platform, row.keys).map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/** Wraps a single icon button with a tooltip; the button keeps its own markup. */
export function WithTooltip({
  label,
  shortcut,
  placement,
  gap,
  size,
  disabled,
  detail,
  content,
  maxWidth,
  children,
}: Options & {
  label: string;
  children: (props: ReturnType<typeof useTooltip>["props"]) => ReactNode;
}) {
  const { props, tooltip } = useTooltip(label, {
    shortcut,
    placement,
    gap,
    size,
    disabled,
    detail,
    content,
    maxWidth,
  });
  return (
    <>
      {children(props)}
      {tooltip}
    </>
  );
}

/**
 * Why a disabled menu item or list option cannot be used, as the original shows
 * it, instead of the browser's slow native `title`. Without a reason the
 * element is drawn as it is. A disabled button still receives pointer events,
 * which open it; `children` gets the handlers to spread onto (or call from) the
 * element's own.
 *
 * `wrap` puts the element in a focusable span that carries the handlers
 * instead, so a keyboard reaches the reason of a native disabled button, which
 * cannot take focus; `children` then gets no handlers.
 */
export function ReasonTooltip({
  reason,
  placement = "right",
  wrap = false,
  children,
}: {
  reason: string | undefined;
  placement?: TooltipPlacement;
  wrap?: boolean;
  children: (
    props: ReturnType<typeof useTooltip>["props"] | undefined,
  ) => ReactNode;
}) {
  const description = useId();
  if (!reason) return <>{children(undefined)}</>;
  return (
    <WithTooltip label={reason} placement={placement} size="wrap">
      {(props) =>
        wrap ? (
          <span
            className="reason-wrapper"
            data-cds-disabled-reason-wrapper=""
            tabIndex={0}
            {...props}
            aria-describedby={description}
          >
            {children(undefined)}
            <span id={description} className="sr-only">
              {reason}
            </span>
          </span>
        ) : (
          children(props)
        )
      }
    </WithTooltip>
  );
}
