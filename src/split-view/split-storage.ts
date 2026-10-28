import {
  MAX_COLUMNS,
  rowSplitLimits,
  columnCount,
  normalize,
} from "./split-layout";
import type { PaneEntry } from "./split-layout";

/** What is kept between launches: the panes that hold sessions and the sizes. */
export interface SavedSplit {
  panes: { key: string; id: string; col: number; row: number }[];
  weights?: number[];
  rowSplit?: number;
}

export function saveSplit(
  panes: readonly PaneEntry[],
  weights: readonly number[] | undefined,
  rowSplit: number,
): SavedSplit {
  const sessions = normalize(panes.filter((p) => p.ref.kind === "session"));
  return {
    panes: sessions.flatMap((p) =>
      p.ref.kind === "session"
        ? [{ key: p.key, id: p.ref.id, col: p.pos.col, row: p.pos.row }]
        : [],
    ),
    // The sizes belong to the columns as they were; with drafts left out
    // the column count may differ, and then they start equal again.
    ...(weights && columnCount(sessions) === weights.length
      ? { weights: [...weights] }
      : {}),
    rowSplit,
  };
}

/** Reads what `saveSplit` wrote; anything unreadable gives no panes. */
export function loadSplit(raw: unknown): {
  panes: PaneEntry[];
  weights?: number[];
  rowSplit: number;
} {
  const value = (raw ?? {}) as Partial<SavedSplit>;
  const seen = new Set<string>();
  const panes: PaneEntry[] = [];
  if (Array.isArray(value.panes))
    for (const item of value.panes) {
      if (
        !item ||
        typeof item.key !== "string" ||
        typeof item.id !== "string" ||
        !Number.isInteger(item.col) ||
        !(item.row === 0 || item.row === 1) ||
        item.col < 0 ||
        item.col >= MAX_COLUMNS ||
        seen.has(item.id)
      )
        continue;
      seen.add(item.id);
      panes.push({
        key: item.key,
        ref: { kind: "session", id: item.id },
        pos: { col: item.col, row: item.row },
      });
    }
  const tidy = normalize(panes);
  const weights =
    Array.isArray(value.weights) &&
    value.weights.length === columnCount(tidy) &&
    value.weights.every((w) => typeof w === "number" && w > 0)
      ? [...value.weights]
      : undefined;
  const rowSplit =
    typeof value.rowSplit === "number" &&
    value.rowSplit >= rowSplitLimits.min &&
    value.rowSplit <= rowSplitLimits.max
      ? value.rowSplit
      : rowSplitLimits.default;
  return { panes: tidy, ...(weights ? { weights } : {}), rowSplit };
}
