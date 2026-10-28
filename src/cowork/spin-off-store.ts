import { useSyncExternalStore } from "react";

/**
 * Task windows. Up to three windows float at the bottom right of the Cowork
 * page, each in its own slot. A spun-off window starts its task from the
 * conversation it was spun off, continuing after the reply it was opened on; a
 * quick task window starts a new task; either then follows its task. A window
 * opened on a task follows it from the start. With three open, a window whose
 * task started gives up its place; three drafts leave no room ("Composer at
 * capacity. Close a draft to spin off a new task.").
 */
export type TaskWindowSource =
  /** A Cowork reply's Spin off a new task. */
  | "branch"
  /** The address's prompt (`/new?q=…`) while the Cowork composer is busy. */
  | "url"
  /** A prompt link (`/new?q=…&composer=mini`) clicked in an artifact. */
  | "artifact_link"
  /** A task row's Open as quick task. */
  | "session_menu";

/** What a window's composer starts with. */
export interface TaskWindowSeed {
  prompt: string;
  /**
   * The prompt came from outside Claudex (an address or a link): the composer
   * warns before it runs.
   */
  unsafe?: boolean;
}

export interface SpinOffWindow {
  id: number;
  /** 0, 1 or 2: which of the three places the window holds. */
  slot: number;
  minimized: boolean;
  /** Raised last: the higher, the more recently raised. */
  raisedSeq: number;
  source: TaskWindowSource;
  /** A spun-off task: the conversation it comes from, and the reply it follows. */
  parentId?: string;
  turnId?: string;
  /** The composer's first words; taken once the composer has them. */
  seed?: TaskWindowSeed;
  /** The task once it started (or the task it was opened on). */
  sessionId?: string;
}

/** Three windows. */
export const SPIN_OFF_SLOTS = 3;

export const spinOffCapacityMessage =
  "Composer at capacity. Close a draft to spin off a new task.";
/** A task row's Open as quick task finding no room. */
export const quickTaskCapacityMessage =
  "Composer at capacity. Close a draft to open this task in the composer.";

/**
 * A prompt that came from an address or a link runs in Manual whatever the
 * permission mode, and its window offers no permission picker.
 */
export const asksFirst = (source: TaskWindowSource) =>
  source === "url" || source === "artifact_link";

let windows: SpinOffWindow[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const set = (next: SpinOffWindow[]) => {
  windows = next;
  listeners.forEach((listener) => listener());
};
const nextSeq = (list: SpinOffWindow[]) =>
  list.reduce((top, item) => Math.max(top, item.raisedSeq), 0) + 1;

export const spinOffWindows = () => windows;

/**
 * Opens a window (the live store's openWindow): its slot, or null when
 * there is no room. A window already following `sessionId` is expanded and
 * raised instead of opening another.
 */
export function openTaskWindow(
  source: TaskWindowSource,
  options: {
    seed?: TaskWindowSeed;
    branch?: { parentId: string; turnId: string };
    sessionId?: string;
  } = {},
): number | null {
  const { seed, branch, sessionId } = options;
  const following = sessionId
    ? windows.find((item) => item.sessionId === sessionId)
    : undefined;
  if (following) {
    set(
      windows.map((item) =>
        item === following
          ? { ...item, minimized: false, raisedSeq: nextSeq(windows) }
          : item,
      ),
    );
    return following.slot;
  }
  let list = windows;
  if (list.length >= SPIN_OFF_SLOTS) {
    const started = list.find((item) => item.sessionId !== undefined);
    if (!started) return null;
    list = list.filter((item) => item !== started);
  }
  const taken = new Set(list.map((item) => item.slot));
  const slot = [...Array(SPIN_OFF_SLOTS).keys()].find((n) => !taken.has(n));
  if (slot === undefined) return null;
  set([
    ...list,
    {
      id: nextId++,
      slot,
      minimized: false,
      raisedSeq: nextSeq(list),
      source,
      ...(branch ? { parentId: branch.parentId, turnId: branch.turnId } : {}),
      ...(seed ? { seed } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
  ]);
  return slot;
}

/** Spin off a new task: a draft window after a reply; its slot, or null. */
export function openSpinOff(parentId: string, turnId: string): number | null {
  return openTaskWindow("branch", { branch: { parentId, turnId } });
}

/**
 * Opens a quick task window: false when there is no room for a window on a
 * task; with no room for a draft, the newest window comes up instead and the
 * call counts as done.
 */
export function openQuickTask(
  source: TaskWindowSource,
  options: { seed?: TaskWindowSeed; sessionId?: string } = {},
): boolean {
  if (openTaskWindow(source, options) !== null) return true;
  if (options.sessionId !== undefined) return false;
  const last = windows.at(-1);
  if (last) setSpinOffMinimized(last.id, false);
  return true;
}

/** The composer took its first words: they are not given again. */
export function takeSpinOffSeed(id: number) {
  if (windows.some((item) => item.id === id && item.seed))
    set(
      windows.map((item) =>
        item.id === id ? { ...item, seed: undefined } : item,
      ),
    );
}

/** The window's task started: it follows the new conversation. */
export function setSpinOffSession(id: number, sessionId: string) {
  set(windows.map((item) => (item.id === id ? { ...item, sessionId } : item)));
}

export function closeSpinOff(id: number) {
  set(windows.filter((item) => item.id !== id));
}

/** Closes the windows following a conversation (it was opened in full). */
export function closeSpinOffsFor(conversationId: string) {
  if (windows.some((item) => item.sessionId === conversationId))
    set(windows.filter((item) => item.sessionId !== conversationId));
}

/** Minimizes a window, or expands (and raises) it. */
export function setSpinOffMinimized(id: number, minimized: boolean) {
  set(
    windows.map((item) =>
      item.id === id
        ? {
            ...item,
            minimized,
            raisedSeq: minimized ? item.raisedSeq : nextSeq(windows),
          }
        : item,
    ),
  );
}

export function useSpinOffWindows() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    spinOffWindows,
    spinOffWindows,
  );
}

/** Widths the row lays windows out with. */
const EXPANDED = 416;
const COLLAPSED = 256;
const GAP = 12;

/**
 * How many windows can be expanded side by side in `width` px when `count`
 * are open (at least one); the rest show collapsed.
 */
export function expandedRoom(width: number, count: number) {
  for (let open = count; open > 1; open--) {
    const closed = count - open;
    if (open * EXPANDED + closed * COLLAPSED + (count - 1) * GAP <= width)
      return open;
  }
  return 1;
}

/**
 * The slots shown expanded: of the windows not minimized, the `room` most
 * recently raised.
 */
export function expandedSlots(list: SpinOffWindow[], room: number) {
  return new Set(
    list
      .filter((item) => !item.minimized)
      .sort((a, b) => b.raisedSeq - a.raisedSeq)
      .slice(0, room)
      .map((item) => item.slot),
  );
}

/** Longest prompt a link may carry. */
const maxLinkPrompt = 14336;

/**
 * A prompt link's words: an address on this page's origin or claude.ai's,
 * `/new`, `composer=mini`, with a non-empty `q` of at most 14336 characters and
 * no user name or password; null otherwise.
 */
export function promptLink(href: string, origins: string[]) {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (
    url.origin === "null" ||
    !origins.includes(url.origin) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/new" ||
    url.searchParams.get("composer") !== "mini"
  )
    return null;
  const q = url.searchParams.get("q");
  return q === null || q.length > maxLinkPrompt || q.trim() === "" ? null : q;
}
