import type { Mode, Project } from "../../shared/types";

/** A remembered choice only affects ordinary new drafts and current projects. */
export function draftProjectId({
  mode,
  incognito,
  explicitId,
  defaultId,
  projects,
}: {
  mode: Mode;
  incognito: boolean;
  explicitId?: string;
  defaultId?: string;
  projects: readonly Project[];
}): string | undefined {
  if (explicitId !== undefined) return explicitId;
  if (incognito || mode === "code") return undefined;
  return projects.find(
    (project) => project.id === defaultId && !project.archivedAt,
  )?.id;
}
