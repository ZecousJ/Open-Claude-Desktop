import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Search, X } from "../../ui/glyphs";
import type { HistorySearchHit } from "../../../shared/history-search";
import type { Conversation } from "../../../shared/types";
import { t, useLocale } from "../../i18n";
import { RelativeTime } from "../../ui/RelativeTime";
import { Skeleton, SkeletonGroup } from "../../ui/Skeleton";
import { ProjectChatRow } from "./ProjectChatRow";

// Project search is debounced 300ms and returns up to 50 chats.
export const projectSearchDelay = 300;
export const projectSearchLimit = 50;

export function ProjectSearchText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const needle = query.trim().toLocaleLowerCase();
  const lower = text.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  let match = needle ? lower.indexOf(needle) : -1;
  while (match >= 0) {
    parts.push(
      text.slice(start, match),
      <strong key={match}>{text.slice(match, match + needle.length)}</strong>,
    );
    start = match + needle.length;
    match = lower.indexOf(needle, start);
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}

export function ProjectSearchResults({
  results,
  query,
  pending,
  onOpen,
  chats,
}: {
  results: HistorySearchHit[];
  query: string;
  pending: boolean;
  onOpen: (id: string) => void | false;
  chats?: Conversation[];
}) {
  if (pending) {
    return (
      <SkeletonGroup
        className="prj-search-skeleton"
        motion="sweep"
        label={t("Loading")}
      >
        {[420, 280, 360, 500, 240, 390, 310, 450].map((width, index) => (
          <div
            key={width}
            style={{
              opacity: [1, 0.85, 0.65, 0.45, 0.25, 0.1, 0.1, 0.1][index],
            }}
          >
            <Skeleton
              width={width}
              height={16}
              className="prj-search-sk-title"
            />
            <Skeleton width={200} height={12} className="prj-search-sk-note" />
          </div>
        ))}
      </SkeletonGroup>
    );
  }
  if (!results.length) {
    return (
      <div className="prj-search-empty">
        <h3>{t("No matches.")}</h3>
      </div>
    );
  }
  return (
    <ul className="prj-search-results">
      {results.map((result) => (
        <ProjectChatRow
          key={result.conversationId}
          id={result.conversationId}
          title={result.title}
          mode={result.mode}
          className="prj-search-result"
          conversation={chats?.find(
            (chat) => chat.id === result.conversationId,
          )}
          onOpen={() => onOpen(result.conversationId)}
        >
          <span className="prj-search-title" data-no-translate>
            <ProjectSearchText
              text={result.title || t("Untitled")}
              query={query}
            />
          </span>
          <span className="prj-search-detail">
            <span className="prj-search-snippet" data-no-translate>
              {result.snippet ? (
                <ProjectSearchText text={result.snippet} query={query} />
              ) : (
                t("Last message")
              )}
            </span>
            <RelativeTime
              createdAt={result.updatedAt}
              className="prj-search-time"
            />
          </span>
        </ProjectChatRow>
      ))}
    </ul>
  );
}

export function ProjectChatSearch({
  projectId,
  chats,
  onOpen,
  onError,
  children,
  headerContainer,
}: {
  projectId: string;
  chats: Conversation[];
  onOpen: (conversation: Conversation) => void;
  onError: (error: unknown) => void;
  children: ReactNode;
  /** undefined keeps the desktop field inline; null waits for the web header. */
  headerContainer?: HTMLElement | null;
}) {
  useLocale();
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [answer, setAnswer] = useState<{
    query: string;
    results: HistorySearchHit[];
    failed?: boolean;
  }>();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const restoreFocus = useRef(false);
  const pointerInField = useRef(false);
  const report = useRef(onError);
  report.current = onError;
  const resultsId = useId();
  const active = searchQuery.trim() !== "";
  const inHeader = headerContainer !== undefined;
  useLayoutEffect(() => {
    if (!inHeader) return;
    if (expanded) input.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [inHeader, expanded]);
  useEffect(() => {
    if (!inHeader || !expanded) return;
    const release = () => {
      pointerInField.current = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      release();
    };
  }, [inHeader, expanded]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(query);
    }, projectSearchDelay);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!searchQuery.trim()) return;
    let alive = true;
    window.desktop
      .searchConversations(searchQuery, {
        projectId,
        limit: projectSearchLimit,
        includeArchived: true,
      })
      .then(
        ({ results }) => alive && setAnswer({ query: searchQuery, results }),
        (error) => {
          if (alive) {
            setAnswer({ query: searchQuery, results: [], failed: true });
            report.current(error);
          }
        },
      );
    return () => {
      alive = false;
    };
  }, [searchQuery, projectId]);
  const clear = () => {
    setQuery("");
    setSearchQuery("");
    setAnswer(undefined);
    input.current?.focus();
  };
  const collapse = () => {
    clear();
    restoreFocus.current = true;
    setExpanded(false);
  };
  const field = (
    <div
      role="search"
      className={`prj-search-field${inHeader ? " prj-header-search" : ""}`}
      onClick={() => input.current?.focus()}
      onPointerDown={() => {
        pointerInField.current = true;
      }}
      onBlur={(event) => {
        if (
          inHeader &&
          !query &&
          !pointerInField.current &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setExpanded(false);
      }}
    >
      <Search size={16} aria-hidden="true" />
      <input
        ref={input}
        type={inHeader ? "search" : "text"}
        autoComplete={inHeader ? "off" : undefined}
        value={query}
        placeholder={t(inHeader ? "Search" : "Search this project")}
        aria-label={t("Search this project")}
        aria-controls={active ? resultsId : undefined}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !event.nativeEvent.isComposing &&
            !event.repeat &&
            !(
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              event.shiftKey
            ) &&
            (inHeader || query)
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (query) clear();
            else collapse();
          }
        }}
      />
      {(inHeader || query) && (
        <button
          type="button"
          tabIndex={inHeader ? undefined : -1}
          aria-label={t("Clear search")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={inHeader ? collapse : clear}
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
  const searchControl = expanded ? (
    field
  ) : (
    <button
      ref={trigger}
      type="button"
      className="prj-overview-icon prj-project-search-trigger"
      aria-label={t("Search this project")}
      onClick={() => setExpanded(true)}
    >
      <Search size={20} aria-hidden="true" />
    </button>
  );
  return (
    <div
      className="prj-project-search"
      data-header-search={inHeader || undefined}
    >
      {inHeader
        ? headerContainer && createPortal(searchControl, headerContainer)
        : field}
      {active && !(answer?.query === searchQuery && answer.failed) ? (
        <div id={resultsId}>
          <ProjectSearchResults
            chats={chats}
            results={answer?.results ?? []}
            query={searchQuery}
            pending={answer?.query !== searchQuery}
            onOpen={(id) => {
              const conversation = chats.find((chat) => chat.id === id);
              if (conversation) onOpen(conversation);
              else return false;
            }}
          />
        </div>
      ) : (
        children
      )}
    </div>
  );
}
