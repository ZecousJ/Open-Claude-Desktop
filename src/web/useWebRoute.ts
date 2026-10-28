import { pairedArtifactRouteId } from "../artifacts/paired-artifact";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useApp } from "../app/AppContext";
import { useHost } from "../host/HostContext";
import { withProjectQuery } from "./project-query";
import {
  withoutSettingsConnector,
  isDraftUrl,
  parseWebRoute,
  urlForState,
} from "./routes";
import { historyStep, applyRoute } from "./web-route-apply";
import { routeState } from "./web-route-apply";

/** Marks history entries this app pushed (`history.state`). */
interface EntryState {
  claudex: 1;
  /** Settings was opened over the entry before this one. */
  settings?: boolean;
  /** App-created entries allow a cancelled dirty pop to return to its exact entry. */
  index?: number;
}

const here = () => `${location.pathname}${location.search}${location.hash}`;

/**
 * Keeps the address bar and the window's place in step on the web: reads
 * the URL on load and on popstate, and pushes or replaces history entries
 * as the window moves (SCRATCH/impl/web/W-UI-design.md §6.1). The
 * browser's history is the web app's history; the addresses are in
 * src/web/routes.ts.
 *
 * - A move the user makes pushes an entry. The new-chat draft becoming
 *   the conversation it started replaces it (back does not return to an
 *   empty draft), as `navigation.replaceNext` does on the desktop.
 * - Settings pushes /settings/<tab> over the page; switching pages inside
 *   Settings replaces it; closing Settings steps back to the page.
 * - Addresses in a non-canonical spelling (`/`, `/login`, `/chat/<id>` of
 *   a Code conversation, `/new?q=`) are replaced by the canonical one.
 *
 * Mounted by App on the web only (src/host/WebMounts.tsx), inside
 * AppContext, so it can call useApp().
 */
export function useWebRoute(): void {
  const app = useApp();
  const host = useHost();
  // The Code page exists on every host (claude.ai/code shows it before a
  // cloud environment runs); Code conversations need cloud or local Code.
  const codeAvailable = host.kind === "web" || host.capabilities.localCode;
  const latest = useRef({ app, codeAvailable });
  latest.current = { app, codeAvailable };
  const target = withProjectQuery(
    urlForState(routeState(app)),
    typeof location === "undefined" ? undefined : location,
  );
  /** The state's address at the last sync; undefined before the first. */
  const synced = useRef<SyncedPlace | null>(null);
  /** Conversations that existed when the window showed a new-chat draft. */
  const draftKnown = useRef<Set<string> | null>(null);
  const loaded = useRef(false);
  const epoch = useRef(0);
  const owner = useRef({
    account: app.accountId,
    controller: app.controllerScope,
    bridge: window.desktop,
  });
  const index = useRef<number | undefined>(undefined);
  const pending = useRef<{ current(): boolean } | undefined>(undefined);
  if (
    owner.current.account !== app.accountId ||
    owner.current.controller !== app.controllerScope ||
    owner.current.bridge !== window.desktop
  ) {
    owner.current = {
      account: app.accountId,
      controller: app.controllerScope,
      bridge: window.desktop,
    };
    epoch.current++;
    loaded.current = false;
    synced.current = null;
    draftKnown.current = null;
    pending.current = undefined;
  }

  // The address → the window: on load and on back/forward.
  useLayoutEffect(() => {
    const show = (initial: boolean) => {
      const { app, codeAvailable } = latest.current;
      if (initial) {
        const query = new URLSearchParams(location.search);
        if (query.has("cowork_connector")) {
          const code = query.get("code"),
            state = query.get("state");
          if (query.has("error") || !code || !state) {
            sessionStorage.removeItem("claudex:connector-reconnect");
            app.report(
              new Error("The connector didn't return a sign-in page."),
            );
          } else
            void window.desktop
              .completeConnectorLogin(state, code)
              .catch((error) => {
                sessionStorage.removeItem("claudex:connector-reconnect");
                app.report(error);
              });
          for (const key of [
            "cowork_connector",
            "code",
            "state",
            "error",
            "error_description",
          ])
            query.delete(key);
          history.replaceState(
            history.state,
            "",
            location.pathname + (query.size ? `?${query}` : ""),
          );
        }
      }
      const scope = owner.current,
        generation = ++epoch.current;
      const before = index.current;
      const incoming = entryIndex(history.state);
      const previous = withProjectQuery(
        urlForState(routeState(app)),
        typeof location === "undefined" ? undefined : location,
      );
      const baseline = [
        app.page,
        app.mode,
        app.activeId,
        pairedArtifactRouteId(app.artifact, app.activeId),
      ];
      const ticket = {
        address: here(),
        current: () => {
          const now = latest.current.app;
          return (
            owner.current === scope &&
            epoch.current === generation &&
            window.desktop === scope.bridge &&
            here() === ticket.address &&
            now.accountId === scope.account &&
            now.controllerScope === scope.controller &&
            [
              now.page,
              now.mode,
              now.activeId,
              pairedArtifactRouteId(now.artifact, now.activeId),
            ].every((value, i) => value === baseline[i])
          );
        },
      };
      let canonical = applyRoute(
        app,
        parseWebRoute(location.pathname, location.search, location.hash),
        {
          codeAvailable,
          initial,
          current: ticket.current,
          onDeferred: (waiting) => {
            if (waiting) {
              if (ticket.current()) pending.current = ticket;
            } else if (pending.current === ticket) pending.current = undefined;
          },
          onCancel: () => {
            if (!ticket.current()) return;
            pending.current = undefined;
            epoch.current++;
            if (
              before !== undefined &&
              incoming !== undefined &&
              before !== incoming
            )
              history.go(before - incoming);
            else if (previous)
              history.replaceState(history.state, "", previous);
          },
        },
      );
      canonical = withProjectQuery(canonical, location);
      index.current = incoming ?? before ?? 0;
      if (canonical) ticket.address = canonical;
      if (canonical && canonical !== here())
        history.replaceState(history.state, "", canonical);
      if (entryIndex(history.state) === undefined)
        history.replaceState(
          { ...history.state, claudex: 1, index: index.current },
          "",
          here(),
        );
    };
    const onPopState = () => show(false);
    // Once per page load (StrictMode runs effects twice).
    if (!loaded.current) {
      loaded.current = true;
      show(true);
    }
    addEventListener("popstate", onPopState);
    addEventListener("hashchange", onPopState);
    return () => {
      epoch.current++;
      pending.current = undefined;
      removeEventListener("popstate", onPopState);
      removeEventListener("hashchange", onPopState);
    };
  }, [app.accountId, app.controllerScope, owner.current.bridge]);

  // The window → the address.
  useEffect(() => {
    const { app } = latest.current;
    if (pending.current?.current()) return;
    pending.current = undefined;
    const settings = app.settingsOpen;
    const previous = synced.current;
    synced.current = { url: target, settingsOpen: settings };
    const known = draftKnown.current;
    // The conversations there were while the window showed the draft.
    if (!isDraftUrl(target)) draftKnown.current = null;
    else
      draftKnown.current ??= new Set(
        app.snapshot.conversations.map((c) => c.id),
      );
    // The first render is the default state the load's route replaces;
    // an effect run without a move (StrictMode's second run) does nothing.
    if (!previous) return;
    if (previous.url === target && previous.settingsOpen === settings) return;
    const step = historyStep({
      previous,
      next: { url: target, settingsOpen: settings },
      address: here(),
      openedSettings: Boolean((history.state as EntryState | null)?.settings),
      activeId: app.activeId,
      draftKnown: known,
    });
    if (step === "push") {
      if (settings && app.settingsTab === "connectors") {
        const background = withoutSettingsConnector(here());
        if (background !== here())
          history.replaceState(history.state, "", background);
      }
      index.current = (index.current ?? entryIndex(history.state) ?? 0) + 1;
      history.pushState(entry(settings, index.current), "", target);
    } else if (step === "replace")
      history.replaceState(
        settings ? history.state : entry(false, index.current),
        "",
        target,
      );
    else if (step === "back") history.back();
  }, [target, app.settingsOpen]);
}

const entryIndex = (state: unknown) => {
  const value =
    state && typeof state === "object"
      ? (state as EntryState).index
      : undefined;
  return Number.isSafeInteger(value) ? value : undefined;
};
const entry = (settings: boolean, index?: number): EntryState => ({
  claudex: 1,
  ...(settings ? { settings } : {}),
  ...(index !== undefined ? { index } : {}),
});

/** Where the window is, as far as its address goes. */
export interface SyncedPlace {
  /** Its address; undefined when it has none (not found). */
  url?: string;
  settingsOpen: boolean;
}
