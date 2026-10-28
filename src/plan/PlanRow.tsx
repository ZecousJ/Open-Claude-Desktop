import { useContext } from "react";
import { useT } from "../i18n";
import { ChevronRight } from "../ui/glyphs";
import type { Item } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import { AppContext } from "../app/AppContext";
import { requestPlanReveal } from "./plan-reveal";

/**
 * A task-list update in the Code transcript; the list itself lives in the Plan
 * panel. The row reads as the original's TodoWrite row: "Updating todos" while
 * it is written, "Updated todos" after, "Cleared todos" for an empty list.
 */
export function PlanRow({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const t = useT();
  const app = useContext(AppContext);
  return (
    <button
      type="button"
      className="code-command code-plan-row"
      onClick={() => {
        // The panel points at the step being worked on (plan-reveal.ts).
        if (app?.active) requestPlanReveal(app.active.id);
        onOpen();
      }}
    >
      <span className="code-command-label">
        {t(
          itemIsRunning(item)
            ? "Updating todos"
            : Array.isArray(item.plan) && item.plan.length === 0
              ? "Cleared todos"
              : "Updated todos",
        )}
      </span>
      <ChevronRight size={16} strokeWidth={1.75} />
    </button>
  );
}
