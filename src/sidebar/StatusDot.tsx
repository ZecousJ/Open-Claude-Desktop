import { Suspense, type CSSProperties } from "react";
import { Archive } from "../ui/glyphs";
import { useTooltip } from "../ui/Tooltip";
import type { RowStatus } from "./row-status";
import { lazyPiece } from "../ui/lazy-piece";

// Silent: a glyph that fails to load is left out; the row's label stays.
const PrStateGlyph = lazyPiece(
  () => import("../pr/PrStateGlyph"),
  "PrStateGlyph",
  { silent: true },
);

/**
 * A row's dot with its name: a labelled image (a status while the state is
 * live) whose tooltip shows after the usual delay, and for a Chat or Cowork row
 * a button that marks the conversation read or unread. It sits inside the row's
 * link, so a press on it neither opens the conversation nor starts a drag.
 */
export function StatusDot({
  status,
  breath,
  onToggle,
}: {
  status: RowStatus;
  /** The running dot's shared phase. */
  breath?: CSSProperties;
  onToggle: () => void;
}) {
  const { toggle } = status;
  const tip = useTooltip(status.label, {
    placement: "below",
    detail: toggle?.hint,
  });
  const live = status.dot !== "" && !status.archived;
  return (
    <>
      <span
        {...tip.props}
        className="row-status"
        role={toggle ? "button" : live ? "status" : "img"}
        aria-label={status.label}
        tabIndex={toggle ? -1 : undefined}
        data-clickable={toggle ? "" : undefined}
        onPointerDown={(event) => {
          tip.props.onPointerDown();
          if (toggle) event.stopPropagation();
        }}
        onClick={
          toggle
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggle();
              }
            : undefined
        }
        // A double click on the dot is two toggles, not a rename.
        onDoubleClick={
          toggle
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
              }
            : undefined
        }
        onKeyDown={(event) => {
          tip.props.onKeyDown(event);
          if (toggle && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            event.stopPropagation();
            onToggle();
          }
        }}
      >
        {status.archived ? (
          <Archive className="thread-archived" size={14} strokeWidth={1.5} />
        ) : status.pr ? (
          // Loaded once a session has a pull request (the glyphs are outlines).
          <Suspense fallback={<span className="thread-dot" />}>
            <PrStateGlyph state={status.pr} size={14} />
          </Suspense>
        ) : (
          <span
            className={`thread-dot ${status.dot}`}
            style={status.dot === "working" ? breath : undefined}
          />
        )}
      </span>
      {tip.tooltip}
    </>
  );
}
