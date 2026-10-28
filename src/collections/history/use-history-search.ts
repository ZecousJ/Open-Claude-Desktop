import { useEffect, useState } from "react";
import type { HistorySearchHit } from "../../../shared/history-search";
import type { Conversation, Mode } from "../../../shared/types";
import type { HistoryTab } from "./history-rows";

/** Debounced host search with retry; Code uses titles. */
export function useHistorySearch(
  input: string | null,
  mode: Mode,
  tab: HistoryTab,
  _conversations?: Conversation[],
) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HistorySearchHit[]>([]);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input?.trim() ?? ""), 300);
    return () => clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    setResults([]);
    setError(false);
    setPending(false);
    if (!query || mode === "code") return;
    let live = true;
    setPending(true);
    void window.desktop
      .searchConversations(query, { includeArchived: tab !== "all", limit: 50 })
      .then(({ results }) => {
        if (live) setResults(results);
      })
      .catch(() => {
        if (live) setError(true);
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
    // Not on every conversation change: a streaming reply changes the list
    // many times a second, and each search would clear the results.
  }, [query, mode, tab, attempt]);
  return {
    query,
    results,
    error,
    pending,
    retry: () => setAttempt((value) => value + 1),
  };
}
