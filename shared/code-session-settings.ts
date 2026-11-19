import type { ClientPolicy } from "./client-policy";
import { validGatewayEfforts } from "./gateway-signals";
import type { SettingsPreferences } from "./settings-extras";

export class CodeUltracodeUnavailable extends Error {
  constructor() {
    super("Ultracode is unavailable for this Code session.");
  }
}

export function supportsCodeUltracode(efforts: unknown): boolean {
  return validGatewayEfforts(efforts) && efforts.includes("xhigh");
}

/**
 * Whether dynamic workflows run: the user's switch, else the service's
 * default for the account, else on (owner, 2026-10-14: on by default; the
 * original makes it depend on the plan, live claude.ai bundle, 2026-10-14,
 * cd19fedd2-Boqq6KGj.js). An administrator's off always wins.
 */
export function dynamicWorkflowsEnabled(
  settings: SettingsPreferences,
  policy: Pick<
    ClientPolicy,
    "workflows" | "workflowsDefaultOn" | "planLabel"
  > = { planLabel: null },
) {
  return (
    policy.workflows !== false &&
    (settings.workflows?.enabled ?? policy.workflowsDefaultOn ?? true)
  );
}
