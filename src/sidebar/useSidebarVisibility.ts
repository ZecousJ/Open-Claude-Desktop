import { useEffect, useRef, useState } from "react";
import { surface } from "../../shared/host";
import {
  bootSidebarWidth,
  readBootHints,
  writeBootHints,
} from "../boot/boot-hints";
import {
  initialVisibility,
  peekRequested,
  resizeVisibility,
  showSidebar,
  toggleVisibility,
  sidebarOpen,
  type SidebarVisibility,
} from "./sidebar-visibility";

/** How long the `sidebar-animating` class stays, a little over the 150ms slide. */
export const slideMs = 190;

/** The web's width from its last visit, until the account's settings load. */
const remembered = () =>
  surface === "web" ? bootSidebarWidth(readBootHints()) : undefined;

/**
 * Whether the sidebar shows, with the forced collapse at narrow widths, and a
 * flag set in the same render as the change so only toggling animates the
 * layout (a 150ms slide on the web and the desktop, sidebar.css). The collapse
 * line follows `sidebarWidth`, the stored width; the web keeps it for its first
 * paint (web.html), which collapses before the scripts run.
 *
 * Narrow and wider than a phone, the sidebar never takes room: the toggle opens
 * and closes the peek over the page instead, as claude.ai's narrow viewport
 * does (`peekRequested`, followed by useSidebarPeek, which reports back with
 * `peekChanged`).
 */
export function useSidebarVisibility(sidebarWidth?: number) {
  const width = sidebarWidth ?? remembered();
  const [state, setState] = useState(() =>
    initialVisibility(
      innerWidth,
      width,
      undefined,
      readBootHints().sidebarCollapsed !== true,
    ),
  );
  const widthRef = useRef(width);
  widthRef.current = width;
  const [animating, setAnimating] = useState(0);
  const change = (next: (state: SidebarVisibility) => SidebarVisibility) => {
    setAnimating((value) => value + 1);
    setState(next);
  };
  useEffect(() => {
    const resize = () =>
      setState((current) =>
        resizeVisibility(current, innerWidth, widthRef.current),
      );
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  // A new width moves the line; the web's next first paint uses it.
  useEffect(() => {
    setState((current) => resizeVisibility(current, innerWidth, width));
    if (surface === "web" && sidebarWidth !== undefined)
      writeBootHints({ sidebarWidth });
  }, [width]);
  // The user's choice is kept for the next start (the narrow band's peek and
  // sheet are not: they are forgotten when the width changes).
  useEffect(() => {
    writeBootHints({ sidebarCollapsed: !state.userOpen });
  }, [state.userOpen]);
  useEffect(() => {
    if (!animating) return;
    const timer = setTimeout(() => setAnimating(0), slideMs);
    return () => clearTimeout(timer);
  }, [animating]);
  return {
    open: sidebarOpen(state),
    /** At or under the collapse line: the sidebar is not a column. */
    narrow: state.narrow,
    /** Narrow at a phone's width: the sidebar opens as the sheet. */
    phone: state.phone,
    /** The toggle asked for the peek (narrow, wider than a phone). */
    peekRequested: peekRequested(state),
    /** The peek opened or closed on its own (pointer, Escape, a press outside). */
    peekChanged: (open: boolean) =>
      setState((current) =>
        current.narrow && !current.phone && current.narrowOpen !== open
          ? { ...current, narrowOpen: open }
          : current,
      ),
    animating: animating > 0,
    toggle: () => change(toggleVisibility),
    show: () => change(showSidebar),
  };
}
