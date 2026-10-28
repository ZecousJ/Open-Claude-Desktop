import type { AgentPanelTarget } from "../conversation/ToolSidePanel";
import type { Artifact } from "../ui/ArtifactTypes";
import type { DockPanel } from "./useToolPanels";

export interface PaneHandoff {
  sessionId?: string;
  widgetId?: string;
  agent?: AgentPanelTarget;
  artifact?: Artifact;
}

export const paneHandoffKey = (
  account: string,
  conversation: string,
  pane: DockPanel,
) => `claudex.pane-handoff:${account}:${conversation}:${pane}`;

export function savePaneHandoff(
  storage: Pick<Storage, "setItem">,
  key: string,
  value: PaneHandoff,
) {
  storage.setItem(key, JSON.stringify({ at: Date.now(), value }));
}

export function takePaneHandoff(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
): PaneHandoff | undefined {
  const raw = storage.getItem(key);
  if (!raw) return;
  storage.removeItem(key);
  try {
    const saved = JSON.parse(raw);
    if (
      typeof saved.at === "number" &&
      Date.now() - saved.at < 60_000 &&
      saved.value &&
      typeof saved.value === "object"
    )
      return saved.value;
  } catch {}
}
