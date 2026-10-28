import type { Project } from "./types";
import { projectKind } from "./project-kind";

/** Chat sources for Cowork onboarding. */
export function importableChatProjects(projects: Project[]) {
  return projects.filter(
    (project) =>
      projectKind(project) === "chat" &&
      !project.archivedAt &&
      !project.isStarterProject,
  );
}
