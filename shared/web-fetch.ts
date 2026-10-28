import type { Item } from "./types";
import { isWebFetch } from "./web-fetch-item";

/** Fetch failures. */
export const webFetchErrors: Record<string, string> = {
  INVALID_URL: "The URL provided is invalid",
  URL_NOT_FOUND: "Could not find this URL",
  RATE_LIMIT_EXCEEDED:
    "Access to this website has been restricted due to rate limits",
  ROBOTS_DISALLOWED: "This website has blocked Claudex via robots.txt rules",
  URL_TOO_LONG: "The URL provided is too long",
  EGRESS_BLOCKED: "Access to this website is blocked",
  SITE_BLOCKED: "Access to this website is blocked",
  PERMISSIONS_ERROR:
    "The URL was not provided by the user nor was it contained in any web search/fetch results",
  UNKNOWN_ERROR: "An unknown error occurred",
  SERVER_ERROR: "An unknown error occurred",
  CLIENT_ERROR: "An unknown error occurred",
};

export function webFetchError(item: Item): string | undefined {
  if (!isWebFetch(item)) return;
  const findCode = (value: unknown, depth = 0): string | undefined => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (Object.hasOwn(webFetchErrors, value)) return value;
      try {
        return findCode(JSON.parse(value), depth + 1);
      } catch {
        return;
      }
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const code = findCode(entry, depth + 1);
        if (code) return code;
      }
    } else if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["error_type", "code", "error", "content", "text"]) {
        const code = findCode(record[key], depth + 1);
        if (code) return code;
      }
    }
  };
  const code =
    findCode(item.error) ??
    findCode(item.result) ??
    findCode(item.contentItems);
  return code
    ? webFetchErrors[code]
    : item.lifecycleStatus === "failed" ||
        item.status === "failed" ||
        item.success === false ||
        item.result?.is_error === true
      ? webFetchErrors.UNKNOWN_ERROR
      : undefined;
}
