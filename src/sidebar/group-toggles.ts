/**
 * Collapse all / Expand all for a group heading's menu. They act on every
 * heading in the list that collapses: the Pinned and Recents headings and
 * Code's group headings, each a button marked `data-group-toggle` with its
 * `aria-expanded`. A heading inside a section that is closing (`inert`) is left
 * alone.
 */

export type GroupToggleState = "expanded" | "collapsed";

/** The headings in the list that are open (or shut). */
export function groupToggles(
  list: ParentNode | null | undefined,
  state: GroupToggleState,
): HTMLElement[] {
  return Array.from(
    list?.querySelectorAll<HTMLElement>(
      `[data-group-toggle][aria-expanded="${state === "expanded"}"]`,
    ) ?? [],
  ).filter((toggle) => toggle.closest("[inert]") === null);
}

/** On screen: a browser without checkVisibility counts every heading as shown. */
const shown = (element: Element) =>
  element.isConnected &&
  element.closest("[inert]") === null &&
  (element as { checkVisibility?: () => boolean }).checkVisibility?.() !==
    false;

/**
 * Which of the two the menu offers: Collapse all while a heading on screen
 * is open, Expand all while any heading is shut.
 */
export function groupViewOptions(list: ParentNode | null | undefined) {
  return {
    canCollapse: groupToggles(list, "expanded").some(shown),
    canExpand: groupToggles(list, "collapsed").length > 0,
  };
}

/**
 * Presses every heading in the given state, which turns it over. Inner
 * headings go first, so a section closing around them (and turning inert)
 * cannot leave them unpressed.
 */
export function toggleGroups(
  list: ParentNode | null | undefined,
  state: GroupToggleState,
) {
  for (const toggle of groupToggles(list, state).reverse()) toggle.click();
}

/**
 * Collapse all. The heading the menu was opened from may go with its
 * section; focus then moves to the last heading above it that is still on
 * screen, unless the person has put it somewhere else.
 */
export function collapseAllGroups(
  list: ParentNode | null | undefined,
  opener: HTMLElement | null,
  nextFrame: (run: () => void) => void = (run) =>
    void requestAnimationFrame(run),
) {
  // The headings before the opener in document order.
  const above: HTMLElement[] = [];
  if (opener?.isConnected && list)
    for (const element of Array.from(list.querySelectorAll<HTMLElement>("*"))) {
      if (element === opener) break;
      if (element.hasAttribute("data-group-toggle")) above.push(element);
    }
  toggleGroups(list, "expanded");
  if (!opener) return;
  const document = opener.ownerDocument;
  nextFrame(() => {
    const focused = document.activeElement ?? null;
    const elsewhere =
      focused !== null &&
      focused !== document.body &&
      focused.closest('[role="menu"]') === null &&
      shown(focused);
    if (!shown(opener) && !elsewhere)
      above.filter(shown).at(-1)?.focus({ preventScroll: true });
  });
}
