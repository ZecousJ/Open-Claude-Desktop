import type { ProjectKnowledge } from "./collections-api";
export interface PendingKnowledgeFile {
  id: string;
  name: string;
  bytes: number;
  status: "encoding" | "extracting" | "failed";
  error?: string;
}
export interface KnowledgeUploadCapabilities {
  encodingSelection: boolean;
  documentExtraction: boolean;
}
export interface ProjectKnowledgePendingAPI {
  stageProjectKnowledgeFiles(
    projectId: string,
    files: { name: string; data: Uint8Array }[],
  ): Promise<ProjectKnowledge>;
  previewProjectKnowledgeEncoding(
    projectId: string,
    id: string,
    encoding: string,
  ): Promise<{ text: string }>;
  confirmProjectKnowledgeEncoding(
    projectId: string,
    id: string,
    encoding: string,
  ): Promise<ProjectKnowledge>;
  removeProjectKnowledgePending(
    projectId: string,
    id: string,
  ): Promise<ProjectKnowledge>;
}
