import { useEffect, useRef, useState } from "react";
import {
  canStep,
  navigate,
  replaceCurrent,
  sameEntry,
  startHistory,
  step,
  stepFromUnrecorded,
  type NavEntry,
} from "./navigation-history";

/**
 * Records every change of what the window shows and steps back or forward
 * through it. `apply` shows an entry; `valid` rejects entries whose
 * conversation is gone. Nothing is recorded while `record` is false
 * (incognito). The returned callbacks are undefined when there is nowhere to go.
 */
export function useNavigationHistory({
  location,
  record,
  valid,
  apply,
  beforeMove,
}: {
  location: NavEntry;
  record: boolean;
  valid: (entry: NavEntry) => boolean;
  apply: (entry: NavEntry) => void;
  beforeMove?: (resume: () => void) => boolean;
}) {
  const [history, setHistory] = useState(() => startHistory(location));
  const replacing = useRef(false);
  useEffect(() => {
    if (!record) return;
    setHistory((current) => {
      if (sameEntry(current.current, location)) return current;
      if (replacing.current) {
        replacing.current = false;
        return replaceCurrent(current, location);
      }
      return navigate(current, location);
    });
  }, [
    location.page,
    location.surface,
    location.conversationId,
    location.artifactId,
    record,
  ]);
  const move = record ? step : stepFromUnrecorded;
  const go = (direction: "back" | "forward") => {
    const next = move(history, direction, valid);
    if (!next) return;
    const commit = () => {
      setHistory(next);
      apply(next.current);
    };
    if (!beforeMove?.(commit)) commit();
  };
  const canGoBack = record
    ? canStep(history, "back", valid)
    : valid(history.current) || canStep(history, "back", valid);
  return {
    back: canGoBack ? () => go("back") : undefined,
    forward: canStep(history, "forward", valid)
      ? () => go("forward")
      : undefined,
    /** The next location replaces the current entry instead of adding one. */
    replaceNext: () => {
      replacing.current = true;
    },
  };
}
