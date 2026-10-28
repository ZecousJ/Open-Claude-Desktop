import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { DragGhostSource } from "./useConversationDrag";

/**
 * The dragged row's copy, after the original's: the row's own markup on a pill
 * with the floating shadow, held where it was grabbed and moved to the pointer
 * every frame. When a release would unpin, the copy fades out and "Release to
 * unpin" fades in over a red fill, and the pill narrows to the words and
 * centres on the pointer; all of it over 150ms on the ease-out curve.
 */
export function DragGhost({
  ghost,
  label,
  danger,
  pointer,
}: {
  ghost: DragGhostSource;
  /** Words in place of the row, or null for the row itself. */
  label: string | null;
  danger: boolean;
  pointer: RefObject<{ x: number; y: number }>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const cloneSlot = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  // The words stay while they fade out.
  const [lastLabel, setLastLabel] = useState(label);
  if (label !== null && label !== lastLabel) setLastLabel(label);
  const words = label ?? lastLabel;
  const [wordsWidth, setWordsWidth] = useState<number>();
  useLayoutEffect(() => {
    if (measure.current) setWordsWidth(Math.ceil(measure.current.offsetWidth));
  }, [words]);
  useLayoutEffect(() => {
    let id = 0;
    const follow = () => {
      const element = frame.current;
      if (element)
        element.style.transform = `translate(${pointer.current.x}px, ${pointer.current.y}px)`;
      id = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(id);
  }, [pointer]);
  useEffect(() => {
    const slot = cloneSlot.current;
    if (!slot) return;
    slot.appendChild(ghost.clone);
    return () => ghost.clone.remove();
  }, [ghost.clone]);
  const labelled = label !== null && wordsWidth !== undefined;
  const width = labelled ? Math.min(wordsWidth, ghost.width) : ghost.width;
  const left = labelled ? Math.round(width / 2) : ghost.dx;
  const top = labelled ? Math.round(ghost.height / 2) : ghost.dy;
  return (
    <div ref={frame} className="conversation-drag-ghost" aria-hidden="true">
      <div
        className={`drag-ghost-pill ${danger ? "danger" : ""} ${labelled ? "labelled" : ""}`}
        style={{
          left: -left,
          top: -top,
          width,
          height: ghost.height,
          borderRadius: ghost.radius,
          transformOrigin: `${left}px ${top}px`,
        }}
      >
        <div ref={cloneSlot} className="drag-ghost-clone" />
        <div className="drag-ghost-danger" />
        <div className="drag-ghost-label">
          <span>{words}</span>
        </div>
        {words !== null && (
          <span ref={measure} className="drag-ghost-measure">
            {words}
          </span>
        )}
      </div>
    </div>
  );
}
