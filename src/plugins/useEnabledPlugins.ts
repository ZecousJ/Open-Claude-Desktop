import { useEffect, useState } from "react";
import type { PluginEntry } from "../../shared/collections-api";

/** The plugins installed and turned on, read when a menu needs them (once a minute at most). */
let known: { at: number; list: PluginEntry[] } | undefined;
export function useEnabledPlugins(): PluginEntry[] {
  const [list, setList] = useState(() => known?.list ?? []);
  useEffect(() => {
    if (known && Date.now() - known.at < 60_000) return;
    let live = true;
    void Promise.resolve(window.desktop?.listPlugins?.())
      .then((catalog) => {
        const enabled = (catalog?.plugins ?? []).filter(
          (plugin) => plugin.installed && plugin.enabled,
        );
        known = { at: Date.now(), list: enabled };
        if (live) setList(enabled);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return list;
}
