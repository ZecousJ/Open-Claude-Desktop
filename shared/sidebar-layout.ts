export const defaultSidebarWidth = 288;
export const minimumSidebarWidth = 200;
export const maximumSidebarWidth = 420;
export const minimumWorkspaceWidth = 420;
export function fitSidebarWidth(value: number, viewportWidth: number) {
  return Math.max(
    minimumSidebarWidth,
    Math.min(
      maximumSidebarWidth,
      viewportWidth - minimumWorkspaceWidth,
      Math.round(value),
    ),
  );
}

/**
 * Dragging the handle under half the minimum width collapses the sidebar;
 * dragging back past it keeps it.
 */
export const dragHidesSidebar = (rawWidth: number) =>
  rawWidth < minimumSidebarWidth / 2;
