import {
  captureCodePlacement,
  codeTileIds,
  initialCodeLayout,
  openCodeTile,
  removeCodeTile,
  type CodeLayout,
  type CodePlacement,
} from "./code-pane-layout-model";
import { loadCodeLayout, restoreCodePlacement } from "./code-layout-storage";

export interface CodePaneState {
  layout: CodeLayout;
  closed: Record<string, CodePlacement>;
}
export const codePaneStateKey = (account: string, session: string) =>
  `claudex.code-layout.v1:${encodeURIComponent(account)}:${encodeURIComponent(session)}`;
export const emptyCodePaneState = (): CodePaneState => ({
  layout: initialCodeLayout(),
  closed: {},
});
export function readCodePaneState(
  storage: Pick<Storage, "getItem">,
  key: string,
  known: readonly string[],
): CodePaneState {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 100_000) return emptyCodePaneState();
    const data = JSON.parse(raw);
    const closed: Record<string, CodePlacement> = {};
    for (const id of known) {
      const hint = data.closed?.[id];
      if (
        hint &&
        Array.isArray(hint.anchorIds) &&
        Array.isArray(hint.otherSideIds) &&
        [...hint.anchorIds, ...hint.otherSideIds].every(
          (v) => typeof v === "string" && (v === "chat" || known.includes(v)),
        ) &&
        ["row", "column"].includes(hint.direction) &&
        [0, 1].includes(hint.side) &&
        Number.isFinite(hint.ratio) &&
        hint.ratio >= 0.001 &&
        hint.ratio <= 1000
      )
        closed[id] = hint;
    }
    return {
      layout: loadCodeLayout(data.layout, known) ?? initialCodeLayout(),
      closed,
    };
  } catch {
    return emptyCodePaneState();
  }
}
/** Called with panes actually admitted by ToolPanelHost, after lazy loading. */
export function reconcileCodePaneState(
  state: CodePaneState,
  visible: readonly string[],
): CodePaneState {
  let layout = state.layout;
  const closed = { ...state.closed };
  for (const id of codeTileIds(layout.root)) {
    if (id === "chat" || visible.includes(id)) continue;
    const hint = captureCodePlacement(layout, id);
    if (hint) closed[id] = hint;
    layout = removeCodeTile(layout, id);
  }
  for (const id of visible)
    if (!codeTileIds(layout.root).includes(id)) {
      layout =
        restoreCodePlacement(layout, id, closed[id]) ??
        openCodeTile(layout, id);
      delete closed[id];
    }
  return layout === state.layout ? state : { layout, closed };
}
