import type { CodeEffort } from "../../../shared/types";
import { codeEffortLevels } from "../../../shared/code-effort";

/** One layer of the rolling heading label of the Code effort panel. */
export type LabelLayer = {
  id: number;
  level: CodeEffort;
  phase: "steady" | "in" | "out";
  direction: "up" | "down";
};

/**
 * Label layers after the previewed level changes. Claude rolls the label on
 * every level change while the panel is open (2097af56), but not when it
 * opens. At most two layers show: the label being replaced rolls out while
 * the new one rolls in, and any older outgoing layer is dropped.
 */
export function rollLabel(
  current: LabelLayer[],
  level: CodeEffort,
  id: number,
  animate: boolean,
): LabelLayer[] {
  const shown = current.find((layer) => layer.phase !== "out");
  if (shown?.level === level && (animate || current.length === 1))
    return current;
  if (!animate || !shown)
    return [{ id, level, phase: "steady", direction: "up" }];
  const direction =
    codeEffortLevels.indexOf(level) > codeEffortLevels.indexOf(shown.level)
      ? "up"
      : "down";
  return [
    { ...shown, phase: "out", direction },
    { id, level, phase: "in", direction },
  ];
}

/**
 * Label layers once a layer's roll animation ends: an outgoing layer goes,
 * an incoming one settles. A layer runs several animations at once, so a
 * later end event for an already settled layer changes nothing.
 */
export function settleLabel(current: LabelLayer[], id: number) {
  const layer = current.find((item) => item.id === id);
  if (!layer || layer.phase === "steady") return current;
  if (layer.phase === "out") return current.filter((item) => item !== layer);
  return current.map((item) =>
    item === layer ? { ...item, phase: "steady" as const } : item,
  );
}
