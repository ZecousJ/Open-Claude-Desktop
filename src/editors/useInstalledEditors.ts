import { useEffect, useState } from "react";
import type { EditorInfo } from "../../shared/editors";

/**
 * The editors this computer has (Open in ▸), read once per window and kept
 * for five minutes, as the original's query (staleTime, never collected).
 */
const freshMs = 5 * 60_000;
let known: { at: number; list: EditorInfo[] } | undefined;
let reading: Promise<EditorInfo[]> | undefined;

function read() {
  const api = window.desktop;
  if (!api?.installedEditors) return Promise.resolve([]);
  reading ??= Promise.resolve()
    .then(() => api.installedEditors())
    .catch(() => [] as EditorInfo[])
    .then((value) => {
      const list = Array.isArray(value) ? value : [];
      known = { at: Date.now(), list };
      reading = undefined;
      return list;
    });
  return reading;
}

export function useInstalledEditors(enabled = true): EditorInfo[] {
  const [list, setList] = useState(() => known?.list ?? []);
  useEffect(() => {
    if (!enabled) return;
    if (known && Date.now() - known.at < freshMs) {
      setList(known.list);
      return;
    }
    let live = true;
    void read().then((next) => live && setList(next));
    return () => {
      live = false;
    };
  }, [enabled]);
  return list;
}
