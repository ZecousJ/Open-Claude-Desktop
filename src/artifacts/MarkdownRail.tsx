import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import {
  RAIL_BUFFER_PX,
  RAIL_TICK_PX,
  activeEntry,
  documentOutline,
  keepInView,
  type OutlineEntry,
} from "./document-outline";
import "./file-viewer-panel.css";

export const HEADINGS = "h1, h2, h3, h4, h5, h6";
/** Space kept above a heading jumped to. */
const LANDING_MARGIN_PX = 16;
/** The landed highlight's length (file-viewer.css). */
const LANDED_MS = 1600;
/** Hovering the ticks waits this long before the contents open. */
const OPEN_DELAY_MS = 80;

/** Where the open contents line up: beside a hovered tick, or centred on the heading being read. */
interface Anchor {
  index: number;
  at: "tick" | "center";
}

/**
 * The contents rail of a Markdown document in the viewer
 * (MarkdownDocument.tsx), after the document rail of the live claude.ai a
 * sticky column of 8px rows with a short tick per heading (14, 9 and 6px by
 * level, the deeper ones set in 3px a level). Headings above the one being read
 * are in the muted text colour, the rest in the disabled one; the one being
 * read is a full 18px, 3px tall, in the accent text colour. A long outline
 * scrolls the rail to keep that tick in view, fading the clipped edge. Hovering
 * the ticks for 80ms opens the headings as a list beside them, the hovered
 * heading level with its tick; focusing the hidden Show contents button opens
 * it centred on the heading being read. Choosing one scrolls it 16px under the
 * top, focuses it and flashes its background in the accent tint (1.6s).
 */
export default function MarkdownRail({
  text,
  scroller,
  body,
}: {
  /** The document, so the headings are read again when it changes. */
  text: string;
  scroller: RefObject<HTMLElement | null>;
  body: RefObject<HTMLElement | null>;
}) {
  const headings = useRef<HTMLElement[]>([]);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [current, setCurrent] = useState(-1);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor>();
  const [pointed, setPointed] = useState<number | null>(null);
  const [lift, setLift] = useState(0);
  const [placed, setPlaced] = useState(0);
  const [ticksClip, setTicksClip] = useState({ top: false, bottom: false });
  const [listClip, setListClip] = useState({ top: false, bottom: false });
  const listId = useId();
  const nav = useRef<HTMLElement>(null);
  const ticks = useRef<HTMLOListElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const show = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hovered = useRef<number | null>(null);
  const liftRef = useRef(0);
  const listTop = useRef(0);
  const ticksTop = useRef(0);
  const focusOpened = useRef(false);
  const escaping = useRef(false);
  // The headings, read from the rendered document whenever it changes.
  useLayoutEffect(() => {
    const found = [
      ...(body.current?.querySelectorAll<HTMLElement>(HEADINGS) ?? []),
    ];
    headings.current = found;
    setOutline(
      documentOutline(
        found.map((heading) => ({
          level: Number(heading.tagName.slice(1)),
          text: heading.textContent ?? "",
        })),
      ),
    );
  }, [text]);
  // The heading being read follows the scroll, once a frame.
  useEffect(() => {
    const view = scroller.current;
    if (!view || !outline.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = view.getBoundingClientRect().top;
      const entry = activeEntry(
        outline,
        outline.map(
          (item) =>
            (headings.current[item.index]?.getBoundingClientRect().top ?? 0) -
            top,
        ),
        view,
      );
      setCurrent(entry ? outline.indexOf(entry) : -1);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    view.addEventListener("scroll", schedule, { passive: true });
    return () => {
      view.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [outline]);
  // A rail longer than its column scrolls to keep the current tick 40px
  // clear of either edge.
  const [ticksBox, setTicksBox] = useState({ view: 0, pad: 0 });
  useEffect(() => {
    const element = ticks.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const view = Math.round(entry.contentRect.height);
      const pad = Math.round(entry.contentRect.top);
      setTicksBox((box) =>
        box.view === view && box.pad === pad ? box : { view, pad },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [outline.length > 0]);
  useEffect(() => {
    const element = ticks.current;
    if (!element || !ticksBox.view || current < 0) return;
    const most = outline.length * RAIL_TICK_PX - ticksBox.view;
    if (most <= 0) {
      ticksTop.current = 0;
      setTicksClip((clip) =>
        clip.top || clip.bottom ? { top: false, bottom: false } : clip,
      );
      return;
    }
    const next = Math.min(
      most,
      keepInView({
        scrollTop: Math.min(ticksTop.current, most),
        view: ticksBox.view + 2 * ticksBox.pad,
        at: ticksBox.pad + current * RAIL_TICK_PX,
        size: RAIL_TICK_PX,
        buffer: RAIL_BUFFER_PX,
      }),
    );
    if (next !== ticksTop.current) {
      ticksTop.current = next;
      element.scrollTop = next;
    }
    const top = next > 0;
    const bottom = next < most;
    setTicksClip((clip) =>
      clip.top === top && clip.bottom === bottom ? clip : { top, bottom },
    );
  }, [current, outline, ticksBox]);
  // The open list lines up with its anchor: the hovered heading level with
  // its tick (scrolling the list, or lifting it when the list ends first),
  // or the heading being read in the middle.
  useLayoutEffect(() => {
    const items = list.current;
    const rail = ticks.current;
    const row = anchor ? items?.children[anchor.index] : undefined;
    if (!open || !anchor || !items || !rail || !row) return;
    const listBox = items.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const middle =
      rowBox.top - listBox.top + items.scrollTop + rowBox.height / 2;
    const restingTop = listBox.top - liftRef.current;
    let wanted: number;
    if (anchor.at === "center") wanted = middle - items.clientHeight / 2;
    else {
      const tick = rail.children[anchor.index]?.getBoundingClientRect();
      const level = tick ? tick.top + tick.height / 2 : restingTop + middle;
      wanted = middle + restingTop - level;
    }
    const card = items.parentElement;
    const room = nav.current?.clientHeight ?? items.clientHeight;
    const shown = card
      ? room - (card.offsetHeight - items.clientHeight)
      : items.clientHeight;
    const most = items.scrollHeight - shown;
    let scroll = 0;
    let shift = 0;
    if (anchor.at === "center") scroll = wanted;
    else if (most <= 1)
      shift = card
        ? Math.min(Math.max(0, -wanted), room - card.offsetHeight)
        : 0;
    else {
      scroll = Math.min(Math.max(0, wanted), most);
      shift = wanted > most ? -Math.ceil(wanted - most) : 0;
    }
    listTop.current = scroll;
    liftRef.current = shift;
    setLift(shift);
    setPlaced((n) => n + 1);
  }, [open, anchor]);
  useLayoutEffect(() => {
    if (placed && list.current) list.current.scrollTop = listTop.current;
  }, [placed]);
  // Scrolling up past the top of a lifted list lowers it back first.
  useEffect(() => {
    const card = list.current?.parentElement;
    if (!open || !card) return;
    const wheel = (event: WheelEvent) => {
      const items = list.current;
      if (
        event.deltaY < 0 &&
        items &&
        items.scrollTop <= 0 &&
        liftRef.current < 0
      ) {
        event.preventDefault();
        const next = Math.min(0, Math.round(liftRef.current - event.deltaY));
        liftRef.current = next;
        setLift(next);
      }
    };
    card.addEventListener("wheel", wheel, { passive: false });
    return () => card.removeEventListener("wheel", wheel);
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!outline.length) return null;
  const reading = current < 0 ? 0 : current;
  const openAt = (next: Anchor, point: number | null) => {
    setAnchor(next);
    setPointed(point);
    setOpen(true);
  };
  const close = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  const markListClip = () => {
    const items = list.current;
    if (!items) return;
    const top = items.scrollTop > 1;
    const bottom =
      items.scrollTop + items.clientHeight < items.scrollHeight - 1;
    setListClip((clip) =>
      clip.top === top && clip.bottom === bottom ? clip : { top, bottom },
    );
  };
  // The tick under the pointer, or the nearest end of the rail.
  const trackTick = (event: ReactMouseEvent<HTMLOListElement>) => {
    const target = event.target as Element | null;
    let row = target?.closest<HTMLElement>("li[data-index]") ?? null;
    const rail = ticks.current;
    const first = rail?.firstElementChild as HTMLElement | null;
    if (!row && rail && first)
      row =
        event.clientY < first.getBoundingClientRect().bottom
          ? first
          : ((rail.lastElementChild as HTMLElement | null) ?? first);
    if (row) hovered.current = Number(row.dataset.index);
  };
  const jump = (index: number) => {
    const entry = outline[index];
    const heading = entry && headings.current[entry.index];
    if (!heading) return;
    close();
    land(heading);
  };
  const keys = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = (
      { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity } as Record<
        string,
        number
      >
    )[event.key];
    const items = list.current;
    if (step !== undefined && items) {
      event.preventDefault();
      const buttons = [
        ...items.querySelectorAll<HTMLButtonElement>("li > button"),
      ];
      const own = event.currentTarget.closest("li")?.firstElementChild;
      const at = own ? buttons.indexOf(own as HTMLButtonElement) : -1;
      const next = Math.max(0, Math.min(buttons.length - 1, at + step));
      buttons[at === -1 ? 0 : next]?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      escaping.current = true;
      show.current?.focus();
      escaping.current = false;
    }
  };
  const liftStyle =
    lift < 0
      ? ({
          translate: `0 ${lift}px`,
          clipPath: `inset(${-lift}px -24px -24px)`,
          "--outline-lift": `${-lift}px`,
        } as CSSProperties)
      : lift > 0
        ? { translate: `0 ${lift}px` }
        : undefined;
  return (
    <div className="markdown-rail">
      <div
        className="markdown-rail-nav"
        onMouseLeave={() => {
          clearTimeout(timer.current);
          setPointed(null);
          if (!nav.current?.contains(nav.current.ownerDocument.activeElement))
            close();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            close();
        }}
      >
        <nav ref={nav} aria-label="On this page">
          <span className="markdown-rail-show">
            <button
              ref={show}
              type="button"
              aria-expanded={open}
              aria-controls={listId}
              onFocus={() => {
                if (escaping.current || open) return;
                focusOpened.current = true;
                setTimeout(() => {
                  focusOpened.current = false;
                }, 0);
                openAt({ index: reading, at: "center" }, null);
              }}
              onClick={() => {
                if (focusOpened.current) {
                  focusOpened.current = false;
                  return;
                }
                if (open) close();
                else openAt({ index: reading, at: "center" }, null);
              }}
              onKeyDown={keys}
            >
              Show contents
            </button>
          </span>
          <ol
            ref={ticks}
            className="markdown-rail-ticks"
            aria-hidden="true"
            data-clip-top={ticksClip.top || undefined}
            data-clip-bottom={ticksClip.bottom || undefined}
            onMouseMove={trackTick}
            onMouseEnter={(event) => {
              trackTick(event);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => {
                const index = hovered.current ?? reading;
                openAt({ index, at: "tick" }, index);
              }, OPEN_DELAY_MS);
            }}
          >
            {outline.map((entry, i) => (
              <li
                key={entry.index}
                data-index={i}
                data-level={entry.depth}
                data-current={i === current || undefined}
                data-read={i < current || undefined}
              >
                <span />
              </li>
            ))}
          </ol>
          <div
            className="markdown-rail-outline"
            data-open={open || undefined}
            data-clip-top={listClip.top || lift < 0 || undefined}
            data-clip-bottom={listClip.bottom || undefined}
            style={liftStyle}
          >
            <ol ref={list} id={listId} role="list" onScroll={markListClip}>
              {outline.map((entry, i) => {
                const now = open && i === current;
                return (
                  <li
                    key={entry.index}
                    data-level={entry.depth}
                    data-current={now || undefined}
                    data-read={(open && i < current) || undefined}
                    data-pointed={(open && pointed === i) || undefined}
                  >
                    <button
                      type="button"
                      aria-current={now ? "location" : undefined}
                      // The page keeps its scroll: a press does not move focus.
                      onPointerDown={(event) => event.preventDefault()}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setPointed(i)}
                      onKeyDown={keys}
                      onClick={() => jump(i)}
                    >
                      <span className="markdown-rail-tick" aria-hidden="true" />
                      <span className="markdown-rail-label">{entry.text}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </nav>
      </div>
    </div>
  );
}

/**
 * Scrolls `target` to just under the view's top, focuses it without
 * scrolling again and marks it landed: its background starts in the accent
 * tint and fades (file-viewer.css; none with reduced motion).
 */
export function land(target: HTMLElement) {
  const page = target.closest(".artifact-markdown-preview");
  page?.querySelector("[data-landed]")?.removeAttribute("data-landed");
  target.style.scrollMarginTop = `${LANDING_MARGIN_PX}px`;
  target.scrollIntoView({ block: "start" });
  target.setAttribute("data-landed", "");
  if (!target.hasAttribute("tabindex") && target.tagName !== "A")
    target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  setTimeout(() => {
    if (target.isConnected) target.removeAttribute("data-landed");
  }, LANDED_MS);
}
