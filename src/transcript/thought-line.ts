import type { Item } from "../../shared/types";

/** A reasoning summary's first heading or sentence. */
export function thoughtLine(item: Item) {
  const first = item.summary?.join("\n").trim().split("\n")[0]?.trim() ?? "";
  const heading = first.match(/^(?:\*\*([^*]+)\*\*|#{1,3} (.+))$/);
  let title = (heading?.[1] ?? heading?.[2] ?? first)
    .replace(/[*_`]/g, "")
    .trim();
  if (!heading) title = title.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? title;
  return title;
}
