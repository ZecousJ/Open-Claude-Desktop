import type { Routine } from "../../shared/routines";
import { inAdapterScope, type AdapterScope } from "./api/scope";
import { readState } from "./api/state";

export const scheduledTaskPreferenceKeys = {
  code: "ccdScheduledTasksEnabled",
  cowork: "coworkScheduledTasksEnabled",
} satisfies Record<Routine["mode"], string>;

export function officialScheduledTaskModes(scope: AdapterScope) {
  const preferences = inAdapterScope(scope, () =>
    readState<Record<string, unknown> | null>("preferences", {}),
  );
  // Profiles with no renderer snapshot still follow the scheduler's policy.
  return {
    code: preferences?.[scheduledTaskPreferenceKeys.code] !== false,
    cowork: preferences?.[scheduledTaskPreferenceKeys.cowork] !== false,
  };
}
