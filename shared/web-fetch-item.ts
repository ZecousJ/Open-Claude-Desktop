import type { Item } from "./types";

export function isWebFetch(item: Item) {
  return (
    (item.type === "webSearch" && item.action?.type === "openPage") ||
    ["web_fetch", "WebFetch"].includes(item.tool ?? "")
  );
}

/** Fetch result titles. */
export function webFetchPage(item: Item) {
  const input = item.arguments ?? item.input;
  const url =
    [item.action?.url, input?.url].find(
      (value): value is string => typeof value === "string" && !!value,
    ) ?? "";
  const findTitle = (value: unknown, depth = 0): string | undefined => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      try {
        return findTitle(JSON.parse(value), depth + 1);
      } catch {
        return;
      }
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const title = findTitle(entry, depth + 1);
        if (title) return title;
      }
    } else if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.title === "string" && record.title) return record.title;
      for (const key of ["content", "text", "structuredContent"]) {
        const title = findTitle(record[key], depth + 1);
        if (title) return title;
      }
    }
  };
  const title =
    findTitle(item.result) ??
    findTitle(item.contentItems) ??
    item.sources?.find((source) => source.url === url)?.title ??
    url;
  let hostname: string | undefined;
  try {
    hostname = new URL(url).hostname;
  } catch {}
  return { url, title, hostname };
}
