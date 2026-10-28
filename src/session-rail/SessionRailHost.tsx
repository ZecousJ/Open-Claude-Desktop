import { Suspense, useEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { Conversation } from "../../shared/types";
import { useApp } from "../app/AppContext";
import { lazyPiece } from "../ui/lazy-piece";
import {
  railFit,
  railVisible,
  setRailFits,
  setRailRaised,
  useRailRaised,
  useRailShown,
} from "./rail-store";

// The rail and its stylesheet load with the first Code session that shows it.
const SessionRail = lazyPiece(() => import("./SessionRail"), "SessionRail");

/**
 * How a Code session's rail shows: as a column when turned on in the header
 * and there is room for it beside the conversation (railFit) — beside an
 * open side pane only when the conversation is wide enough — or raised over
 * the conversation when the header's toggle asked for it without that room.
 * Measures the conversation's border box, so the room the rail takes
 * doesn't hide it again.
 */
export function useSessionRail(
  active: Conversation | undefined,
  main: RefObject<HTMLElement | null>,
) {
  const app = useApp();
  const [shown] = useRailShown();
  const [width, setWidth] = useState(0);
  const code = active?.mode === "code";
  useEffect(() => {
    const element = main.current;
    if (!code || !element) return;
    // The new width applies in the frame the size changed in (a resize observer
    // runs after layout and before paint): a pane opening would otherwise show
    // the rail beside it for a frame on the old width and the transcript jumps.
    const observer = new ResizeObserver(() =>
      flushSync(() => setWidth(element.offsetWidth)),
    );
    observer.observe(element);
    setWidth(element.offsetWidth);
    return () => observer.disconnect();
  }, [code, main]);
  const paneOpen = app.panel !== null || !!app.artifact;
  const fits = code && railVisible(railFit(width), paneOpen);
  const raisedFor = useRailRaised();
  const column = fits && shown;
  // A raised rail goes once the column has room (the original's view).
  useEffect(() => {
    setRailFits(fits);
    if (column && raisedFor !== null) setRailRaised(null);
  }, [fits, column, raisedFor]);
  if (column) return "column";
  return code && active && raisedFor === active.id ? "raised" : null;
}

export function SessionRailSlot({
  active,
  raised = false,
}: {
  active: Conversation;
  raised?: boolean;
}) {
  return (
    <Suspense fallback={null}>
      <SessionRail conversation={active} raised={raised} />
    </Suspense>
  );
}
