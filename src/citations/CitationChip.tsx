import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import { createPortal } from "react-dom";
import { useOpenLink } from "../ui/ExternalLinks";
import { CitationCard } from "./CitationCard";
import { cardPosition, chipLabel, type CitationGroup } from "./citations";

/** Hover before the card shows, and how long it stays after the pointer leaves. */
export const citationHoverMs = 300;
export const citationHoldMs = 180;

/**
 * An inline citation: a small pill after the cited words naming the site
 * ("wikipedia", "wikipedia +2"). Hovering it 300ms or focusing it by
 * keyboard shows the card (CitationCard); the pointer may move into the
 * card. Clicking the chip opens the page shown in the card, through the
 * app's external link confirmation and the administrator's link policy.
 */
export function CitationChip({ group }: { group: CitationGroup }) {
  const openLink = useOpenLink();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  const chip = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !chip.current || !card.current) {
      setPlace(undefined);
      return;
    }
    const box = chip.current.getBoundingClientRect();
    const size = card.current.getBoundingClientRect();
    setPlace(
      cardPosition(
        box,
        { width: size.width, height: size.height },
        { width: innerWidth, height: innerHeight },
      ),
    );
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // The card is placed once; scrolling the transcript closes it.
    addEventListener("scroll", close, true);
    addEventListener("resize", close);
    return () => {
      removeEventListener("scroll", close, true);
      removeEventListener("resize", close);
    };
  }, [open]);
  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hold = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), citationHoldMs);
  };
  const leaveFocus = (event: FocusEvent) => {
    const to = event.relatedTarget as Node | null;
    if (to && (chip.current?.contains(to) || card.current?.contains(to)))
      return;
    clearTimeout(timer.current);
    setOpen(false);
  };
  const focusables = () =>
    Array.from(
      card.current?.querySelectorAll<HTMLElement>("a[href], button") ?? [],
    );
  const keys = (event: {
    key: string;
    shiftKey: boolean;
    target: EventTarget;
    preventDefault(): void;
  }) => {
    // The card lives at the end of the page: Tab moves between the chip
    // and the card's controls, and leaving the card returns to the chip.
    if (event.key === "Tab" && open) {
      const inCard = focusables();
      const at = inCard.indexOf(event.target as HTMLElement);
      if (event.target === chip.current && !event.shiftKey && inCard.length) {
        event.preventDefault();
        inCard[0].focus();
      } else if (at === 0 && event.shiftKey) {
        event.preventDefault();
        chip.current?.focus();
      } else if (at === inCard.length - 1 && at >= 0 && !event.shiftKey) {
        event.preventDefault();
        clearTimeout(timer.current);
        setOpen(false);
        chip.current?.focus();
      }
      return;
    }
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    clearTimeout(timer.current);
    setOpen(false);
    chip.current?.focus();
  };
  const current = group.sources[0];
  if (!current) return null;
  const label = chipLabel(group);
  const others = group.sources.length - 1;
  return (
    <>
      <button
        ref={chip}
        type="button"
        className="citation-chip"
        data-open={open || undefined}
        aria-label={`Source: ${current.host}${others ? ` and ${others} more` : ""}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerEnter={() => show(open ? 0 : citationHoverMs)}
        onPointerLeave={hold}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) show(0);
        }}
        onBlur={leaveFocus}
        onKeyDown={keys}
        onClick={() => {
          clearTimeout(timer.current);
          setOpen(false);
          openLink(current.url);
        }}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div
            ref={card}
            id={id}
            role="dialog"
            aria-label="Source"
            // Clicking the card's text keeps focus (and the card) here.
            tabIndex={-1}
            className="citation-card"
            data-placed={Boolean(place)}
            style={place ?? { left: 0, top: 0 }}
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={hold}
            onBlur={leaveFocus}
            onKeyDown={keys}
          >
            <CitationCard
              group={group}
              onOpen={(url) => {
                setOpen(false);
                openLink(url);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
