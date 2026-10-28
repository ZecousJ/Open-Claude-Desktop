import type { Project } from "./types";

// Chat, Code, Local.
export function projectKind(project: Project) {
  return (
    project.kind ??
    (project.environment && project.environment.kind !== "local"
      ? "code"
      : project.cwd
        ? "local"
        : "chat")
  );
}
