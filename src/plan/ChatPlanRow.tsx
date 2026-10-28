import { useContext } from "react";
import { ChevronRight } from "../ui/glyphs";
import { useT } from "../i18n";
import type { Item } from "../../shared/types";
import { AppContext } from "../app/AppContext";
import type { SidePanel } from "../conversation/ToolSidePanel";
import { PlanStatusIcon, type PlanStep } from "./PlanPanel";
import { requestProgressSteps } from "../cowork/progress-request";

/**
 * A task-list update in the Chat and Cowork transcripts. It is the Code row's
 * "Updated tasks ›" in the chat step-row style; Cowork opens its Progress panel
 * with the steps unfolded, Chat unfolds the list with the Plan panel's glyphs:
 * dashed ring, spinning arc, struck check.
 */
export function ChatPlanRow({ item }: { item: Item }) {
  const t = useT();
  const app = useContext(AppContext);
  const steps: PlanStep[] = Array.isArray(item.plan)
    ? item.plan.filter(
        (step: unknown): step is PlanStep =>
          typeof (step as PlanStep)?.step === "string",
      )
    : [];
  if (!steps.length) return null;
  const progress =
    app?.active?.mode === "cowork" && app.setPanel
      ? () => {
          requestProgressSteps(app.active!.id);
          app.setPanel?.("progress" as SidePanel);
        }
      : undefined;
  return (
    <details className="command-activity chat-plan-row">
      <summary
        onClick={(event) => {
          if (!progress) return;
          event.preventDefault();
          progress();
        }}
      >
        <span>{t("Updated tasks")}</span>
        <ChevronRight size={12} />
      </summary>
      {!progress && (
        <ol className="plan-steps chat-plan-steps">
          {steps.map((step, index) => (
            <li key={index} data-status={step.status}>
              <PlanStatusIcon status={step.status} />
              <span>{step.step}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
