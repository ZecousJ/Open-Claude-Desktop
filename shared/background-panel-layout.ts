/**
 * The default rail is 282px at a 1164px window, so the narrowest gesture stop
 * sits below it.
 */
export const minimumBackgroundPanelWidth = 260;
export const defaultBackgroundPanelWidth = 282;
export const maximumBackgroundPanelWidth = 620;
export const minimumConversationWidth = 260;
/** Contract the minimum rail only when the available conversation layout is very narrow. */
export function minimumPanelWidthForLayout(layoutWidth: number) {
  return Math.min(
    minimumBackgroundPanelWidth,
    Math.max(220, Math.floor(layoutWidth - minimumConversationWidth)),
  );
}
export function fitBackgroundPanelWidth(width: number, layoutWidth: number) {
  const floor = minimumPanelWidthForLayout(layoutWidth);
  const ceiling = Math.max(
    floor,
    Math.min(
      maximumBackgroundPanelWidth,
      Math.floor(layoutWidth - minimumConversationWidth),
    ),
  );
  return Math.round(
    Math.max(floor, Math.min(ceiling, Number.isFinite(width) ? width : floor)),
  );
}
