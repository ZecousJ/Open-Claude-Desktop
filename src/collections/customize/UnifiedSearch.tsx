import { useEffect, useMemo, useRef, useState } from "react";
import { formatText, t } from "../../i18n";
import "./unified-search.css";

/**
 * Typed host cursor search with independent section continuations. An older
 * bridge retains a finite runtime/catalogue fallback: its Show more only
 * reveals loaded rows and never claims to fetch a next page.
 */
export type SearchKind = "skill" | "plugin" | "connector";

export interface SearchItem {
  key: string;
  kind: SearchKind;
  name: string;
  description?: string;
  /** Installed, added or configured: one of yours. */
  yours: boolean;
  open: () => void;
}

export type SearchPage = "skills" | "plugins" | "connectors";

import {
  catalogQuery,
  normalizeSearchText,
  searchDelay,
  matchingNames,
} from "./customize-list";
import type {
  CustomizeSearchHit,
  CustomizeSearchSection,
} from "../../../shared/customize-search";
import type { CustomizeSearchAdapter } from "./customize-search-adapter";
export {
  catalogQuery,
  normalizeSearchText,
  searchableLength,
  minimumCatalogQuery,
  searchDelay,
  matchingNames,
} from "./customize-list";
export interface SearchLoadState {
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

/** Rows a section shows before Show more, and the most a catalog returns. */
export const sectionRows = 5;
export const catalogCap = 50;

const pageOf: Record<SearchKind, SearchPage> = {
  skill: "skills",
  plugin: "plugins",
  connector: "connectors",
};
const pageNames: Record<SearchPage, string> = {
  skills: "Skills",
  plugins: "Plugins",
  connectors: "Connectors",
};
const kindNames: Record<SearchKind, string> = {
  skill: "Skill",
  plugin: "Plugin",
  connector: "Connector",
};

export function matchesQuery(item: SearchItem, query: string) {
  if (item.yours)
    return matchingNames([item], query, (row) => row.name).length > 0;
  const words = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  // Yours uses the official name-only Fuse matcher. Substring matching here
  // applies only to the finite catalogue fallback; host ranking stays on host.
  const text = normalizeSearchText(
    item.yours ? item.name : `${item.name} ${item.description ?? ""}`,
  );
  return words.every((word) => text.includes(word));
}

/** The result sections for a query on a page. */
export function searchSections(
  items: readonly SearchItem[],
  query: string,
  page: SearchPage,
) {
  const serverQuery = catalogQuery(query);
  const hits = items.filter((item) =>
    matchesQuery(item, item.yours ? query : serverQuery),
  );
  const yours = hits.filter(
    (item) => item.yours && (page !== "plugins" || item.kind === "plugin"),
  );
  const catalogs = serverQuery !== "";
  const addable = catalogs ? hits.filter((item) => !item.yours) : [];
  const inPage = addable.filter((item) => pageOf[item.kind] === page);
  const others = addable.filter((item) => pageOf[item.kind] !== page);
  return {
    yours,
    inPage: inPage.slice(0, catalogCap),
    more: others.slice(0, catalogCap),
    truncated: inPage.length > catalogCap || others.length > catalogCap,
    keepTyping: !catalogs,
  };
}

function Section({ label, items }: { label: string; items: SearchItem[] }) {
  const [shown, setShown] = useState(sectionRows);
  if (!items.length) return null;
  const visible = items.slice(0, shown);
  return (
    <section className="customize-section unified-section">
      <h2>
        {label}
        <span className="unified-count">{items.length.toLocaleString()}</span>
      </h2>
      <SearchRows items={visible} />
      {items.length > sectionRows && (
        <button
          type="button"
          className="unified-more"
          aria-label={formatText(
            shown < items.length
              ? "Show more: {section}"
              : "Show fewer: {section}",
            { section: label },
          )}
          onClick={() =>
            setShown(
              shown < items.length
                ? Math.min(items.length, shown + sectionRows * 2)
                : sectionRows,
            )
          }
        >
          {t(shown < items.length ? "Show more" : "Show fewer")}
        </button>
      )}
    </section>
  );
}

function SearchRows({ items }: { items: readonly SearchItem[] }) {
  return (
    <ul className="customize-rows">
      {items.map((item) => (
        <li key={item.key} className="customize-row">
          <button
            type="button"
            className="customize-row-main"
            onClick={item.open}
          >
            <span className="customize-row-text">
              <strong data-no-translate>{item.name}</strong>
              {item.description && (
                <span data-no-translate>{item.description}</span>
              )}
            </span>
            <span className="unified-kind">{t(kindNames[item.kind])}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function CursorSection({
  label,
  query,
  page,
  section,
  adapter,
  onOpen,
  report,
}: {
  label: string;
  query: string;
  page: SearchPage;
  section: CustomizeSearchSection;
  adapter: CustomizeSearchAdapter;
  onOpen?: (hit: CustomizeSearchHit) => void;
  report(status: CursorStatus): void;
}) {
  const lease = useMemo(() => ({}), [query, page, section, adapter]);
  const latest = useRef<typeof lease | undefined>(lease);
  latest.current = lease;
  const inflight = useRef<object | undefined>(undefined);
  const [state, setState] = useState<{
    lease: typeof lease;
    items: CustomizeSearchHit[];
    total: number;
    next?: string;
    loading: boolean;
    failed: boolean;
  }>({ lease, items: [], total: 0, loading: true, failed: false });
  const active = () => latest.current === lease && adapter.current();
  const load = async (cursor?: string) => {
    if (!active() || inflight.current) return;
    const request = {};
    inflight.current = request;
    setState((previous) => ({
      ...(cursor && previous.lease === lease
        ? previous
        : { lease, items: [], total: 0 }),
      loading: true,
      failed: false,
    }));
    try {
      const result = await adapter.search({
        query,
        page,
        section,
        ...(cursor ? { cursor } : {}),
        limit: sectionRows,
      });
      if (!active()) return;
      if (cursor && result.nextCursor === cursor)
        throw new Error("Invalid Customize search continuation.");
      setState((previous) => {
        const old = cursor && previous.lease === lease ? previous.items : [];
        const unique = new Map(old.map((hit) => [hit.key, hit]));
        for (const hit of result.items) unique.set(hit.key, hit);
        return {
          lease,
          items: [...unique.values()],
          total: result.total,
          next: result.nextCursor,
          loading: false,
          failed: false,
        };
      });
    } catch {
      if (active())
        setState((previous) => ({ ...previous, loading: false, failed: true }));
    } finally {
      if (inflight.current === request) inflight.current = undefined;
    }
  };
  useEffect(() => {
    latest.current = lease;
    inflight.current = undefined;
    void load();
    return () => {
      if (latest.current === lease) latest.current = undefined;
      inflight.current = undefined;
    };
  }, [lease]);
  const shown =
    state.lease === lease
      ? state
      : {
          lease,
          items: [],
          total: 0,
          loading: true,
          failed: false,
          next: undefined,
        };
  useEffect(() => {
    report({
      loading: shown.loading,
      failed: shown.failed,
      total: shown.total,
      rows: shown.items.length,
    });
  }, [lease, shown.loading, shown.failed, shown.total, shown.items.length]);
  if (!shown.loading && !shown.failed && !shown.items.length) return null;
  return (
    <section
      className="customize-section unified-section"
      aria-busy={shown.loading}
    >
      <h2>
        {label}
        <span className="unified-count">{shown.total.toLocaleString()}</span>
      </h2>
      <SearchRows
        items={shown.items.map((hit) => ({
          ...hit,
          open: () => {
            if (active()) onOpen?.(hit);
          },
        }))}
      />
      {shown.loading && (
        <p role="status" className="unified-note">
          {t(shown.items.length ? "Loading more…" : "Searching…")}
        </p>
      )}
      {shown.failed && (
        <div role="status" className="unified-note">
          <span>
            {t(
              shown.items.length
                ? "Couldn’t load more."
                : "Couldn’t finish searching.",
            )}
          </span>
          <button type="button" onClick={() => void load(shown.next)}>
            {t("Retry")}
          </button>
        </div>
      )}
      {!shown.loading && !shown.failed && shown.next && (
        <button
          type="button"
          className="unified-more"
          aria-label={formatText("Show more: {section}", { section: label })}
          onClick={() => void load(shown.next)}
        >
          {t("Show more")}
        </button>
      )}
    </section>
  );
}

type CursorStatus = {
  loading: boolean;
  failed: boolean;
  total: number;
  rows: number;
};
function CursorResults({
  query,
  page,
  adapter,
  pending,
  onOpen,
}: {
  query: string;
  page: SearchPage;
  adapter: CustomizeSearchAdapter;
  pending: boolean;
  onOpen?: (hit: CustomizeSearchHit) => void;
}) {
  const [statuses, setStatuses] = useState<
    Partial<Record<CustomizeSearchSection, CursorStatus>>
  >({});
  const report = (section: CustomizeSearchSection, status: CursorStatus) =>
    setStatuses((previous) => {
      if (JSON.stringify(previous[section]) === JSON.stringify(status))
        return previous;
      return { ...previous, [section]: status };
    });
  const states = Object.values(statuses);
  const loading =
    pending || states.length !== 3 || states.some((status) => status.loading);
  const failed = states.some((status) => status.failed);
  const total = states.reduce((sum, status) => sum + status.total, 0);
  const empty = states.every((status) => !status.rows);
  return (
    <div
      className="unified-search"
      data-testid="discover-search-results"
      aria-busy={loading}
    >
      <h2 className="unified-heading" aria-live="polite">
        {formatText("Results matching “{query}”", { query })}
      </h2>
      <p role="status" className="sr-only">
        {formatText(total === 1 ? "{count} result" : "{count} results", {
          count: total.toLocaleString(),
        })}
      </p>
      {(
        [
          ["yours", t(page === "plugins" ? "Your plugins" : "Yours")],
          ["inPage", formatText("In {page}", { page: t(pageNames[page]) })],
          ["more", t("More you can add")],
        ] as const
      ).map(([section, label]) => (
        <CursorSection
          key={section}
          label={label}
          query={catalogQuery(query)}
          page={page}
          section={section}
          adapter={adapter}
          onOpen={onOpen}
          report={(status) => report(section, status)}
        />
      ))}
      {!loading && !failed && empty && (
        <div className="customize-nothing" role="status">
          <p>
            {t(
              page === "skills"
                ? "No skills match your search"
                : page === "plugins"
                  ? "No plugins match your search"
                  : "No connectors match your search",
            )}
            <span>{t("Try a different term.")}</span>
          </p>
        </div>
      )}
    </div>
  );
}

export default function UnifiedSearch({
  query,
  page,
  items,
  sources = [],
  settledQuery: controlledQuery,
  adapter,
  onOpenResult,
}: {
  query: string;
  page: SearchPage;
  items: readonly SearchItem[];
  sources?: readonly SearchLoadState[];
  settledQuery?: string;
  adapter?: CustomizeSearchAdapter;
  onOpenResult?: (hit: CustomizeSearchHit) => void;
}) {
  const [settledQuery, setSettledQuery] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query.trim()), searchDelay);
    return () => clearTimeout(timer);
  }, [query]);
  const trimmed = controlledQuery ?? settledQuery;
  const pending = query.trim() !== trimmed;
  const loading = pending || sources.some((source) => source.loading);
  const failed = sources.some((source) => source.failed);
  const retry = () =>
    sources.forEach((source) => {
      if (source.failed && !source.loading) source.retry();
    });
  const sections = searchSections(items, trimmed, page);
  const total =
    sections.yours.length + sections.inPage.length + sections.more.length;
  if (adapter && !sections.keepTyping)
    return (
      <CursorResults
        key={`${page}:${trimmed}`}
        query={trimmed}
        page={page}
        adapter={adapter}
        pending={pending}
        onOpen={onOpenResult}
      />
    );
  return (
    <div
      className="unified-search"
      data-testid="discover-search-results"
      aria-busy={loading}
    >
      <h2 className="unified-heading" aria-live="polite">
        {formatText("Results matching “{query}”", { query: trimmed })}
      </h2>
      <p role="status" className="sr-only">
        {formatText(total === 1 ? "{count} result" : "{count} results", {
          count: total.toLocaleString(),
        })}
      </p>
      {failed && (
        <div className="customize-load-error" role="alert">
          <span>{t("Couldn’t finish searching.")}</span>
          <button type="button" disabled={loading} onClick={retry}>
            {t("Retry")}
          </button>
        </div>
      )}
      {loading && (
        <p role="status" className="unified-note">
          {t("Searching…")}
        </p>
      )}
      <Section
        key={`yours:${trimmed}`}
        label={t(page === "plugins" ? "Your plugins" : "Yours")}
        items={sections.yours}
      />
      <Section
        key={`page:${trimmed}`}
        label={formatText("In {page}", { page: t(pageNames[page]) })}
        items={sections.inPage}
      />
      <Section
        key={`more:${trimmed}`}
        label={t("More you can add")}
        items={sections.more}
      />
      {sections.keepTyping && !pending && (
        <p role="status" className="unified-note">
          {t("Keep typing to search everything you can add.")}
        </p>
      )}
      {sections.truncated && (
        <p className="unified-note">
          {t("Showing the top matches — refine your search to see more.")}
        </p>
      )}
      {!total && !sections.keepTyping && !loading && !failed && (
        <div className="customize-nothing" role="status">
          <p>
            {t(
              page === "skills"
                ? "No skills match your search"
                : page === "plugins"
                  ? "No plugins match your search"
                  : "No connectors match your search",
            )}
            <span>{t("Try a different term.")}</span>
          </p>
        </div>
      )}
    </div>
  );
}
