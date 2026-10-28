import path from "node:path";
import { type BrowserTabState, newTabTitle } from "../../shared/browser";

/** A page Claude opens before the panel was ever shown gets this size. */
export const defaultPageSize = { width: 1024, height: 768 } as const;

export function blankTabState(id: string): BrowserTabState {
  return {
    id,
    url: "",
    title: newTabTitle,
    loading: false,
    stalled: false,
    canGoBack: false,
    canGoForward: false,
  };
}

export const faviconLimit = 64 * 1024;

export function hostOf(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:"
      ? path.basename(decodeURIComponent(parsed.pathname))
      : parsed.host;
  } catch {
    return "";
  }
}
