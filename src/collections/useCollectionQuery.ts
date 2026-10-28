import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppContext } from "../app/AppContext";

/** URL search shared by the Projects and Artifacts lists. Source
 * c2733cbcb-C4mP-OC4:35–92: optimistic input, 300ms replacement, clear flush,
 * and cancellation on history navigation. The router owns path and Settings. */
export function useCollectionQuery(web: boolean) {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const scope = useMemo(
    () => ({}),
    [app?.accountId, app?.controllerScope, bridge, web],
  );
  const read = () =>
    web && typeof window !== "undefined" ? (window.location?.search ?? "") : "";
  const [snapshot, setSnapshot] = useState(() => ({ scope, value: read() }));
  const [draft, setDraft] = useState<{ scope: object; value: string }>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(scope);
  active.current = scope;
  const params = new URLSearchParams(
    snapshot.scope === scope ? snapshot.value : read(),
  );
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const current = () => {
    const now = app?.currentController ? app.currentController.current : app;
    return (
      active.current === scope &&
      (!app ||
        Boolean(
          now &&
          now.accountId === app.accountId &&
          now.controllerScope === app.controllerScope,
        )) &&
      (typeof window === "undefined" || window.desktop === bridge)
    );
  };
  useEffect(() => {
    setSnapshot({ scope, value: read() });
    setDraft(undefined);
    const restore = () => {
      cancel();
      if (!current()) return;
      setSnapshot({ scope, value: read() });
      setDraft(undefined);
    };
    if (web) window.addEventListener("popstate", restore);
    return () => {
      cancel();
      if (web) window.removeEventListener("popstate", restore);
    };
  }, [scope]);

  const update = (
    patch: Record<string, string | undefined>,
    mode: "push" | "replace" = "push",
  ) => {
    if (!current()) return;
    const next = new URLSearchParams(web ? read() : params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    if (web && window.location && window.history) {
      const { pathname, hash } = window.location;
      const url = `${pathname}${query ? `?${query}` : ""}${hash}`;
      if (`${pathname}${window.location.search}${hash}` !== url)
        window.history[mode === "push" ? "pushState" : "replaceState"](
          window.history.state,
          "",
          url,
        );
    }
    setSnapshot({ scope, value: query });
  };
  const setSearch = (value: string) => {
    if (!current()) return;
    cancel();
    setDraft({ scope, value });
    const pathname = web ? window.location?.pathname : undefined;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (!current() || (web && window.location?.pathname !== pathname)) return;
      update({ search: value || undefined }, "replace");
    }, 300);
  };
  const clearSearch = () => {
    if (!current()) return;
    cancel();
    setDraft({ scope, value: "" });
    update({ search: undefined }, "replace");
  };
  return {
    params,
    search: draft?.scope === scope ? draft.value : (params.get("search") ?? ""),
    setSearch,
    clearSearch,
    update,
  };
}
