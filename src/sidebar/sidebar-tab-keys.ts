/**
 * Next and Previous sidebar tab: on the desktop ⌘⌥→ and ⌘⌥← (Ctrl+Alt
 * elsewhere) move between the sidebar's mode tabs, Chat and Cowork | Code here.
 * The tab before the open one shows ⌘⌥← in its tooltip and the one after it
 * ⌘⌥→.
 */

/** The step a key press asks for: 1 next, -1 previous, 0 none. */
export function sidebarTabStep(
  press: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  mac: boolean,
): 1 | -1 | 0 {
  const mod = mac ? press.metaKey : press.ctrlKey;
  const other = mac ? press.ctrlKey : press.metaKey;
  if (!mod || other || !press.altKey || press.shiftKey) return 0;
  if (press.key === "ArrowRight") return 1;
  if (press.key === "ArrowLeft") return -1;
  return 0;
}

/** The tab a step lands on, or undefined at either end. */
export function sidebarTabTarget<T>(
  tabs: readonly T[],
  current: T,
  step: 1 | -1,
): T | undefined {
  const index = tabs.indexOf(current);
  if (index === -1) return undefined;
  return tabs[index + step];
}

/** A tab's tooltip keys: ⌘⌥← before the open tab, ⌘⌥→ after it. */
export function sidebarTabShortcut<T>(
  tabs: readonly T[],
  tab: T,
  current: T,
): string[] | undefined {
  const index = tabs.indexOf(tab);
  const open = tabs.indexOf(current);
  if (index === -1 || open === -1 || index === open) return undefined;
  return ["mod", "alt", index < open ? "←" : "→"];
}
