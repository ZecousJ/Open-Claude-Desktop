import type { Project } from "./types";

// Chat, Code, Local (live claude.ai bundle, 2026-10-14, c17beaa76-CrQT9ilA.js).
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
