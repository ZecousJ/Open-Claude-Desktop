import { useEffect, useState, type RefObject } from "react";
import { formatText } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { reducedMotion } from "../ui/page-fade";

/** The arrows' room at each end of the row (the original's calc(0.5rem +
 * --cds-h-control): 8 + 32). */
const ARROW_ROOM = 40;

/**
 * The narrow window's page tabs scroll sideways with a ghost arrow at each end
 * that has more: 32px CaretLeft / CaretRight buttons, out of the tab order,
 * over the row's first and last 32px; the row fades out over 20px before each
 * one. A press moves by the row's width less both arrows' room, and lands on
 * the end when less than that room would be left.
 */
export function SettingsTabArrows({
  nav,
}: {
  nav: RefObject<HTMLElement | null>;
}) {
  const [ends, setEnds] = useState({ start: false, end: false });
  useEffect(() => {
    const row = nav.current;
    if (!row) return;
    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = row;
      const start = scrollLeft > 1;
      const end = scrollLeft < scrollWidth - clientWidth - 1;
      row.dataset.fade =
        start && end ? "both" : start ? "start" : end ? "end" : "";
      setEnds((previous) =>
        previous.start === start && previous.end === end
          ? previous
          : { start, end },
      );
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(update)
        : undefined;
    observer?.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      observer?.disconnect();
      delete row.dataset.fade;
    };
  }, [nav]);
  const page = (toward: "start" | "end") => {
    const row = nav.current;
    if (!row) return;
    const step = Math.max(row.clientWidth - 2 * ARROW_ROOM, ARROW_ROOM);
    const last = row.scrollWidth - row.clientWidth;
    let left = row.scrollLeft + (toward === "end" ? step : -step);
    if (toward === "end" ? last - left < ARROW_ROOM : left < ARROW_ROOM)
      left = toward === "end" ? last : 0;
    row.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
  };
  return (
    <>
      {ends.start && (
        <button
          type="button"
          className="settings-tab-arrow start"
          aria-label={formatText("Scroll back")}
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => page("start")}
        >
          <AppIcon name="CaretLeft" size={20} />
        </button>
      )}
      {ends.end && (
        <button
          type="button"
          className="settings-tab-arrow end"
          aria-label={formatText("Scroll forward")}
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => page("end")}
        >
          <AppIcon name="CaretRight" size={20} />
        </button>
      )}
    </>
  );
}
