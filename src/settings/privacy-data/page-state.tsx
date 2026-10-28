import { useEffect, useRef, useState } from "react";
import type { PrivacyDataAPI } from "../../../shared/privacy-data-api";
import type { PrivacyOwner } from "../privacy-owner";
import "./privacy-data.css";

export function privacyBridge(owner: PrivacyOwner): PrivacyDataAPI {
  if (!owner.current() || !owner.bridge)
    throw Error(
      "This privacy request belongs to a retired account. Open Privacy again.",
    );
  return owner.bridge as typeof owner.bridge & PrivacyDataAPI;
}
export function useDataPage<
  T extends { items: { id: string }[]; nextCursor?: string },
>(
  owner: PrivacyOwner,
  load: (cursor?: string) => Promise<T>,
  onError: (error: unknown) => void,
) {
  const [page, setPage] = useState<T>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [retryCursor, setRetryCursor] = useState<string>();
  const removed = useRef(new Set<string>());
  const alive = useRef(true),
    lock = useRef(false);
  const latest = useRef({ load, onError });
  latest.current = { load, onError };
  const reload = async (cursor?: string) => {
    if (lock.current || !alive.current || !owner.current()) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    setRetryCursor(cursor);
    try {
      const next = await latest.current.load(cursor);
      if (alive.current && owner.current())
        setPage(
          (previous) =>
            ({
              ...next,
              items:
                cursor && previous
                  ? [
                      ...new Map(
                        [...previous.items, ...next.items].map((item) => [
                          item.id,
                          item,
                        ]),
                      ).values(),
                    ].filter((item) => !removed.current.has(item.id))
                  : next.items.filter((item) => !removed.current.has(item.id)),
            }) as T,
        );
    } catch (reason) {
      if (alive.current && owner.current()) {
        setError(reason instanceof Error ? reason.message : String(reason));
        latest.current.onError(reason);
      }
    } finally {
      lock.current = false;
      if (alive.current && owner.current()) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [owner]);
  return {
    page,
    busy,
    error,
    reload,
    retry: () => reload(retryCursor),
    remove: (id: string) => {
      removed.current.add(id);
      setPage((previous) =>
        previous
          ? {
              ...previous,
              items: previous.items.filter((item) => item.id !== id),
            }
          : previous,
      );
    },
  };
}
