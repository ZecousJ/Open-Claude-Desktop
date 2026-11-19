import { z } from "zod";
import type { Project } from "./types";

export const projectTemplateInput = z.object({
  type: z.literal("student"),
  subtype: z.enum(["study", "career", "research"]),
});

export type ProjectTemplate = z.infer<typeof projectTemplateInput>;

/** A retry may confirm the original creation, never overwrite later edits. */
export function sameProjectCreation(existing: Project, requested: Project): boolean {
  return existing.id === requested.id &&
    (existing.kind ?? "chat") === (requested.kind ?? "chat") &&
    existing.name === requested.name &&
    (existing.description ?? "") === (requested.description ?? "") &&
    (existing.instructions ?? "") === (requested.instructions ?? "") &&
    existing.template?.type === requested.template?.type &&
    existing.template?.subtype === requested.template?.subtype &&
    existing.creationReceipt?.operationId === requested.creationReceipt?.operationId &&
    existing.creationReceipt?.digest === requested.creationReceipt?.digest &&
    !!existing.pinned === !!requested.pinned &&
    !existing.archivedAt;
}
