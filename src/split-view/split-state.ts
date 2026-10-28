import { useSyncExternalStore } from "react";
import { rowSplitLimits, type PaneEntry } from "./split-layout";
import { loadSplit, saveSplit } from "./split-storage";

/**
 * The window's split view: the panes beside the primary pane, which one has
 * the focus, and the sizes. Like the original's pane store, the panes that
 * hold sessions are kept for the account between launches (drafts are not);
 * the focus and the host's width are not.
 */
export interface SplitState {
  panes: readonly PaneEntry[];
  /** Panes in columns the window has no room for now; they come back with room. */
  parked: readonly PaneEntry[];
  /** 0 is the primary pane, then the panes in list order. */
  focus: number;
  /** How many columns the window is wide enough for. */
  maxColumns: number;
  /** Relative widths of the columns; equal while undefined. */
  weights: readonly number[] | undefined;
  /** The top row's share of the height when a column has two rows. */
  rowSplit: number;
  /** Numbers the drafts. */
  draftNonce: number;
  /** The panes are on screen (the desktop's Code page); read by the event handler. */
  shown: boolean;
}

const initial: SplitState = {
  panes: [],
  parked: [],
  focus: 0,
  maxColumns: 1,
  weights: undefined,
  rowSplit: rowSplitLimits.default,
  draftNonce: 0,
  shown: false,
};

let state = initial;
let loadedFor: string | undefined;
let storageKey = "";
const listeners = new Set<() => void>();

const keyFor = (account: string) => `claudex.splitView.v1.${account}`;

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  if (!storageKey) return;
  try {
    const saved = saveSplit(
      [...state.panes, ...state.parked],
      state.weights,
      state.rowSplit,
    );
    if (saved.panes.length)
      localStorage.setItem(storageKey, JSON.stringify(saved));
    else localStorage.removeItem(storageKey);
  } catch {
    /* The panes simply are not remembered. */
  }
}

/** The state as it is now. */
export const splitState = () => state;

/**
 * Changes the state and tells everyone who reads it. The panes, widths and
 * row split are written to the browser's storage when they changed.
 */
export function setSplitState(patch: Partial<SplitState>) {
  const next = { ...state, ...patch };
  const keep =
    next.panes !== state.panes ||
    next.parked !== state.parked ||
    next.weights !== state.weights ||
    next.rowSplit !== state.rowSplit;
  const same = (Object.keys(patch) as (keyof SplitState)[]).every(
    (name) => state[name] === next[name],
  );
  if (same) return;
  state = next;
  if (keep) persist();
  emit();
}

/**
 * Reads the account's saved panes (once per account). Called while the window
 * renders; listeners only exist after the first render.
 */
export function loadSplitFor(account: string) {
  if (loadedFor === account) return;
  loadedFor = account;
  storageKey = keyFor(account);
  let saved: unknown;
  try {
    const raw = localStorage.getItem(storageKey);
    saved = raw ? JSON.parse(raw) : undefined;
  } catch {
    saved = undefined;
  }
  const loaded = loadSplit(saved);
  // Panes of a window that shrank are still kept; the host trims what shows.
  state = {
    ...initial,
    panes: loaded.panes,
    weights: loaded.weights,
    rowSplit: loaded.rowSplit,
    maxColumns: state.maxColumns,
  };
  emit();
}

/** Forgets everything (tests, and a signed-out window). */
export function resetSplitState() {
  state = initial;
  loadedFor = undefined;
  storageKey = "";
  emit();
}

export function subscribeSplit(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The split view's state, re-read when it changes. */
export function useSplitState() {
  return useSyncExternalStore(subscribeSplit, splitState, splitState);
}

/** The panes whose sessions the split view shows now: what a notification need not mark unread. */
export function splitSessionIds() {
  const ids = new Set<string>();
  if (!state.shown) return ids;
  for (const pane of state.panes)
    if (pane.ref.kind === "session") ids.add(pane.ref.id);
  return ids;
}
