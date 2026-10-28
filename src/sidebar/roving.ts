import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

type Keys = typeof import("./roving-keys");

/**
 * Arrow-key roaming for the sidebar list, after the original's (desktop
 * bundle 2.31226.1, sidebar roving focus): ↓ ↑ Home End walk every marked
 * item (`data-roving-item`: rows, section headings, "Show more") and loop;
 * ← → move between the controls of one row (`data-roving-row`: a row's link
 * and its ⋮ button). Tab stops once per block (`data-roving-block`), on the
 * item that last had focus, else the selected row, else the first.
 *
 * The walking code (roving-keys.ts) is fetched when focus first enters the
 * list, so it stays out of the first load; until then every item is an
 * ordinary Tab stop.
 */
export function useRovingFocus(list: RefObject<HTMLElement | null>) {
  const keys = useRef<Keys>(undefined);
  const stops = useRef(new Map<HTMLElement, HTMLElement>());
  const [, loaded] = useState(false);
  const load = () =>
    void import("./roving-keys").then((module) => {
      keys.current = module;
      loaded(true);
    });
  // After each render the blocks' Tab stops are put right again.
  useEffect(() => {
    if (keys.current && list.current)
      keys.current.applyStops(list.current, stops.current);
  });
  return {
    onFocus: (event: { target: EventTarget }) => {
      if (keys.current) keys.current.rememberStop(stops.current, event.target);
      else load();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (keys.current && list.current)
        keys.current.handleKey(list.current, event);
    },
  };
}
