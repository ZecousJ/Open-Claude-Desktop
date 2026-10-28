import { useEffect, useRef } from "react";
import type { Conversation } from "../../shared/types";
import { latestPlan } from "./PlanPanel";

/**
 * A running Code task that reports a task list shows it in the Plan panel, a
 * Cowork task in its Progress card, until the panel is closed for that
 * conversation. Returns the callback to record that close.
 */
export function usePlanPanel(
  active: Conversation | undefined,
  panelOpen: boolean,
  openPlan: (panel: "plan" | "progress") => void,
) {
  const dismissed = useRef(new Set<string>());
  const live =
    (active?.mode === "code" || active?.mode === "cowork") &&
    active.turns.at(-1)?.status === "inProgress" &&
    Boolean(latestPlan(active)?.length);
  useEffect(() => {
    if (live && active && !panelOpen && !dismissed.current.has(active.id))
      openPlan(active.mode === "cowork" ? "progress" : "plan");
  }, [live, active?.id]);
  return (conversationId: string) => dismissed.current.add(conversationId);
}
