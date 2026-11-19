import type { Project } from "./types";
import { projectKind } from "./project-kind";

/** Chat sources for Cowork onboarding (live claude.ai bundle, 2026-10-14, c17beaa76). */
export function importableChatProjects(projects: Project[]) {
  return projects.filter(
    (project) =>
      projectKind(project) === "chat" &&
      !project.archivedAt &&
      !project.isStarterProject,
  );
}
