import { useState } from "react";
import type { Conversation } from "../../shared/types";
import { api } from "../desktop-api";
import { formatText } from "../i18n";
import { NoticeView } from "../policy/NoticeView";
import type {
  ComposerNoticeVariant,
  NoticeContent,
} from "../policy/notice-content";
import { workflowsIn } from "../../shared/workflow-model";
import { compactTokens, workflowSizeWarning } from "./workflow-size";

const dismissed = new Set<string>();

/**
 * "{name} is larger than most workflows." above a Code session's composer: how
 * many agents are scheduled or tokens projected, Stop workflow and View
 * workflow; dismissible for that run.
 */
export function WorkflowSizeBand({
  conversation,
  variant,
  onView,
  onError,
}: {
  conversation: Conversation | undefined;
  variant: ComposerNoticeVariant;
  onView: () => void;
  onError: (error: unknown) => void;
}) {
  const [, setDismissals] = useState(0);
  const [stopping, setStopping] = useState(false);
  if (!conversation || conversation.mode !== "code") return null;
  const found = workflowsIn([conversation])
    .filter((task) => !dismissed.has(task.id))
    .map((task) => ({ task, warning: workflowSizeWarning(task) }))
    .find((entry) => entry.warning);
  if (!found?.warning) return null;
  const { task, warning } = found;
  const named = Boolean(task.title);
  const title = named
    ? formatText("{name} is larger than most workflows.", { name: task.title })
    : formatText("This workflow is larger than most.");
  const tokens = compactTokens(warning.projectedTokens);
  const agents = warning.scheduledAgents;
  const detail =
    warning.axis === "agents"
      ? formatText(
          named
            ? agents === 1
              ? "Up to {agents} agent scheduled."
              : "Up to {agents} agents scheduled."
            : "Up to {agents} agents scheduled, more than most workflows use.",
          { agents },
        )
      : warning.axis === "tokens"
        ? formatText(
            named
              ? "As many as {tokens} tokens projected."
              : "As many as {tokens} tokens projected, more than most workflows use.",
            { tokens },
          )
        : formatText(
            "Up to {agents} agents scheduled, about {tokens} tokens projected.",
            {
              agents,
              tokens,
            },
          );
  const content: NoticeContent = {
    kind: "workflow",
    tone: "warning",
    icon: "info",
    title,
    detail,
    secondary: { kind: "read", label: "View workflow" },
    action: {
      kind: "continue",
      label: stopping ? "Stopping…" : "Stop workflow",
      disabled: stopping,
    },
    dismissible: true,
    role: "status",
  };
  const stop = () => {
    setStopping(true);
    const running = task.agents
      .filter((agent) => ["running", "pendingInit"].includes(agent.status))
      .map((agent) => agent.id);
    void (
      task.runId
        ? api.stopWorkflowRun(task.conversationId, task.runId)
        : Promise.all(
            running.map((id) => api.stopWorkflowAgent(task.conversationId, id)),
          )
    )
      .catch(onError)
      .finally(() => setStopping(false));
  };
  return (
    <div className="composer-notice-slot" data-state="open">
      <div>
        <NoticeView
          content={content}
          surface="code"
          variant={variant}
          onSecondary={onView}
          onAction={stop}
          onDismiss={() => {
            dismissed.add(task.id);
            setDismissals((n) => n + 1);
          }}
        />
      </div>
    </div>
  );
}
