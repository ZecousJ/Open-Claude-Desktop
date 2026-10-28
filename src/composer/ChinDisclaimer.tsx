import { useLayoutEffect, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { ConversationDisclaimer } from "./ConversationDisclaimer";

/** The gap the note keeps from the chin's controls on each side. */
const GAP = 12;

/**
 * The conversation chin's note. Centred on the chin when it fits; moved toward
 * the free space between the controls when only that fits; else shown above the
 * frame, its chin copy kept unseen to measure again when the chin widens. Phone
 * web keeps its own placement above the input (composer CSS), so it is never
 * moved there.
 */
export function ChinDisclaimer(
  props: ComponentProps<typeof ConversationDisclaimer>,
) {
  const [note, setNote] = useState<HTMLSpanElement | null>(null);
  const [place, setPlace] = useState<{ above: boolean; shift: number }>({
    above: false,
    shift: 0,
  });
  const [slot, setSlot] = useState<Element | null>(null);
  useLayoutEffect(() => {
    const chin = note?.closest(".composer-chin");
    if (!note || !chin) return;
    const leading = chin.querySelector(":scope > .composer-chin-leading");
    const trailing = chin.querySelector(":scope > .composer-chin-trailing");
    setSlot(
      chin.parentElement?.querySelector(
        ":scope > .composer-disclaimer-above",
      ) ?? null,
    );
    const set = (above: boolean, shift: number) =>
      setPlace((now) =>
        now.above === above && now.shift === shift ? now : { above, shift },
      );
    const measure = () => {
      const box = chin.getBoundingClientRect();
      if (
        box.width === 0 ||
        globalThis.matchMedia?.("(max-width: 639px)").matches
      )
        return set(false, 0);
      const half = note.getBoundingClientRect().width / 2;
      const centre = box.left + box.width / 2;
      const rtl = document.documentElement.dir === "rtl";
      const start = leading?.getBoundingClientRect();
      const end = trailing?.getBoundingClientRect();
      const left = rtl ? end : start;
      const right = rtl ? start : end;
      const from = left?.width ? left.right + GAP : box.left;
      const to = right?.width ? right.left - GAP : box.right;
      if (centre - half >= from && centre + half <= to) set(false, 0);
      else if (to - from >= 2 * half)
        set(false, Math.round((from + to) / 2 - centre));
      else set(true, 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    for (const element of [chin, note, leading, trailing])
      if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [note]);
  return (
    <>
      <ConversationDisclaimer
        {...props}
        noteRef={setNote}
        hidden={place.above}
        shift={place.shift}
      />
      {place.above &&
        slot &&
        createPortal(<ConversationDisclaimer {...props} />, slot)}
    </>
  );
}
