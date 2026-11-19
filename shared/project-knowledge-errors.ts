export type ProjectKnowledgeCapacityCode =
  | "project_file_limit_reached"
  | "project_storage_full";

export class ProjectKnowledgeCapacityError extends Error {
  constructor(readonly code: ProjectKnowledgeCapacityCode, message: string) {
    super(message);
    this.name = "ProjectKnowledgeCapacityError";
  }
}

export function projectKnowledgeCapacityCode(error: unknown): ProjectKnowledgeCapacityCode | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return;
  return error.code === "project_file_limit_reached" || error.code === "project_storage_full"
    ? error.code
    : undefined;
}
