import type { Item } from "./types";

/** Served captions. */
export function toolGroupCaption(items: Item[]) {
  let group: Item["display_group"];
  for (const item of items) {
    if (item.type === "reasoning") continue;
    const next = item.display_group;
    if (
      !next ||
      (group &&
        (group.run?.anchor_id ?? group.id) !== (next.run?.anchor_id ?? next.id))
    )
      return;
    group = next;
  }
  if (!group) return;
  const run = group.run;
  if (!run) return group.is_complete ? group.summary : undefined;
  if (run.state === "working")
    return run.summary_source === "worker_caption" ? run.summary : undefined;
  if (
    run.state === "failed" &&
    (run.status_text === undefined || run.status_text_lead === undefined)
  )
    return;
  return run.summary;
}
