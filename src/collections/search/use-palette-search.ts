import { useEffect, useState } from "react";
import type { HistorySearchHit } from "../../../shared/history-search";
import { api } from "../../desktop-api";

/** Deeper stored-message search. */
export function usePaletteSearch(query: string, enabled: boolean) {
  const [result, setResult] = useState<{
    query: string;
    hits: HistorySearchHit[];
    pending: boolean;
    titlesOnly: boolean;
  }>({ query: "", hits: [], pending: false, titlesOnly: false });
  const needle = query.trim();
  useEffect(() => {
    if (!enabled || !needle || Array.from(needle).length > 200) return;
    let live = true;
    setResult({ query: needle, hits: [], pending: true, titlesOnly: false });
    const timer = setTimeout(() => {
      void api
        .searchConversations(needle, { limit: 50 })
        .then(({ results }) => {
          if (live)
            setResult({
              query: needle,
              hits: results,
              pending: false,
              titlesOnly: false,
            });
        })
        .catch(() => {
          if (live)
            setResult({
              query: needle,
              hits: [],
              pending: false,
              titlesOnly: true,
            });
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [needle, enabled]);
  return {
    hits: enabled && result.query === needle ? result.hits : undefined,
    titlesOnly: enabled && result.query === needle && result.titlesOnly,
    pending:
      enabled &&
      !!needle &&
      Array.from(needle).length <= 200 &&
      (result.query !== needle || result.pending),
  };
}
