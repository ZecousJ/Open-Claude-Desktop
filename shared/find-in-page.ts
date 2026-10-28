/**
 * Find in page (Edit ▸ Find…, Cmd/Ctrl+F): a small bar at the top right of an
 * app window that searches the window's page with Chromium's own find
 * (`webContents.findInPage`). The bar is a page of its own laid over the window
 * (`find.html`, preload `electron/find-preload.ts`), so the text typed into it
 * is never one of the matches. Values from the original's find bar.
 *
 * The bar's bridge is `window.findBar` (FindBarBridge); it reaches only the
 * channels below, and the main process answers only the bar it opened.
 */

/**
 * The bar: 320 wide, 48 tall (40 at the compact density, while the window shows
 * Code), 12px from the window's top-right corner below its title bar.
 */
export const findBarSize = { width: 320, height: 48 };
export const findBarHeights = { compact: 40, comfortable: 48 } as const;
export type FindBarDensity = keyof typeof findBarHeights;
export const findBarOffset = 12;
/** Transparent room around the bar for its shadow. */
export const findBarPadding = { top: 8, x: 16, bottom: 24 };
/** Where the bar's row starts: 58 in the main window, 40 in others (2.37337.1 CMr). */
export const findBarTitleInset = 58;
export const findBarPopoutInset = 40;
/** How long typing rests before the page is searched. */
export const findDebounceMs = 250;
/** How long a search may take before it counts as no matches. */
export const findTimeoutMs = 5000;
/** The longest query the bar sends. */
export const findMaxLength = 1000;

const ideographic =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Whether a query is worth searching: three characters or more, or any
 * Chinese, Japanese or Korean character (one of those is a word).
 */
export function findable(query: string) {
  return query.length > 2 || ideographic.test(query);
}

/** The match count beside the field: "3/12", or nothing before a search. */
export function matchLabel(
  query: string,
  result: { active: number; total: number } | null,
) {
  return findable(query) && result ? `${result.active}/${result.total}` : "";
}

/** Where the bar's view goes in a window whose content is `width` wide. */
export function findBarBounds(
  width: number,
  top = findBarTitleInset,
  density: FindBarDensity = "comfortable",
) {
  return {
    x: Math.max(
      0,
      Math.round(width - findBarSize.width - findBarOffset - findBarPadding.x),
    ),
    y: top + findBarOffset - findBarPadding.top,
    width: findBarSize.width + findBarPadding.x * 2,
    height:
      findBarHeights[density] + findBarPadding.top + findBarPadding.bottom,
  };
}

export interface FindOptions {
  /** Search towards the end of the page (false: towards the start). */
  forward?: boolean;
  /** True starts a new search; false steps to the next match of the current one. */
  findNext: boolean;
}

export interface FindResult {
  /** The highlighted match, from 1; 0 with no matches. */
  active: number;
  total: number;
}

/** IPC channels between the bar and the main process. */
export const findChannels = {
  find: "find-in-page:find",
  stop: "find-in-page:stop",
  close: "find-in-page:close",
  /** Main → bar: focus and select the field (the bar was asked for again). */
  focus: "find-in-page:focus",
  /** Main → bar: step to the next (true) or previous (false) match. */
  step: "find-in-page:step",
  /** Main → bar: forget the query (the page navigated or the bar closed). */
  clear: "find-in-page:clear",
} as const;

/** What the bar's preload exposes as `window.findBar`. */
export interface FindBarBridge {
  find(query: string, options: FindOptions): Promise<FindResult>;
  stop(): Promise<void>;
  close(): Promise<void>;
  onFocus(callback: () => void): () => void;
  onStep(callback: (forward: boolean) => void): () => void;
  onClear(callback: () => void): () => void;
}
