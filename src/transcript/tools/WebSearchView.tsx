import { useId } from "react";
import { Globe2, ChevronRight } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import type { Item } from "../../../shared/types";
import type { WebSource } from "../../../shared/research";
import { itemIsRunning } from "../../../shared/activity";
import { cleanWebSource } from "../../../shared/gateway-signals";
import { sourceKey } from "../../../shared/research";
import { useOpenLink } from "../../ui/ExternalLinks";
import { ActivityMark } from "../TurnActivity";
import { sourceHost } from "../../citations/citations";
import { SiteIcon } from "../../citations/SiteIcon";
import { WebFetchError } from "./WebFetchError";
import { isWebFetch } from "../../../shared/web-fetch-item";
import { WebFetchRow } from "./WebFetchRow";
import { formatText, t } from "../../i18n";

/**
 * A web search the model ran (R5, design R45 §4.5): "Searching the web" and the
 * query while it runs; once done "Searched the web" and the query, which opens
 * to the pages it read (site icon, title, host; a click opens the page through
 * the app's external link confirmation). Consecutive searches share one row
 * with a result count and a shared list of sources. grok's X searches read
 * "Searched X". When the search service returned no page list (an older
 * transcript, or a service without it) the row lists the queries as before,
 * without a result count.
 */

type WebSearchAction =
  | { type: "search"; query?: string | null; queries?: string[] | null }
  | { type: "openPage"; url?: string | null }
  | { type: "findInPage"; url?: string | null; pattern?: string | null }
  | { type: "other" };

/** A search (not opening or searching within a page), which may share a row. */
export function isSearchItem(item: Item | undefined) {
  if (item?.type !== "webSearch") return false;
  const action = item.action as WebSearchAction | undefined;
  return action?.type !== "openPage" && action?.type !== "findInPage";
}

/** The queries of one search, without repeats. */
export function searchQueries(item: Item): string[] {
  const action = item.action as WebSearchAction | undefined;
  const queries =
    action?.type === "search"
      ? [...(action.queries ?? []), ...(action.query ? [action.query] : [])]
      : [];
  const all = queries.length
    ? queries
    : ([item.query].filter(Boolean) as string[]);
  return [...new Set(all.filter((query) => typeof query === "string"))];
}

/** The pages a search returned, cleaned and without repeats. */
export function searchSources(item: Item): WebSource[] {
  if (!Array.isArray(item.sources)) return [];
  const seen = new Set<string>();
  const sources: WebSource[] = [];
  for (const value of item.sources) {
    const source = cleanWebSource(value);
    const key = source && sourceKey(source.url);
    if (!source || !key || seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  return sources;
}

const failed = (item: Item) =>
  item.lifecycleStatus === "failed" || item.status === "failed";

/**
 * Whether a search continues the previous one's row: both are searches of the
 * same kind (web or X) and neither failed.
 */
export function searchesJoin(previous: Item | undefined, item: Item) {
  return (
    !!previous &&
    isSearchItem(previous) &&
    isSearchItem(item) &&
    !failed(previous) &&
    !failed(item) &&
    (previous.searchTool === "x_search") === (item.searchTool === "x_search")
  );
}

function PageDetails({ item }: { item: Item }) {
  const action = item.action as WebSearchAction;
  const openLink = useOpenLink();
  const url = "url" in action && action.url ? action.url : undefined;
  const pattern =
    action.type === "findInPage" && action.pattern ? action.pattern : undefined;
  const host = url ? sourceHost(url) : undefined;
  const running = itemIsRunning(item);
  return (
    <details
      className={`activity web-search-activity ${failed(item) ? "failed" : ""}`}
    >
      <summary>
        {running ? <ActivityMark phase="tools" /> : <Globe2 size={15} />}
        <span>
          {action.type === "openPage"
            ? running
              ? "Opening a page"
              : "Opened a page"
            : running
              ? "Searching within a page"
              : "Searched within a page"}
        </span>
        <WebFetchError item={item} />
        <ChevronRight size={13} />
      </summary>
      <div className="activity-body web-search-detail">
        {pattern && <div>{pattern}</div>}
        {url && host ? (
          <a
            className="web-search-result"
            href={url}
            title={url}
            onClick={(event) => {
              event.preventDefault();
              openLink(url);
            }}
          >
            <SiteIcon host={host} fallback={<Globe2 size={16} />} />
            <span className="web-search-result-title">{url}</span>
          </a>
        ) : (
          url && <div>{url}</div>
        )}
      </div>
    </details>
  );
}

export function ResultRows({ sources }: { sources: WebSource[] }) {
  const openLink = useOpenLink();
  const labelId = useId();
  return (
    <div className="web-search-results" data-testid="result-list-box">
      <div id={labelId} className="web-search-results-label">
        {t("Results")}
      </div>
      <div
        role="list"
        aria-labelledby={labelId}
        className="web-search-results-list"
      >
        {sources.map((source) => {
          const host = sourceHost(source.url) ?? source.url;
          return (
            <div
              role="listitem"
              className="web-search-result-item"
              key={source.url}
            >
              <a
                className="web-search-result"
                href={source.url}
                title={source.url}
                onClick={(event) => {
                  event.preventDefault();
                  openLink(source.url);
                }}
              >
                <SiteIcon host={host} fallback={<Globe2 size={16} />} />
                <span className="web-search-result-title">
                  {source.title ?? source.url}
                </span>
                <span className="web-search-result-host">
                  <bdi>{host}</bdi>
                </span>
                <ChevronRight
                  size={12}
                  className="web-search-result-caret"
                  aria-hidden="true"
                />
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One search, or a run of consecutive searches. The row is the first item's;
 * `items` defaults to it alone.
 */
export function WebSearchView({
  item,
  items,
  code = false,
}: {
  item: Item;
  items?: Item[];
  /** Code says "Searched web …"; Chat "Searched the web …". */
  code?: boolean;
}) {
  if (isWebFetch(item)) return <WebFetchRow item={item} />;
  if (!isSearchItem(item)) return <PageDetails item={item} />;
  const run = items?.length ? items : [item];
  const running = run.some(itemIsRunning);
  const stopped =
    !running && run.some((search) => search.lifecycleStatus === "interrupted");
  const x = run.every((search) => search.searchTool === "x_search");
  const where = x ? "X" : code ? "web" : "the web";
  const groups = run.map((search) => ({
    id: String(search.id),
    queries: searchQueries(search),
    sources: searchSources(search),
  }));
  const pages = new Map(
    groups.flatMap((group) =>
      group.sources.map((source) => [sourceKey(source.url), source] as const),
    ),
  );
  const listed = run.some((search) => Array.isArray(search.sources));
  if (!running && !stopped && run.every(failed))
    return (
      <div
        className="activity web-search-activity failed web-search-failed"
        role="status"
      >
        <div className="web-search-summary">
          <AppIcon name="Warning" size={15} />
          <span>{x ? "X search failed" : "Failed to search the web"}</span>
        </div>
      </div>
    );
  const lastQuery = [...groups].reverse().find((group) => group.queries.length)
    ?.queries[0];
  const sources = [...pages.values()];
  const count = sources.length;
  const hasBody = listed
    ? count > 0
    : groups.some((group) => group.queries.length);
  return (
    <details className="activity web-search-activity">
      <summary>
        {/* A running tool row carries the four-dot mark as commands and
           connector calls do. */}
        {running ? <ActivityMark phase="tools" /> : <Globe2 size={15} />}
        <span className="web-search-title">
          {running
            ? `Searching ${where}`
            : stopped
              ? x
                ? "Stopped searching X"
                : "Stopped searching the web"
              : `Searched ${where}`}
        </span>
        {/* Result count. */}
        {!listed && lastQuery ? (
          <small className="web-search-meta">{lastQuery}</small>
        ) : (
          listed && (
            <small data-result-count className="web-search-meta">
              {count === 1
                ? t("1 result")
                : formatText("{count} results", { count })}
            </small>
          )
        )}
        {hasBody && <ChevronRight size={13} />}
      </summary>
      {hasBody && (
        <div className="activity-body web-search-detail">
          {listed ? (
            <ResultRows sources={sources} />
          ) : (
            [...new Set(groups.flatMap((group) => group.queries))].map(
              (query, index) => <div key={`${index}-${query}`}>{query}</div>,
            )
          )}
        </div>
      )}
    </details>
  );
}
