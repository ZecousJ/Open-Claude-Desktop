import { useRef, useState } from "react";

/**
 * One list the Customize page reads from the host: the latest read wins,
 * and nothing lands once the page (or the read) is gone. A failed read
 * keeps what was shown, or `empty` when nothing was.
 */
export function useLatestRead<T>({
  read,
  alive,
  initialLoading,
  empty,
  onError,
}: {
  read: () => Promise<T>;
  /** The page is still shown and can ask the host. */
  alive: () => boolean;
  initialLoading: boolean;
  /** Shown after a failed first read; without it the value stays unset. */
  empty?: T;
  onError?: (error: unknown) => void;
}) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(initialLoading);
  const latest = useRef(0);
  const current = (id: number) => alive() && id === latest.current;
  const load = async () => {
    if (!alive()) return;
    const id = ++latest.current;
    setLoading(true);
    try {
      const next = await read();
      if (!current(id)) return;
      setValue(next);
      setError(false);
    } catch (failure) {
      if (!current(id)) return;
      if (empty !== undefined) setValue((previous) => previous ?? empty);
      setError(true);
      onError?.(failure);
    } finally {
      if (current(id)) setLoading(false);
    }
  };
  return {
    value,
    setValue,
    error,
    setError,
    loading,
    load,
    /** A read in flight lands nowhere. */
    cancel: () => {
      latest.current++;
    },
  };
}
