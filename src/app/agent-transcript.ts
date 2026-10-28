import type { AgentPanelTarget } from "../conversation/ToolSidePanel";
import type { AppController } from "./AppContext";

/**
 * Opens a child Agent's transcript beside the conversation, as the original's
 * single Agent row does: no detour through the Background tasks list. For the
 * transcript's Agent rows.
 */
export function openAgentTranscript(
  app: AppController,
  target: AgentPanelTarget,
) {
  app.toolPanels.setAgent(target);
  app.setPanel("agent");
}
