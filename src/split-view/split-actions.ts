import {
  arrowFocus,
  columnCount,
  defaultCell,
  fitColumns,
  paneFor,
  readingOrder,
  sameRef,
  stepFocus,
  type Direction,
  type PaneEntry,
  type PanePos,
  type PaneRef,
} from "./split-layout";
import {
  belowCell,
  focusAfterClose,
  movePane,
  placePane,
  removePane,
  rightCell,
} from "./split-layout";
import { setSplitState, splitState } from "./split-state";

/**
 * What the window does to its split view. Each action reads the state, lets
 * the layout rules (split-layout.ts) decide, and writes the result back. The
 * ones that need the window itself (which session is the primary pane, how
 * the primary pane changes) return what the caller must do.
 */

const newKey = () => crypto.randomUUID();

const sessionRef = (id: string): PaneRef => ({ kind: "session", id });

/** The focus index of the pane with this key, or 0 (the primary pane). */
const focusOfKey = (panes: readonly PaneEntry[], key: string | undefined) => {
  const index = panes.findIndex((p) => p.key === key);
  return index === -1 ? 0 : index + 1;
};

/** The pane that has the focus, if it is not the primary pane. */
export const focusedPane = (
  panes: readonly PaneEntry[] = splitState().panes,
  focus = splitState().focus,
) => (focus > 0 ? panes[focus - 1] : undefined);

export function setFocus(focus: number) {
  const { panes, focus: current } = splitState();
  const next = Math.max(0, Math.min(focus, panes.length));
  if (next !== current) setSplitState({ focus: next });
}

/** The window's width allows this many columns; panes past them wait. */
export function setMaxColumns(maxColumns: number) {
  const state = splitState();
  if (maxColumns === state.maxColumns) return;
  const fitted = fitColumns(state.panes, state.parked, maxColumns);
  const changed =
    fitted.panes.length !== state.panes.length ||
    fitted.parked.length !== state.parked.length;
  setSplitState({
    maxColumns,
    ...(changed
      ? {
          panes: fitted.panes,
          parked: fitted.parked,
          weights: undefined,
          focus: focusOfKey(fitted.panes, focusedPane()?.key),
        }
      : {}),
  });
}

export const setWeights = (weights: readonly number[] | undefined) =>
  setSplitState({ weights });

export const setRowSplit = (rowSplit: number) => setSplitState({ rowSplit });

/**
 * Opens a session in the split view (a row's Open in ▸ Split view, Alt-click):
 * the pane already showing it gets the focus; otherwise it takes the given
 * cell or the default one. Returns the focus index it ends on, or null when
 * there was no room.
 */
export function openInSplit(
  id: string,
  primaryId: string | undefined,
  at?: PanePos,
) {
  const state = splitState();
  if (id === primaryId) {
    setSplitState({ focus: 0 });
    return 0;
  }
  const existing = paneFor(state.panes, sessionRef(id));
  if (existing !== -1) {
    setSplitState({ focus: existing + 1 });
    return existing + 1;
  }
  const placed = placePane(
    state.panes,
    { key: newKey(), ref: sessionRef(id) },
    at ?? defaultCell(state.panes, state.maxColumns),
    state.maxColumns,
  );
  if (!placed) return null;
  setSplitState({
    panes: placed.panes,
    focus: placed.focus,
    ...(placed.columnsChanged ? { weights: undefined } : {}),
  });
  return placed.focus;
}

/**
 * New Session on the Right or Below: an empty pane (a new session waiting for
 * its first message). Returns its focus index, or null when the layout has
 * no room for it.
 */
export function openDraft(where: "right" | "below") {
  const state = splitState();
  const cell =
    where === "right"
      ? rightCell(state.panes, state.maxColumns)
      : belowCell(state.panes, state.focus);
  if (!cell) return null;
  const nonce = state.draftNonce + 1;
  const placed = placePane(
    state.panes,
    { key: newKey(), ref: { kind: "draft", nonce } },
    cell,
    state.maxColumns,
  );
  if (!placed) return null;
  setSplitState({
    panes: placed.panes,
    focus: placed.focus,
    draftNonce: nonce,
    ...(placed.columnsChanged ? { weights: undefined } : {}),
  });
  return placed.focus;
}

/** Closes the pane with this key. */
export function closePane(key: string) {
  const state = splitState();
  const index = state.panes.findIndex((p) => p.key === key);
  if (index === -1) return;
  const panes = removePane(state.panes, index + 1);
  setSplitState({
    panes,
    focus: focusAfterClose(state.focus, index + 1, panes.length),
    ...(columnCount(panes) !== columnCount(state.panes)
      ? { weights: undefined }
      : {}),
  });
}

export interface CloseResult {
  /** The session that becomes the primary pane (the primary pane was closed). */
  promote?: string;
  /** The primary pane was closed and only drafts are left: it starts a new session. */
  newSession?: boolean;
}

/**
 * Close Split View: the focused secondary pane closes; the primary pane
 * hands its place to the first pane (reading order) that holds a session.
 */
export function closeFocused(): CloseResult {
  const state = splitState();
  if (!state.panes.length) return {};
  if (state.focus > 0) {
    closePane(state.panes[state.focus - 1].key);
    return {};
  }
  const next = readingOrder(state.panes).find(
    (p) => p.entry.ref.kind === "session",
  );
  if (!next || next.entry.ref.kind !== "session") return { newSession: true };
  const panes = removePane(state.panes, next.focus);
  setSplitState({
    panes,
    focus: 0,
    ...(columnCount(panes) !== columnCount(state.panes)
      ? { weights: undefined }
      : {}),
  });
  return { promote: next.entry.ref.id };
}

/** A pane now shows another session (it opened one from inside). */
export function retarget(key: string, id: string) {
  const state = splitState();
  setSplitState({
    panes: state.panes.map((p) =>
      p.key === key ? { ...p, ref: sessionRef(id) } : p,
    ),
  });
}

/** Turns a pane back into an empty one (its session was left for a new one). */
export function resetToDraft(key: string) {
  const state = splitState();
  const nonce = state.draftNonce + 1;
  setSplitState({
    draftNonce: nonce,
    panes: state.panes.map((p) =>
      p.key === key ? { ...p, ref: { kind: "draft", nonce } } : p,
    ),
  });
}

/** A session no longer exists (or is shown elsewhere): its pane goes. */
export function dropSession(id: string) {
  const state = splitState();
  const ref = sessionRef(id);
  const index = paneFor(state.panes, ref);
  if (index !== -1) closePane(state.panes[index].key);
  if (state.parked.some((p) => sameRef(p.ref, ref)))
    setSplitState({
      parked: state.parked.filter((p) => !sameRef(p.ref, ref)),
    });
}

/**
 * The primary pane moved to a session a pane shows: the pane takes the
 * session the primary pane left (or goes, when that was no session).
 */
export function swapWithPrimary(shownId: string, leftId: string | undefined) {
  const state = splitState();
  const index = paneFor(state.panes, sessionRef(shownId));
  if (index === -1) return;
  if (!leftId || paneFor(state.panes, sessionRef(leftId)) !== -1) {
    closePane(state.panes[index].key);
    return;
  }
  setSplitState({
    panes: state.panes.map((p, i) =>
      i === index ? { ...p, ref: sessionRef(leftId) } : p,
    ),
  });
}

/** A draft pane's first message started a session. */
export function resolveDraft(key: string, id: string) {
  retarget(key, id);
}

/**
 * Moves the focused pane one cell. Returns null when that is not possible,
 * else the session that took the primary pane's place if the move swapped
 * with it.
 */
export function moveFocused(
  direction: Direction,
  primaryId: string | undefined,
): { promoted?: string } | null {
  const state = splitState();
  const moved = movePane(
    state.panes,
    state.focus,
    direction,
    state.maxColumns,
    primaryId ? sessionRef(primaryId) : null,
  );
  if (!moved) return null;
  setSplitState({
    panes: moved.panes,
    focus: moved.focus,
    ...(moved.columnsChanged ? { weights: undefined } : {}),
  });
  return { promoted: moved.promoted };
}

/** Moves the focus to the next or previous pane; returns where it went. */
export function stepFocusBy(step: 1 | -1) {
  const { panes, focus } = splitState();
  if (!panes.length) return null;
  const next = stepFocus(panes, focus, step);
  setSplitState({ focus: next });
  return next;
}

/** Moves the focus to the neighbouring pane in a direction; returns where it went. */
export function moveFocusToward(direction: Direction) {
  const { panes, focus } = splitState();
  if (!panes.length) return null;
  const next = arrowFocus(panes, focus, direction);
  if (next === null || next === focus) return null;
  setSplitState({ focus: next });
  return next;
}
