/**
 * Settings search. Every page exports `searchLabels`: the labels of the rows
 * and sections it can show, as they read on the page. `pages.ts` collects them;
 * the search field ranks the pages and rows that match (as the original's does)
 * and opening one scrolls to the matching row.
 */
import type { TabId } from "../nav";

export type SearchIndex = Partial<Record<TabId, readonly string[]>>;

/** Search keys. */
export function settingsSearchKey(
  key: string,
  query: string,
  composing = false,
) {
  if (composing || !query.trim()) return undefined;
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Enter":
      return "select";
    case "Escape":
      return "dismiss";
    case "Tab":
      return "leave";
    default:
      return undefined;
  }
}

/**
 * One line of the result list: a page (with the row to scroll to when a row,
 * not the page's name, was what matched), a row listed under its page, or
 * the "+N more" line closing a page's rows.
 */
export interface SearchHit {
  kind: "page" | "child" | "more";
  tab: TabId;
  row?: string;
  /** How many more matching rows a "more" line stands for. */
  count?: number;
}

/** The most rows listed under a page. */
const MAX_CHILD_ROWS = 3;

/**
 * Words a page is also found by when neither its name nor a row matches.
 * Connectors is also found by "tools".
 */
export const pageKeywords: Partial<Record<TabId, readonly string[]>> = {
  capabilities: ["features", "abilities", "permissions"],
  chrome: ["extension", "browser"],
  connectors: ["mcp", "integrations", "tools"],
  extensions: ["mcp"],
  plugins: ["marketplace", "extensions"],
  skills: ["custom instructions", "agent skills"],
  usage: ["overage", "extra usage", "spend limit", "usage credits"],
};

/**
 * Other ways to ask for a row. A phrase counts when it equals, starts with or
 * has every typed word at a word start, and ranks below a match on the label.
 */
export const rowPhrases: Readonly<Record<string, readonly string[]>> = {
  "Output style": ["concise", "terse", "brief", "response style"],
  "Interface font": ["UI font"],
  "Transcript text size": ["font size", "bigger text", "larger text"],
  "Transcript width": ["line width", "line length", "column width"],
  "Code font": ["monospace", "editor font"],
};

/** Lower case, straight quotes, single spaces: "Can’t" finds "can't". */
export function searchText(text: string) {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

/** Every word of the query, lower case. */
function queryWords(query: string) {
  return searchText(query).split(" ").filter(Boolean);
}

const squash = (text: string) => text.replace(/ /g, "");

/**
 * How well `text` answers a query, as the original ranks it: 0 equal, 1
 * starts with it, 2 every word starts a word of the text, 3 every word is
 * somewhere in it, -1 no match. Spaces do not count ("logout" finds "log out").
 */
export function rankText(text: string, query: string) {
  const wanted = searchText(query);
  const wantedFlat = squash(wanted);
  const own = searchText(text);
  const ownFlat = squash(own);
  if (ownFlat === wantedFlat) return 0;
  if (ownFlat.startsWith(wantedFlat)) return 1;
  const words = wanted.split(" ");
  if (!words.every((word) => ownFlat.includes(word))) return -1;
  const parts = own.split(" ");
  const tails = parts.map((_, at) => parts.slice(at).join(""));
  return words.every((word) => tails.some((tail) => tail.startsWith(word)))
    ? 2
    : 3;
}

/** The rows of a page the query matches, best first; a phrase match ranks 4. */
function rankedRows(labels: readonly string[], query: string) {
  const seen = new Set<string>();
  return labels
    .flatMap((row) => {
      const own = rankText(row, query);
      if (own >= 0) return [{ row, rank: own }];
      const phrase = (rowPhrases[row] ?? []).some((text) => {
        const rank = rankText(text, query);
        return rank >= 0 && rank <= 2;
      });
      return phrase ? [{ row, rank: 4 }] : [];
    })
    .sort((a, b) => a.rank - b.rank)
    .filter(({ row }) => !seen.has(row) && seen.add(row));
}

/**
 * Which of a page's shown row labels a search result means: the row with
 * the result's label, else the first whose label has every typed word (a
 * row can read differently per account, e.g. Delete account); -1 for none.
 */
export function matchingRow(
  shown: readonly string[],
  row: string,
  query: string,
) {
  const wanted = searchText(row);
  const exact = shown.findIndex((label) => searchText(label) === wanted);
  if (exact >= 0) return exact;
  const words = queryWords(query);
  if (!words.length) return -1;
  return shown.findIndex((label) => {
    const text = searchText(label);
    return words.every((word) => text.includes(word));
  });
}

/**
 * The lines of the result list for `query` (the original's settings search):
 * pages whose name matches come first, then pages found by a row, then
 * pages found by a keyword. A page whose name matched lists up to three
 * matching rows under it and "+N more" for the rest; a page found by rows
 * shows the one row, or itself with its rows when several match. A row
 * already shown for an earlier page (Thinking effort sits on two) is not
 * listed again. An empty query lists every page.
 */
export function searchSettings(
  query: string,
  pages: readonly { id: TabId; label: string }[],
  index: SearchIndex,
): SearchHit[] {
  const flat = squash(searchText(query));
  if (!flat) return pages.map((page) => ({ kind: "page", tab: page.id }));
  // One letter lists a page's first matching row only, never its rows.
  const withRows = flat.length >= 2;
  const found = pages.flatMap((page) => {
    const name = rankText(page.label, query);
    const rows = rankedRows(index[page.id] ?? [], query);
    if (name >= 0) return [{ tab: page.id, score: name, named: true, rows }];
    if (rows.length)
      return [{ tab: page.id, score: 5 + rows[0].rank, named: false, rows }];
    const keyword = (pageKeywords[page.id] ?? []).some((word) =>
      squash(searchText(word)).includes(flat),
    );
    return keyword ? [{ tab: page.id, score: 10, named: false, rows }] : [];
  });
  found.sort((a, b) => a.score - b.score);
  const shown = new Set<string>();
  const hits: SearchHit[] = [];
  const listRows = (tab: TabId, rows: readonly { row: string }[]) => {
    for (const { row } of rows.slice(0, MAX_CHILD_ROWS)) {
      shown.add(row);
      hits.push({ kind: "child", tab, row });
    }
    const rest = rows.length - MAX_CHILD_ROWS;
    if (rest > 0) hits.push({ kind: "more", tab, count: rest });
  };
  for (const { tab, named, rows } of found) {
    const fresh = rows.filter(({ row }) => !shown.has(row));
    if (named) {
      hits.push({ kind: "page", tab });
      if (withRows) listRows(tab, fresh);
    } else if (!rows.length) {
      hits.push({ kind: "page", tab });
    } else if (!withRows) {
      if (!shown.has(rows[0].row)) {
        shown.add(rows[0].row);
        hits.push({ kind: "page", tab, row: rows[0].row });
      }
    } else if (fresh.length === 1) {
      shown.add(fresh[0].row);
      hits.push({ kind: "page", tab, row: fresh[0].row });
    } else if (fresh.length > 1) {
      hits.push({ kind: "page", tab });
      listRows(tab, fresh);
    }
  }
  return hits;
}
