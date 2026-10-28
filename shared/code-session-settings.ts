import type { ClientPolicy } from "./client-policy";
import type { SettingsPreferences } from "./settings-extras";

/**
 * Whether dynamic workflows run: the user's switch, else the service's default
 * for the account, else on. An administrator's off always wins.
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
