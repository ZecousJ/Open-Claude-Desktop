import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../ui/useDismiss";
import { t } from "../i18n";

/** Same read-only R17/source card; the anchor now belongs to a genuine
 * ProseMirror inline atom rather than an overlaid text-range mirror. */
export function AtomicSkillCard({
  anchor,
  name,
  description,
  onClose,
  onEnter,
  onLeave,
}: {
  anchor: HTMLElement;
  name: string;
  description: string;
  onClose(): void;
  onEnter(): void;
  onLeave(): void;
}) {
  const card = useRef<HTMLDivElement>(null),
    target = useRef<HTMLElement>(anchor);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  target.current = anchor;
  useDismiss([card, target], true, onClose);
  useLayoutEffect(() => {
    const update = () => {
      if (!anchor.isConnected) return onClose();
      const rect = anchor.getBoundingClientRect(),
        height = card.current?.getBoundingClientRect().height ?? 0;
      const width = Math.min(178, window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top:
          rect.top - height - 8 >= 8
            ? rect.top - height - 8
            : Math.min(rect.bottom + 8, window.innerHeight - height - 8),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, description, onClose]);
  return createPortal(
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
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {description && (
        <div className="composer-skill-description">
          <p>{description}</p>
        </div>
      )}
      <div className="composer-skill-caption">{t("Skill")}</div>
    </div>,
    anchor.ownerDocument.body,
  );
}
