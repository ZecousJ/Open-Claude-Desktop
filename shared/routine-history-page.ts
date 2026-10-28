import type { RoutineRunPage, RoutineRunQuery } from "./routines";
import type { RoutineRun } from "./routine-labels";

const invalidCursor =
  "This history page couldn’t be loaded. Refresh and try again.";
const changedHistory = "Run history changed. Refresh to load it again.";

function cursorFor(taskId: string, runId: string) {
  const bytes = new TextEncoder().encode(JSON.stringify([taskId, runId]));
  return (
    "r1." +
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  );
}

function afterRun(taskId: string, cursor: string) {
  try {
    if (!/^r1\.[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 8192)
      throw new Error(invalidCursor);
    const bytes = Uint8Array.from(
      atob(cursor.slice(3).replace(/-/g, "+").replace(/_/g, "/")),
      (char) => char.charCodeAt(0),
    );
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value[0] !== taskId ||
      typeof value[1] !== "string" ||
      !value[1]
    )
      throw new Error(invalidCursor);
    if (cursorFor(taskId, value[1]) !== cursor) throw new Error(invalidCursor);
    return value[1];
  } catch {
    throw new Error(invalidCursor);
  }
}

/** Runs already stored newest-first. An ID anchor survives new runs being
 * inserted above it; an expired anchor is an explicit refresh error. */
export function pageRoutineRuns(
  taskId: string,
  runs: RoutineRun[],
  query: RoutineRunQuery = {},
): RoutineRunPage {
  if (!query || typeof query !== "object" || Array.isArray(query))
    throw new Error(invalidCursor);
  const limit = query.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Choose a history page size from 1 to 100.");
  let start = 0;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string") throw new Error(invalidCursor);
    const runId = afterRun(taskId, query.cursor);
    const index = runs.findIndex((run) => run.id === runId);
    if (index < 0) throw new Error(changedHistory);
    start = index + 1;
  }
  const page = runs.slice(start, start + limit);
  return {
    runs: page,
    ...(start + page.length < runs.length && page.length
      ? { nextCursor: cursorFor(taskId, page[page.length - 1].id) }
      : {}),
  };
}
