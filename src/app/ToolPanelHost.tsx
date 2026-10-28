import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../desktop-api";
import type { Conversation } from "../../shared/types";
import { browserPolicyOf } from "../../shared/client-policy";
import {
  ToolSidePanel,
  type AgentPanelTarget,
  type SidePanel,
} from "../conversation/ToolSidePanel";
import type { BrowserPanelEnv } from "../browser/BrowserPanel";
import { browserToggleShown } from "../browser/browser-model";
import { useHostCapability } from "../host/HostContext";
import { workflowsIn } from "../../shared/workflow-model";
import { useApp, type AppController } from "./AppContext";
import { ToolDock } from "./ToolDock";
import { isDockPanel } from "./useToolPanels";
import { openArtifact, ArtifactPanelHost } from "./ArtifactHost";
import { surface } from "../../shared/host";
import { useSheetDrag } from "../ui/sheet-drag";
import { maxAttachmentsFor } from "../composer/attachment-limits";
import { attachTerminalSelection } from "../composer/terminal-excerpt";

export { openAgentTranscript } from "./agent-transcript";

/**
 * The Browser panel's window state (R8-D), or undefined when this window has no
 * Browser: the web app, a conversation that is not Code, an administrator who
 * turned it off. Browser tools off still allows Preview.
 */
function useBrowserEnv(
  app: AppController,
  active: Conversation,
  split: boolean,
): BrowserPanelEnv | undefined {
  const capability = useHostCapability("browserPanel");
  const settings = app.snapshot.settings as unknown as Record<string, unknown>;
  const policy = browserPolicyOf(app.policy);
  if (
    !browserToggleShown({
      mode: active.mode,
      cloudHosted: active.cloudHosted,
      capability,
      policyEnabled: policy.enabled,
      settings,
    })
  )
    return undefined;
  return {
    settings,
    policy,
    split,
    onPreference: (patch) =>
      app.updatePreference(patch as Parameters<typeof app.updatePreference>[0]),
    onConfirm: app.setConfirm,
    onDraft: (change) => {
      app.setText(change);
      requestAnimationFrame(() => app.composer.current?.focus());
    },
    onAttach: (attachments) => {
      app.setAttachments((current) =>
        [...current, ...attachments].slice(0, maxAttachmentsFor(active.mode)),
      );
      requestAnimationFrame(() => app.composer.current?.focus());
    },
    onNotify: app.notify,
  };
}

/**
 * The tool panels beside the conversation: Progress alone, or the dock's cards
 * side by side — Background tasks, Changes and Browser stacked in a column,
 * Terminal in its own.
 */
export function ToolPanelHost({
  panel,
  active,
}: {
  panel: SidePanel;
  active: Conversation;
}) {
  const app = useApp();
  const { dock, single, close } = app.toolPanels;
  const browser = useBrowserEnv(app, active, false);
  const { upsert, setSnapshot, snapshot } = app;
  // The terminal's selection goes to this conversation's draft only while
  // it is still the open one (a slow attach may outlive a switch).
  const openId = useRef(app.activeId);
  openId.current = app.activeId;
  const closeCard = (shown: SidePanel) => {
    if (
      app.windowRole.kind === "conversation" &&
      app.windowRole.pane === shown
    ) {
      void api.windowAction("close").catch(app.report);
      return;
    }
    if (shown === "plan" || shown === "progress") app.dismissPlan(active.id);
    // Each card closes on its own; the dock's others stay.
    close(shown);
  };
  // On a phone a lone panel is a sheet that a drag down closes (95-web.css).
  // The panels draw their own root, some after a lazy load, so it is found
  // in the layout.
  const lone = Boolean(single) || !isDockPanel(panel);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const layout = document.querySelector(".workspace > .chat-layout");
    if (surface !== "web" || !lone || !layout) return;
    const find = () =>
      setSheet(layout.querySelector<HTMLElement>(":scope > .work-panel"));
    find();
    const observer = new MutationObserver(find);
    observer.observe(layout, { childList: true });
    return () => observer.disconnect();
  }, [panel, lone]);
  const sheetRef = useMemo(() => ({ current: sheet }), [sheet]);
  useSheetDrag(sheetRef, () => closeCard(panel), surface === "web" && lone);
  const card = (shown: SidePanel) =>
    shown === "artifact" ? (
      app.artifact ? (
        <ArtifactPanelHost key="artifact" artifact={app.artifact} />
      ) : null
    ) : (
      <ToolSidePanel
        key={shown}
        panel={shown}
        conversation={active}
        accountId={app.accountId}
        agent={app.toolPanels.agent}
        browser={browser}
        onAttachSelection={(text, label) =>
          void attachTerminalSelection(
            {
              mode: active.mode,
              attachments: app.attachments,
              setAttachments: app.setAttachments,
              notify: app.notify,
              stillOpen: () => openId.current === active.id,
              focus: () =>
                requestAnimationFrame(() => app.composer.current?.focus()),
            },
            text,
            label,
          ).catch(app.report)
        }
        onClose={() => closeCard(shown)}
        onShowBackground={() => app.setPanel("background")}
        onArtifact={(value) => openArtifact(app, value)}
        onStopAgent={async (conversationId, ids) => {
          for (const id of ids)
            upsert(await api.stopWorkflowAgent(conversationId, id));
        }}
        onStopRun={async (conversationId, runId) => {
          await api.stopWorkflowRun(conversationId, runId);
        }}
        onRefreshWorkflow={async () => {
          // Only the open conversation's tasks are listed (G-51).
          const current = (app.latest.current?.conversations ?? []).filter(
            (c) => c.id === active.id,
          );
          const ids = [
            ...new Set(
              workflowsIn(current)
                .filter((w) => w.status === "running")
                .map((w) => w.conversationId),
            ),
          ];
          for (const id of ids) upsert(await api.refreshWorkflowAgents(id));
        }}
        onListTerminals={
          surface === "web"
            ? undefined
            : (id) => api.listBackgroundTerminals(id)
        }
        onStopTerminal={(id, processId) =>
          api.stopBackgroundTerminal(id, processId)
        }
        onStopCommand={(id) => api.interrupt(id)}
        onReadAgent={(id, agentId) => api.readWorkflowAgent(id, agentId)}
        onClearFinished={async (ids) => {
          const dismissedBackgroundTasks =
            await api.clearFinishedBackgroundTasks(ids);
          setSnapshot((current) =>
            current ? { ...current, dismissedBackgroundTasks } : current,
          );
        }}
        dismissedFinished={snapshot.dismissedBackgroundTasks ?? []}
        engineReady={snapshot.engine.state === "ready"}
        onError={app.report}
      />
    );
  if (lone) return card(panel);
  // Keyed, so a card stays mounted when another opens or closes. The
  // Browser shows only where the window has one.
  const shown = dock.filter(
    (p) => (p !== "browser" || browser) && (p !== "artifact" || app.artifact),
  );
  if (app.artifact && !shown.includes("artifact")) shown.push("artifact");
  return <ToolDock panels={shown} accountId={app.accountId} card={card} />;
}
