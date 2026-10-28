import type { Conversation, Project } from "../../shared/types";
import type { ProjectPickerSort } from "./project-picker-preferences";
import { coworkPlaceUsage } from "./cowork-options-model";

/** Sort only by metadata Claudex actually has; no invented edit/shared state. */
export function projectPickerRows(
  projects: Project[],
  conversations: Conversation[],
  query: string,
  sort: ProjectPickerSort,
) {
  const needle = query.trim().toLocaleLowerCase();
  const activity = coworkPlaceUsage(conversations);
  return projects
    .filter(
      (project) =>
        !project.archivedAt &&
        project.name.toLocaleLowerCase().includes(needle),
    )
    .sort((left, right) =>
      sort === "name"
        ? left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          })
        : sort === "created"
          ? right.createdAt - left.createdAt
          : (activity.get(right.id) ?? right.createdAt) -
            (activity.get(left.id) ?? left.createdAt),
    );
}

export function typedProjectName(projects: Project[], query: string) {
  const name = query.trim();
  return name &&
    !projects.some(
      (project) =>
        !project.archivedAt &&
        project.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
    ? name
    : undefined;
}
