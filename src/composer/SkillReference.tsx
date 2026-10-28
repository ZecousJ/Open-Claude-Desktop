import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../ui/useDismiss";
import { t } from "../i18n";
import { useSkillReferenceLayout } from "./skill-reference-layout";

/** O16 shared9 s6/vx/bK and R17 official-skill-chip/card. This is a
 * read-only description of an actually enabled skill, never an enable or
 * send action. The invisible real `$name` retains textarea byte geometry. */
export function SkillReference({
  name,
  description,
  raw,
}: {
  name: string;
  description: string;
  raw: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const button = useRef<HTMLButtonElement>(null),
    card = useRef<HTMLDivElement>(null);
  const rawText = useRef<HTMLSpanElement>(null);
  const singleLine = useSkillReferenceLayout(rawText);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => clearTimeout(timer.current);
  const show = () => {
    clear();
    timer.current = setTimeout(() => setOpen(true), 50);
  };
  const hide = () => {
    clear();
    timer.current = setTimeout(() => setOpen(false), 50);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!singleLine) {
      clear();
      setOpen(false);
    }
  }, [singleLine]);
  useDismiss([button, card], open, () => {
    clear();
    setOpen(false);
  });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = button.current?.getBoundingClientRect();
      if (!anchor) return;
      const height = card.current?.getBoundingClientRect().height ?? 0;
      const width = Math.min(178, window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        top:
          anchor.top - height - 8 >= 8
            ? anchor.top - height - 8
            : Math.min(anchor.bottom + 8, window.innerHeight - height - 8),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, description]);
  return (
    <mark
      className="composer-skill-reference"
      data-skill-token={name}
      data-reference-mode={singleLine ? "reference" : "raw"}
    >
      <span ref={rawText} className="composer-skill-raw" aria-hidden="true">
        {raw}
      </span>
      {singleLine && (
        <button
          ref={button}
          type="button"
          className="composer-skill-reference-trigger"
          aria-label={`/${name}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-card-open={open || undefined}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={() => {
            clear();
            setOpen(true);
          }}
          onBlur={hide}
          onClick={() => {
            clear();
            setOpen((current) => !current);
          }}
        >
          <span className="composer-skill-prefix" aria-hidden="true">
            /
          </span>
          <span className="composer-skill-name">{name}</span>
        </button>
      )}
      {open &&
        singleLine &&
        createPortal(
          <div
            ref={card}
            role="dialog"
            aria-label={name}
            className="composer-skill-card"
            data-no-translate
            style={
              position
                ? { left: position.left, top: position.top }
                : { visibility: "hidden" }
            }
            onMouseEnter={clear}
            onMouseLeave={hide}
          >
            {description && (
              <div className="composer-skill-description">
                <p>{description}</p>
              </div>
            )}
            <div
              className="composer-skill-caption"
              data-no-translate={undefined}
            >
              {t("Skill")}
            </div>
          </div>,
          document.body,
        )}
    </mark>
  );
}
