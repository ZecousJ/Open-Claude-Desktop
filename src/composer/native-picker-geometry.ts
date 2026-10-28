/** 1016 shared-frame z0: maxVisibleItems * max(control, body leading),
 * plus menu gutter + 0.25 source rem for a popup with a header.
 * Source comfortable rem is 16px; this app's root rem differs, so the
 * corresponding physical token is defined on the native popup itself.
 */
export function nativePickerBodyLimit(
  popup: HTMLElement,
  availableHeight: number,
  chromeHeight: number,
  computed = typeof getComputedStyle === "function"
    ? getComputedStyle(popup)
    : undefined,
) {
  const token = (name: string, fallback: number) => {
    const value = Number.parseFloat(computed?.getPropertyValue(name) ?? "");
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
  };
  const cap =
    6 *
      Math.max(token("--cds-h-control", 32), token("--cds-leading-body", 20)) +
    token("--cds-menu-gutter", 4) +
    token("--native-picker-quarter-rem", 4);
  return Math.max(0, Math.min(cap, availableHeight - chromeHeight));
}
