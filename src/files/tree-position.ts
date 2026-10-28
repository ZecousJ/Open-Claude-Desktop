import { useSyncExternalStore } from "react";
import { usePaneSide } from "../app/pane-side";
import { t, tc } from "../i18n";

/**
 * Where the Files pane's tree and the Changes pane's file list sit: one setting
 * for both, Automatic by default, which puts them on the pane's outer side.
 */
export type TreePosition = "auto" | "left" | "right";
export const treePositions: readonly TreePosition[] = ["auto", "left", "right"];
export const treePositionLabels: Record<TreePosition, string> = {
  auto: "Automatic",
  left: "Left",
  right: "Right",
};
/** A position's label in the current language. */
export function treePositionText(position: TreePosition) {
  // "Left" and "Right" alone are the arrow keys' names in the catalogs.
  return position === "auto"
    ? t("Automatic")
    : position === "left"
      ? tc("side", "Left")
      : tc("side", "Right");
}
const key = "claudex.treePosition.v1";
const changed = "claudex-tree-position";
let memory: TreePosition | undefined;
const parse = (value: unknown): TreePosition =>
  value === "left" || value === "right" ? value : "auto";
function read(): TreePosition {
  if (memory) return memory;
  try {
    return parse(window.localStorage.getItem(key));
  } catch {
    return "auto";
  }
}
export function setTreePosition(value: TreePosition) {
  try {
    window.localStorage.setItem(key, value);
    memory = undefined;
  } catch {
    memory = value;
  }
  window.dispatchEvent(new window.Event(changed));
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === key) listener();
  };
  window.addEventListener(changed, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useTreePosition() {
  return useSyncExternalStore(subscribe, read, () => "auto" as const);
}
/** Whether the tree (or file list) is on the right, the setting resolved. */
export function treeOnRight(position: TreePosition, side: "left" | "right") {
  return position === "auto" ? side === "right" : position === "right";
}
export function useTreeOnRight() {
  return treeOnRight(useTreePosition(), usePaneSide());
}
