import type { Conversation } from "../../../shared/types";
import { formatText } from "../../i18n";

/**
 * Runs one request per id in order. A failure does not stop the rest, so the
 * caller can keep only the rows that failed selected and report them once.
 */
export async function runEach(
  ids: readonly string[],
  run: (id: string) => Promise<void>,
): Promise<{ failed: string[]; error?: unknown }> {
  const failed: string[] = [];
  let error: unknown;
  for (const id of ids) {
    try {
      await run(id);
    } catch (e) {
      if (!failed.length) error = e;
      failed.push(id);
    }
  }
  return failed.length ? { failed, error } : { failed };
}

/** "Couldn't archive 2 of 5 chats: <first error>". */
export function bulkFailure(
  verb: string,
  noun: string,
  failed: number,
  total: number,
  error?: unknown,
) {
  const reason =
    error instanceof Error ? error.message : error ? String(error) : "";
  const count =
    total === 1
      ? `the ${noun}`
      : failed === total
        ? `${total} ${noun}s`
        : `${failed} of ${total} ${noun}s`;
  return `Couldn't ${verb} ${count}${reason ? `: ${reason}` : "."}`;
}
/** Mixed selections prefer Unpin and Mark as read. */
export function selectionActions(
  rows: readonly Conversation[],
  approvalIds: ReadonlySet<string> = new Set(),
) {
  const active = rows.filter((row) => row.mode !== "code" && !row.archived);
  const pinned = active.filter((row) => row.pinned);
  const readable = rows.filter(
    (row) =>
      row.mode !== "code" &&
      !row.incognito &&
      !approvalIds.has(row.id) &&
      !row.turns.some((turn) => turn.status === "inProgress"),
  );
  const unread = readable.filter((row) => row.unread);
  const movable = rows.filter((row) => !row.incognito);
  const projects = new Set(movable.map((row) => row.projectId));
  return {
    pinned: pinned.length > 0,
    pin: pinned.length ? pinned : active.filter((row) => !row.incognito),
    unread: unread.length > 0,
    read: unread.length
      ? unread
      : readable.filter((row) => row.mode === "cowork" || row.turns.length > 0),
    movable,
    project: projects.size === 1 && Boolean(movable[0]?.projectId),
  };
}

/** Counted result notices. */
export function bulkResultMessages(
  action: "archive" | "unarchive" | "delete",
  total: number,
  failed: number,
) {
  const success = {
    archive: ["1 item archived", "{count} items archived"],
    unarchive: ["1 item unarchived", "{count} items unarchived"],
    delete: ["1 item deleted", "{count} items deleted"],
  }[action];
  const failure = {
    archive: [
      "1 item could not be archived.",
      "{count} items could not be archived.",
    ],
    unarchive: [
      "1 item could not be unarchived.",
      "{count} items could not be unarchived.",
    ],
    delete: [
      "1 item could not be deleted.",
      "{count} items could not be deleted.",
    ],
  }[action];
  return [
    ...(total > failed
      ? [
          formatText(success[total - failed === 1 ? 0 : 1], {
            count: total - failed,
          }),
        ]
      : []),
    ...(failed
      ? [formatText(failure[failed === 1 ? 0 : 1], { count: failed })]
      : []),
  ];
}
