/**
 * How the file viewer fits a narrow window (R-0981, R-0982, R-1029). At
 * W969 the original keeps the sidebar open and the panel covers the whole
 * conversation column, with Close and without Expand (R-0981, R-0963); at
 * W602 the preview fills the window with no sidebar and no chat (R-1029).
 * The exact breakpoints were not measured: both sit between the captures.
 */

/**
 * Below this window width the viewer covers the conversation instead of
 * sharing the row with it (artifact-narrow.css repeats the value).
 */
export const artifactOverlayWidth = 1000;

/** Below this window width, opening the viewer collapses the sidebar. */
export const artifactCollapseWidth = 720;

/** Whether opening the viewer at this width should collapse the sidebar. */
export const collapsesSidebar = (width: number, sidebarOpen: boolean) =>
  sidebarOpen && width < artifactCollapseWidth;

/**
 * Whether closing the viewer brings the sidebar back: only when opening it
 * collapsed the sidebar and the user has not reopened it in between.
 */
export const restoresSidebar = (collapsed: boolean, sidebarOpen: boolean) =>
  collapsed && !sidebarOpen;

/** Whether the viewer covers the conversation at this window width. */
export const coversConversation = (width: number) =>
  width < artifactOverlayWidth;
