import type { ReactNode } from "react";
import { Spinner } from "../ui/Spinner";
import "./busy-label.css";

/**
 * A button's content while it works. The label and the spinner share one grid
 * cell, so the button keeps its width.
 */
export function BusyLabel({
  busy,
  busyLabel,
  children,
}: {
  busy: boolean;
  /** What a screen reader says while the button works. */
  busyLabel: string;
  children: ReactNode;
}) {
  return (
    <span className="busy-label">
      <span className="busy-label-text" data-busy={busy || undefined}>
        {children}
      </span>
      {busy && (
        <>
          <Spinner inheritColor size="md" className="busy-label-spinner" />
          <span className="sr-only" role="status">
            {busyLabel}
          </span>
        </>
      )}
    </span>
  );
}
