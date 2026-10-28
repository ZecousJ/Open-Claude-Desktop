import { surface } from "../../shared/host";
import { defaultSidebarWidth } from "../../shared/sidebar-layout";

/**
 * The widest window (CSS pixels, so zooming in counts) at which the sidebar is
 * forced collapsed, for a sidebar `sidebarWidth` wide: the live claude.ai
 * bundle collapses while `(max-width: max(700px, ceil(width) + 329px))`
 * matches, its width being at most 420px, so the line is 700px for the default
 * 288px sidebar and never past 749px. Claudex's sidebar can be dragged to
 * 460px; the line stops at the same 749px.
 */
export function collapseThreshold(sidebarWidth: number = defaultSidebarWidth) {
  return Math.max(700, Math.min(Math.ceil(sidebarWidth) + 329, 749));
}

/** The first window width at which the sidebar is a column again. */
export const collapseWidth = (sidebarWidth?: number) =>
  collapseThreshold(sidebarWidth) + 1;

/**
 * Below this width the web app's sidebar is the phone sheet that covers the
 * screen (95-web.css); from it up to the collapse line, a collapsed sidebar
 * opens as the peek panel over the page.
 */
export const webSheetWidth = 640;

export type SidebarVisibility = {
  /** The user's choice at normal widths. */
  userOpen: boolean;
  /** At or under the collapse line: the sidebar is not a column. */
  narrow: boolean;
  /** Narrow and on a phone's width: the sidebar opens as a sheet. */
  phone: boolean;
  /**
   * Opened by the user while narrow (the sheet, or the peek above a phone's
   * width); forgotten when the width changes band.
   */
  narrowOpen: boolean;
};

const bands = (
  width: number,
  sidebarWidth?: number,
  web = surface === "web",
) => {
  const narrow = width <= collapseThreshold(sidebarWidth);
  return { narrow, phone: narrow && web && width < webSheetWidth };
};

export const initialVisibility = (
  width: number,
  sidebarWidth?: number,
  web?: boolean,
  userOpen = true,
): SidebarVisibility => ({
  userOpen,
  ...bands(width, sidebarWidth, web),
  narrowOpen: false,
});

/**
 * The sidebar shows in the layout: as a column, or as the phone's sheet.
 * Narrower than the line but wider than a phone it never takes room; it
 * opens as the peek instead (`peekRequested`).
 */
export const sidebarOpen = (state: SidebarVisibility) =>
  state.narrow ? state.phone && state.narrowOpen : state.userOpen;

/** The toggle asked for the peek: narrow, above a phone's width. */
export const peekRequested = (state: SidebarVisibility) =>
  state.narrow && !state.phone && state.narrowOpen;

export const toggleVisibility = (
  state: SidebarVisibility,
): SidebarVisibility =>
  state.narrow
    ? { ...state, narrowOpen: !state.narrowOpen }
    : { ...state, userOpen: !state.userOpen };

export const showSidebar = (state: SidebarVisibility): SidebarVisibility =>
  sidebarOpen(state) || peekRequested(state) ? state : toggleVisibility(state);

/**
 * Crossing the line collapses (or restores the user's choice); so does a
 * sidebar width that moves the line past the window.
 */
export function resizeVisibility(
  state: SidebarVisibility,
  width: number,
  sidebarWidth?: number,
  web?: boolean,
): SidebarVisibility {
  const next = bands(width, sidebarWidth, web);
  return next.narrow === state.narrow && next.phone === state.phone
    ? state
    : { ...state, ...next, narrowOpen: false };
}
