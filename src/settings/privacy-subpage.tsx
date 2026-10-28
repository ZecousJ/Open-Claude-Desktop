import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "../ui/glyphs";
import { Skeleton } from "../ui/Skeleton";

/**
 * A Privacy subpage: a ghost "← Privacy" button on its own 56px line, focused
 * on arrival, then the title, an optional description and the list.
 */
export function PrivacySubpage({
  title,
  description,
  onBack,
  children,
}: {
  title: string;
  description?: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), []);
  return (
    <div className="privacy-subpage">
      <div className="privacy-subpage-back">
        <button ref={back} type="button" onClick={onBack}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Privacy
        </button>
      </div>
      <div className="privacy-subpage-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Placeholder rows while a list loads (the live table's 72 / 58 / 66% lines). */
export function LoadingRows({
  rows = 3,
  cells = 4,
}: {
  rows?: number;
  cells?: number;
}) {
  const widths = ["72%", "58%", "66%"];
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} aria-hidden={row > 0 || undefined}>
          {Array.from({ length: cells }, (_, cell) => (
            <td key={cell} className={cell === cells - 1 ? "end" : undefined}>
              <Skeleton width={widths[(row + cell) % 3]} height={12} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
