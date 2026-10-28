import type { Project } from "./types";
export interface ProjectCapabilities {
  canEditInstructions: boolean;
  canEditKnowledgeBase: boolean;
}
/** Call only after resolving a project in the current account's owned store.
 * Legacy private records are writable; malformed explicit rights deny. */
export function ownedProjectCapabilities(
  project: Project,
): ProjectCapabilities {
  return project.capabilities === undefined
    ? { canEditInstructions: true, canEditKnowledgeBase: true }
    : {
        canEditInstructions: project.capabilities?.canEditInstructions === true,
        canEditKnowledgeBase:
          project.capabilities?.canEditKnowledgeBase === true,
      };
}
export type ProjectReadResult =
  | { status: "ready"; project: Project }
  | { status: "missing" }
  | { status: "forbidden" };
export interface ProjectCreationCapabilities {
  routing: "classic" | "unified" | "legacy-local";
  contextFiles: boolean;
  contextText: boolean;
  localFolders: boolean;
  educationSuggestions: boolean;
}
export interface ProjectContextInput {
  files: { name: string; data: Uint8Array }[];
  text?: string;
}
export interface ProjectCreationOptions {
  location?: string;
  files: { name: string; data: Uint8Array }[];
  projectIds?: string[];
  context?: ProjectContextInput;
  operationId?: string;
}
export interface ProjectAccessAPI {
  readProject(id: string): Promise<ProjectReadResult>;
  projectCreationCapabilities(): Promise<ProjectCreationCapabilities>;
}
