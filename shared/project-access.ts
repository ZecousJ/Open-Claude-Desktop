import type { Project } from "./types";
export type ProjectMetadataPatch = Partial<Pick<Project, "name" | "description" | "pinned" | "instructions">>;

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
export function isEditablePrivateChatProject(project: Project) {
  return isPrivateChatProject(project) && !project.archivedAt;
}
function isPrivateChatProject(project: Project) {
  return (project.kind ?? "chat") === "chat" &&
    (project.visibility === undefined || project.visibility === "private");
}
export function canDeleteOwnedChatProject(project: Project) {
  const rights = ownedProjectCapabilities(project);
  return isPrivateChatProject(project) && rights.canEditInstructions && rights.canEditKnowledgeBase;
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
