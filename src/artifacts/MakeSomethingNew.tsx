import { useEffect, useId, useRef, useState } from "react";
import type { ArtifactOutputKind } from "../../shared/artifact-output";
import { t } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { IconButton } from "../ui/Controls";
import { reducedMotion } from "../ui/page-fade";
import { TemplateArtwork } from "./TemplateArtwork";

/** The new artifact kinds, with the New menu's glyphs. */
export const makeTemplates = [
  {
    kind: "docs" as const,
    name: "Docs",
    badge: "New",
    prompt: "Create a personal document.",
    icon: "File" as const,
  },
  {
    kind: "slides" as const,
    name: "Slides",
    badge: "New",
    prompt: "Create a presentation.",
    icon: "Slides" as const,
  },
  {
    kind: "design" as const,
    name: "Design",
    badge: "New",
    prompt: "Create a design.",
    icon: "Palette" as const,
  },
  {
    kind: "dashboard" as const,
    name: "Dashboard",
    badge: "Beta",
    prompt: "Create a dashboard.",
    icon: "ChartLine" as const,
  },
];
const templates = makeTemplates;

/**
 * Which ends of the template strip are scrolled out of view: a fade covers each
 * hidden end and a round caret sits over it.
 */
function useStripOverflow(row: React.RefObject<HTMLUListElement | null>) {
  const [ends, setEnds] = useState({ left: false, right: false });
  const update = () => {
    const element = row.current;
    if (!element) return;
    const { scrollLeft, scrollWidth, clientWidth } = element;
    const left = scrollLeft > 1;
    const right = scrollLeft < scrollWidth - clientWidth - 1;
    setEnds((previous) =>
      previous.left === left && previous.right === right
        ? previous
        : { left, right },
    );
  };
  useEffect(() => {
    update();
    const element = row.current;
    if (!element || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ends, update };
}

export function MakeSomethingNew({
  onCreate,
}: {
  onCreate: (prompt: string, kind?: ArtifactOutputKind) => void;
}) {
  const heading = useId();
  const row = useRef<HTMLUListElement>(null);
  const { ends, update } = useStripOverflow(row);
  // One press moves a whole number of tiles: as many as fit less one, at
  // most three, at least one (the original's step; smooth unless motion
  // is reduced).
  const step = (direction: -1 | 1) => {
    const element = row.current;
    const first = element?.firstElementChild;
    if (!element || !(first instanceof HTMLElement)) return;
    const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
    const unit = first.offsetWidth + gap;
    const tiles = Math.max(
      1,
      Math.min(3, Math.floor(element.clientWidth / unit) - 1),
    );
    element.scrollBy({
      left: direction * tiles * unit,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  };
  const fade =
    ends.left && ends.right
      ? "both"
      : ends.left
        ? "left"
        : ends.right
          ? "right"
          : undefined;
  return (
    <section className="artifacts-make" aria-labelledby={heading}>
      <h2 id={heading}>{t("Make something new")}</h2>
      <div className="artifacts-make-strip">
        <ul
          className="artifacts-make-row"
          role="list"
          ref={row}
          data-fade={fade}
          onScroll={update}
        >
          {templates.map(({ name, badge, prompt, kind }) => (
            <li key={name}>
              <button
                className="artifacts-make-card"
                aria-label={`${t(name)}, ${t(badge)}`}
                onClick={() => onCreate(prompt, kind)}
              >
                <TemplateArtwork kind={kind} />
                <span className="artifacts-make-label">
                  {t(name)}
                  <span
                    className={
                      badge === "New"
                        ? "artifacts-make-badge new"
                        : "artifacts-make-badge"
                    }
                  >
                    {t(badge)}
                  </span>
                </span>
              </button>
            </li>
          ))}
          <li aria-hidden className="artifacts-make-tail" />
        </ul>
        {ends.left && (
          <span className="artifacts-make-scroll left">
            <IconButton label="Scroll left" onClick={() => step(-1)}>
              <AppIcon name="CaretLeft" size={20} />
            </IconButton>
          </span>
        )}
        {ends.right && (
          <span className="artifacts-make-scroll right">
            <IconButton label="Scroll right" onClick={() => step(1)}>
              <AppIcon name="CaretRight" size={20} />
            </IconButton>
          </span>
        )}
      </div>
    </section>
  );
}
