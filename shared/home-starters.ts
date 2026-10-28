// Visibility and checklist state. Experiments default off, not to a guessed
// rollout.
export const homeChecklistTasks = [
  "setup_project",
  "explore_skills",
  "try_claude_code",
  "setup_cowork",
  "connect_tools",
  "prosumer_import_memory",
  "prosumer_create_file",
  "prosumer_create_app",
  "prosumer_explore_imagine",
] as const;
export type HomeChecklistTask = (typeof homeChecklistTasks)[number];
export interface HomeStarters {
  chipsOverride?: "show" | "hide";
  prosumer_checklist_hide_prompt_chips?: boolean;
  prosumer_checklist_v2?: Partial<Record<HomeChecklistTask, boolean>>;
  checklist?: {
    dismissed?: boolean;
    tasks?: Partial<
      Record<
        HomeChecklistTask,
        {
          clicked?: boolean;
          dismissed?: boolean;
          seen?: number;
        }
      >
    >;
  };
}

export function checklistRows(config: HomeStarters) {
  const rows = homeChecklistTasks.filter(
    (key) =>
      config.prosumer_checklist_v2?.[key] &&
      !config.checklist?.tasks?.[key]?.dismissed,
  );
  return rows.sort(
    (left, right) =>
      Number(!!config.checklist?.tasks?.[left]?.clicked) -
      Number(!!config.checklist?.tasks?.[right]?.clicked),
  );
}

export function checklistShowing(config: HomeStarters) {
  const incomplete = checklistRows(config).filter(
    (key) => !config.checklist?.tasks?.[key]?.clicked,
  );
  return (
    !config.checklist?.dismissed &&
    incomplete.length > 0 &&
    !incomplete.every((key) => (config.checklist?.tasks?.[key]?.seen ?? 0) >= 3)
  );
}
