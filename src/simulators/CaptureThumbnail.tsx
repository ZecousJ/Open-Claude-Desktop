import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { SimulatorCapture } from "../../shared/simulators";
import { formatText } from "../i18n";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";

/** A capture shows this long before it goes by itself. */
export const thumbnailShowMs = 5000;
/** Its exit, and the wait after it said something (1.2 s). */
export const thumbnailExitMs = 300;
export const thumbnailStatusMs = 1200;
/** The flight from the screen into the corner. */
const flightMs = 400;

export interface CaptureActions {
  /** Attach as context (a screenshot, while a composer can take it). */
  attach?: (path: string) => Promise<boolean>;
  copyPath: (path: string) => Promise<boolean>;
  reveal: (path: string) => void;
  remove: (path: string) => Promise<boolean>;
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The transform that puts `box` over `from`, letterboxed as the screen draws
 * it.
 */
function flightFrom(from: DOMRect, box: DOMRect): string | undefined {
  if (from.width <= 0 || from.height <= 0 || box.width <= 0 || box.height <= 0)
    return undefined;
  const scale = Math.min(from.width / box.width, from.height / box.height);
  const x = from.left - box.left + (from.width - box.width * scale) / 2;
  const y = from.top - box.top + (from.height - box.height * scale) / 2;
  return `translate(${x}px, ${y}px) scale(${scale})`;
}

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The saved capture in the stage's corner: a screenshot flies there from the
 * screen, a recording slides in. A click attaches it to the message being
 * written; its menu (right click) has Copy path, Attach as context, Show in
 * Finder, Close and Delete. It goes after five seconds unless the pointer or
 * the focus is on it, and as soon as a newer capture comes.
 */
export function CaptureThumbnail({
  capture,
  actions,
  retiring,
  revealLabel,
  from,
  onDismiss,
  onReturnFocus,
}: {
  capture: SimulatorCapture & {
    thumbnail: NonNullable<SimulatorCapture["thumbnail"]>;
  };
  actions: CaptureActions;
  /** A newer capture replaced it: it fades out. */
  retiring: boolean;
  /** "Show in Finder" or "Show in File Explorer". */
  revealLabel: string;
  /** Where the screen was drawn, for the screenshot's flight. */
  from?: DOMRect | null;
  onDismiss: () => void;
  /** Escape gives the focus back to the screen. */
  onReturnFocus: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [entered, setEntered] = useState(false);
  const [flight, setFlight] = useState<string>();
  const [menu, setMenu] = useState<MenuPosition>();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const saved = formatText(
    capture.kind === "screenshot"
      ? "Screenshot saved: {fileName}"
      : "Recording saved: {fileName}",
    { fileName: fileName(capture.path) },
  );
  const gone = leaving || retiring;

  // In: from the screen (a screenshot), else a short slide from the side.
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    const start =
      capture.kind === "screenshot" && from && box && !reducedMotion()
        ? flightFrom(from, box)
        : undefined;
    setFlight(start);
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setFlight(undefined);
        setEntered(true);
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  // Five seconds untouched, then it goes.
  const held = hovered || focused || menu !== undefined || busy || !!status;
  useEffect(() => {
    if (held || gone) return;
    const timer = setTimeout(() => setLeaving(true), thumbnailShowMs);
    return () => clearTimeout(timer);
  }, [held, gone]);
  // After saying something, a little later.
  useEffect(() => {
    if (!status || busy) return;
    const timer = setTimeout(() => setLeaving(true), thumbnailStatusMs);
    return () => clearTimeout(timer);
  }, [status, busy]);
  // Out, then removed.
  useEffect(() => {
    if (!gone) return;
    const timer = setTimeout(onDismiss, thumbnailExitMs);
    return () => clearTimeout(timer);
  }, [gone]);

  const run = async (
    work: () => Promise<boolean>,
    done: string,
    failed: string,
  ) => {
    setBusy(true);
    try {
      setStatus((await work()) ? done : failed);
    } catch {
      setStatus(failed);
    } finally {
      setBusy(false);
    }
  };
  const attach = actions.attach;
  const doAttach = attach
    ? () =>
        void run(
          () => attach(capture.path),
          "Attached as context.",
          "Couldn’t attach as context.",
        )
    : undefined;
  const entries: MenuEntry[] = [
    {
      label: "Copy path",
      disabled: busy,
      onSelect: () =>
        void run(
          () => actions.copyPath(capture.path),
          "Path copied to clipboard.",
          "Copy failed",
        ),
    },
    ...(doAttach
      ? [{ label: "Attach as context", disabled: busy, onSelect: doAttach }]
      : []),
    {
      label: revealLabel,
      disabled: busy,
      onSelect: () => {
        actions.reveal(capture.path);
        setLeaving(true);
      },
    },
    { separator: true },
    { label: "Close", disabled: busy, onSelect: () => setLeaving(true) },
    {
      label: "Delete",
      danger: true,
      disabled: busy,
      onSelect: () =>
        void run(
          () => actions.remove(capture.path),
          capture.kind === "screenshot"
            ? "Screenshot deleted."
            : "Recording deleted.",
          capture.kind === "screenshot"
            ? "Couldn’t delete the screenshot."
            : "Couldn’t delete the recording.",
        ),
    },
  ];
  const openMenu = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    setMenu({
      right: Math.max(8, window.innerWidth - box.right),
      bottom: window.innerHeight - box.top + 6,
    });
  };

  const style: CSSProperties = flight
    ? { transform: flight, transition: "none" }
    : {};
  return (
    <div
      ref={root}
      className="sim-capture"
      data-shown={(entered || flight !== undefined) && !gone ? true : undefined}
      data-flying={flight !== undefined || undefined}
      style={style}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        ref={trigger}
        type="button"
        className="sim-capture-button"
        aria-label={saved}
        aria-haspopup="menu"
        tabIndex={gone ? -1 : undefined}
        disabled={gone}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => (doAttach && !busy ? doAttach() : openMenu())}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || menu) return;
          event.preventDefault();
          event.stopPropagation();
          onReturnFocus();
          setLeaving(true);
        }}
      >
        <img
          src={capture.thumbnail.dataUrl}
          width={capture.thumbnail.width}
          height={capture.thumbnail.height}
          alt=""
          draggable={false}
        />
      </button>
      <span className="sr-only" aria-live="polite">
        {status ?? (entered ? saved : "")}
      </span>
      {menu && (
        <Menu
          label={saved}
          entries={entries}
          position={menu}
          width={200}
          anchors={[trigger]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}
