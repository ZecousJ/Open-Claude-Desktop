import { useState } from "react";
import { Maximize2, Minimize2, X } from "../ui/glyphs";
import type { Conversation, Item } from "../../shared/types";
import { PlanSteps } from "./PlanSteps";
import { usePaneExpandToggle } from "../app/pane-expand";

export interface PlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed" | string;
}

/** The latest task list Codex reported (turn/plan/updated) in a conversation. */
export function latestPlan(conversation: Conversation): PlanStep[] | undefined {
  for (const turn of [...conversation.turns].reverse()) {
    const item = [...turn.items]
      .reverse()
      .find((value: Item) => value.type === "taskPlan");
    if (Array.isArray(item?.plan) && item.plan.length)
      return item.plan.filter(
        (step: unknown): step is PlanStep =>
          typeof (step as PlanStep)?.step === "string",
      );
  }
}

/** Dashed ring, spinning arc, struck check. */
export function PlanStatusIcon({ status }: { status: PlanStep["status"] }) {
  const common = {
    className: "plan-step-icon",
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": true,
  } as const;
  if (status === "completed")
    return (
      <svg {...common} data-status="completed">
        <path
          d="M1 9.5 4 12.5 9.5 4.5M1.5 9.5H15"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (status === "inProgress")
    return (
      <svg {...common} data-status="inProgress">
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke="currentColor"
          strokeOpacity="0.3"
          strokeWidth="1.5"
        />
        <path
          className="plan-step-arc"
          d="M8 2a6 6 0 0 1 6 6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <svg {...common} data-status="pending">
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeDasharray="2.2 2.5"
      />
    </svg>
  );
}

/** Code "Plan" side panel listing the agent's tasks. */
export function PlanPanel({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  usePaneExpandToggle("plan", () => setExpanded((value) => !value));
  const plan = latestPlan(conversation) ?? [];
  return (
    <aside
      className={`work-panel plan-panel${expanded ? " expanded" : ""}`}
      aria-label="Plan"
    >
      <header>
        <strong>Plan</strong>
        <div>
          <button
            aria-label={expanded ? "Restore plan" : "Expand plan"}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button aria-label="Close plan" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="plan-panel-body">
        <h2>Tasks</h2>
        {plan.length ? (
          <PlanSteps
            conversationId={conversation.id}
            plan={plan}
            live={conversation.turns.at(-1)?.status === "inProgress"}
          />
        ) : (
          <p className="plan-empty">No tasks yet</p>
        )}
      </div>
    </aside>
  );
}
