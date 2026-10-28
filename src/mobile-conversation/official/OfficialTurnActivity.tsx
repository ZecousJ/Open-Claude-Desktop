import type { Turn } from "../../../shared/types";
import { turnActivity } from "../../../shared/activity";
import { ClayMark } from "../../ui/ClayMark";
import { t, useT } from "../../i18n";
import { ThinkingVerb } from "./ThinkingVerb";

/**
 * The working row before any step arrives: Claudex's own working mark (not
 * Anthropic's spark), 8 dp, then the rotating thinking verb. No elapsed time
 * and no connection status text (product rule). While a request waits on the
 * person it says so instead.
 */
export function OfficialTurnActivity({
  turn,
  awaitingApproval,
}: {
  turn: Turn;
  awaitingApproval: boolean;
}) {
  useT();
  const phase = turnActivity(turn, awaitingApproval);
  if (phase === "idle" || phase === "streaming" || phase === "tools")
    return null;
  return (
    <div className="official-activity">
      <ClayMark />
      {phase === "approval" ? (
        <span className="official-activity-text" role="status">
          {t("Waiting for your response")}
        </span>
      ) : (
        <ThinkingVerb />
      )}
    </div>
  );
}
