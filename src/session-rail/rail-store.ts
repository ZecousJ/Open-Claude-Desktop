import { useCallback, useSyncExternalStore } from "react";

/**
 * The Code session rail's remembered state: whether it shows
 * ("persisted.epitaxy.sessionRailShown", shown unless hidden) and, per session,
 * which cards are folded ("epitaxy.sessionRailSections"). Kept in this window's
 * local storage.
 */
const shownKey = "claudex.sessionRail.shown";
const foldKey = "claudex.sessionRail.folds";
/** Sessions whose folds are remembered; the oldest go first. */
const maxSessions = 200;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith("claudex.sessionRail."))
      listener();
  };
  window.addEventListener("storage", storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", storage);
  };
};

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private storage: the choice lasts until the window reloads. */
  }
  notify();
}

/** Whether the rail shows (the header's Show / Hide session rail). */
export function useRailShown(): [boolean, (shown: boolean) => void] {
  const get = () => read(shownKey) !== "0";
  const shown = useSyncExternalStore(subscribe, get, get);
  const set = useCallback(
    (value: boolean) => write(shownKey, value ? "1" : "0"),
    [],
  );
  return [shown, set];
}

/*
 * Where the rail is now: a column beside the conversation while it is shown and
 * fits; when it does not fit, the header's toggle raises it over the
 * conversation for that session, until the toggle lowers it or the rail fits
 * again. The toggle is pressed while the rail is on screen either way.
 */
let railFits = false;
let raisedFor: string | null = null;
const viewListeners = new Set<() => void>();
const subscribeView = (listener: () => void) => {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
};
const notifyView = () => viewListeners.forEach((listener) => listener());
/** Set by the session view: whether the rail has room as a column. */
export function setRailFits(fits: boolean) {
  if (railFits === fits) return;
  railFits = fits;
  notifyView();
}
export function setRailRaised(sessionId: string | null) {
  if (raisedFor === sessionId) return;
  raisedFor = sessionId;
  notifyView();
}
/** The session whose rail is raised over its conversation, if any. */
export function useRailRaised() {
  return useSyncExternalStore(
    subscribeView,
    () => raisedFor,
    () => null,
  );
}
/**
 * The header's Show / Hide session rail: on screen when shown as a column
 * or raised; it lowers a raised rail, hides a column, and otherwise shows
 * the rail, raising it when there is no room for the column.
 */
export function useRailToggle(sessionId: string) {
  const [shown, setShown] = useRailShown();
  const fits = useSyncExternalStore(
    subscribeView,
    () => railFits,
    () => false,
  );
  const raised = useRailRaised() === sessionId;
  const onScreen = (shown && fits) || raised;
  const toggle = () => {
    if (raised) return setRailRaised(null);
    if (onScreen) return setShown(false);
    setShown(true);
    if (!fits) setRailRaised(sessionId);
  };
  return { onScreen, toggle };
}

type Folds = Record<string, Record<string, boolean>>;
let cached: { raw: string | null; folds: Folds } = { raw: null, folds: {} };
function folds(): Folds {
  const raw = read(foldKey);
  if (raw !== cached.raw) {
    let parsed: Folds = {};
    try {
      const value = raw ? JSON.parse(raw) : {};
      if (value && typeof value === "object") parsed = value;
    } catch {
      /* A damaged value starts over. */
    }
    cached = { raw, folds: parsed };
  }
  return cached.folds;
}

/** A card's open state in one session; `fallback` until it is toggled. */
export function useRailCardOpen(
  sessionId: string,
  card: string,
  fallback: boolean,
): [boolean, (open: boolean) => void] {
  const get = () => folds()[sessionId]?.[card] ?? fallback;
  const open = useSyncExternalStore(subscribe, get, get);
  const set = useCallback(
    (value: boolean) => {
      const all = { ...folds() };
      // The session moves to the end, so the oldest are dropped first.
      const own = { ...all[sessionId], [card]: value };
      delete all[sessionId];
      all[sessionId] = own;
      const keys = Object.keys(all);
      for (const key of keys.slice(0, Math.max(0, keys.length - maxSessions)))
        delete all[key];
      write(foldKey, JSON.stringify(all));
    },
    [sessionId, card],
  );
  return [open, set];
}

/**
 * Where the rail fits (the original's widths): beside an open side pane
 * from 771px of conversation, alone from 611px, otherwise not at all.
 */
export const railWidth = 280;
export function railFit(width: number): "beside-pane" | "alone" | "none" {
  return width >= 760 + 13 - 2
    ? "beside-pane"
    : width >= 320 + railWidth + 13 - 2
      ? "alone"
      : "none";
}
export const railVisible = (
  fit: ReturnType<typeof railFit>,
  paneOpen: boolean,
) => (paneOpen ? fit === "beside-pane" : fit !== "none");

/** The rail's cards in the original's default order. */
export const railCardIds = [
  "goal",
  "environment",
  "settings",
  "context",
  "usage",
  "connectors",
  "progress",
  "outputs",
  "pullRequests",
  "servers",
  "backgroundTasks",
] as const;
export type RailCardId = (typeof railCardIds)[number];
export const railCardTitles: Record<RailCardId, string> = {
  goal: "Goal",
  environment: "Environment",
  settings: "Settings",
  context: "Context",
  usage: "Usage limits",
  connectors: "Connectors",
  progress: "Progress",
  outputs: "Outputs",
  pullRequests: "Changes",
  servers: "Servers",
  backgroundTasks: "Background tasks",
};
/** Shown from the cards menu only (the original keeps Settings and Usage behind a flag and hides Progress). */
const hiddenByDefault: RailCardId[] = ["settings", "usage", "progress"];

const layoutKey = "claudex.sessionRail.layout";
interface Layout {
  order: RailCardId[];
  hidden: RailCardId[];
}
let cachedLayout: { raw: string | null; layout: Layout } | undefined;
function readLayout(): Layout {
  const raw = read(layoutKey);
  if (cachedLayout?.raw === raw) return cachedLayout.layout;
  let layout: Layout = {
    order: [...railCardIds],
    hidden: [...hiddenByDefault],
  };
  try {
    const value = raw ? JSON.parse(raw) : undefined;
    if (value && Array.isArray(value.order) && Array.isArray(value.hidden)) {
      const known = (id: unknown): id is RailCardId =>
        railCardIds.includes(id as RailCardId);
      const order = value.order.filter(known);
      // Cards added later go where the defaults put them.
      for (const id of railCardIds)
        if (!order.includes(id)) order.splice(railCardIds.indexOf(id), 0, id);
      layout = {
        order,
        hidden: value.hidden
          .filter(known)
          .filter((id: RailCardId) => id !== "environment"),
      };
    }
  } catch {
    /* A damaged value starts over. */
  }
  cachedLayout = { raw, layout };
  return layout;
}

/** Which cards show and in what order (the cards menu and drag reorder). */
export function useRailLayout() {
  const layout = useSyncExternalStore(subscribe, readLayout, readLayout);
  const save = (next: Layout) => write(layoutKey, JSON.stringify(next));
  return {
    ...layout,
    toggle: (id: RailCardId) =>
      save({
        ...layout,
        hidden: layout.hidden.includes(id)
          ? layout.hidden.filter((value) => value !== id)
          : [...layout.hidden, id],
      }),
    reset: () => {
      try {
        localStorage.removeItem(layoutKey);
      } catch {
        /* Nothing stored. */
      }
      notify();
    },
    /** Moves a card one place up or down among the cards. */
    move: (id: RailCardId, by: -1 | 1) => {
      const order = layout.order.filter((value) => value !== id);
      const at = Math.max(
        0,
        Math.min(order.length, layout.order.indexOf(id) + by),
      );
      order.splice(at, 0, id);
      save({ ...layout, order });
    },
    /** Puts a card before another (or last). */
    place: (id: RailCardId, before: RailCardId | null) => {
      if (before === id) return;
      const order = layout.order.filter((value) => value !== id);
      order.splice(before ? order.indexOf(before) : order.length, 0, id);
      save({ ...layout, order });
    },
  };
}
