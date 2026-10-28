/**
 * Artifacts, the file viewer and local sharing. Handlers are in
 * `electron/ipc/artifacts.ts` and `electron/ipc/artifact-library.ts`.
 */
import type {
  ArtifactLibraryState,
  GeneratedFile,
  ArtifactShareInfo,
  ArtifactShareInput,
  SavedArtifact,
} from "./types";
import { bridgeMethods } from "./bridge-methods";
import type { DocumentConnector, DocumentCloudSave } from "./artifact-document";
import type { WidgetResource } from "./widget";
import type { McpResourceFile, McpResourceRead } from "./message-resources";
import type {
  ArtifactToolCall,
  ArtifactToolRequest,
  ArtifactToolGroup,
} from "./artifact-tools";
import type {
  ArtifactNote,
  ArtifactNotePatch,
  ArtifactNotes,
} from "./artifact-notes";
import type {
  ArtifactDataRequest,
  ArtifactDataResult,
  ArtifactDataUsage,
} from "./artifact-data";

export interface ArtifactsAPI {
  createBlankArtifact(
    input: import("./blank-artifacts").CreateBlankArtifactInput,
  ): Promise<import("./blank-artifacts").CreatedBlankArtifact>;
  readBlankArtifact(
    input: import("./blank-artifacts").BlankArtifactInput,
  ): Promise<import("./blank-artifacts").BlankArtifactDocument>;
  saveBlankArtifact(
    input: import("./blank-artifacts").SaveBlankArtifactInput,
  ): Promise<import("./blank-artifacts").SaveBlankArtifactResult>;
  restoreArtifactVersion(
    conversationId: string,
    path: string,
    digest: string,
  ): Promise<boolean>;
  readMcpResource(
    conversationId: string,
    itemId: string,
    uri: string,
  ): Promise<McpResourceRead>;
  readMcpResourceChunk(downloadId: string, offset: number): Promise<string>;
  saveMcpResourceFile(file: McpResourceFile): Promise<string | null>;
  artifactData(
    identity: string,
    request: ArtifactDataRequest,
  ): Promise<ArtifactDataResult>;
  artifactDataUsage(identity: string): Promise<ArtifactDataUsage>;
  requestArtifactStorageLimit(identity: string): Promise<ArtifactDataUsage>;
  artifactDocumentConnectors(): Promise<DocumentConnector[]>;
  translateArtifactDocument(markdown: string, locale: string): Promise<string>;
  saveArtifactDocument(input: DocumentCloudSave): Promise<void>;
  saveArtifactBytes(name: string, base64: string): Promise<string | null>;
  exportDocumentPdf(title: string, html: string): Promise<string | null>;
  captureArtifactScreenshot(html: string): Promise<string>;
  widgetResource(
    conversationId: string,
    toolUseId: string,
  ): Promise<WidgetResource>;
  artifactTools(): Promise<
    {
      server: string;
      tools: { name: string; description?: string; inputSchema?: unknown }[];
    }[]
  >;
  requestArtifactTool(
    identity: string,
    call: ArtifactToolCall,
  ): Promise<ArtifactToolRequest>;
  respondArtifactTool(id: string, allow: boolean): Promise<unknown>;
  artifactToolPermissions(identity: string): Promise<ArtifactToolGroup[]>;
  revokeArtifactTools(identity: string, server?: string): Promise<void>;
  /** The account's artifact names, open times and comments (shared/artifact-notes.ts). */
  artifactNotes(): Promise<ArtifactNotes>;
  updateArtifactNote(
    key: string,
    patch: ArtifactNotePatch,
  ): Promise<ArtifactNote | null>;
  /** Moves notes an earlier version kept in window storage; notes already saved win. */
  importArtifactNotes(notes: ArtifactNotes): Promise<ArtifactNotes>;
  duplicateArtifact(input: {
    name: string;
    language: string;
    content: string;
    originConversationId?: string;
  }): Promise<{ artifact: SavedArtifact; library: ArtifactLibraryState }>;
  deleteArtifactCopy(libraryId: string): Promise<ArtifactLibraryState>;
  pinArtifact(identity: string, pinned: boolean): Promise<ArtifactLibraryState>;
  syncArtifactShare(input: ArtifactShareInput): Promise<ArtifactShareInfo>;
  setArtifactShare(
    input: ArtifactShareInput,
    patch: { visibility?: "private" | "link"; showInList?: boolean },
  ): Promise<ArtifactShareInfo>;
  createArtifactPreview(content: string): Promise<string>;
  /**
   * AI-powered artifacts: answers an artifact's `window.claude.complete`
   * prompt with the account's model; refused while the setting is off.
   */
  artifactComplete(prompt: string): Promise<string>;
  releaseArtifactPreview(url: string): Promise<void>;
  /**
   * Opens a sandboxed preview document in its own window; with `source`,
   * its toolbar can download the artifact and copy it as Markdown.
   */
  popOutArtifact(
    title: string,
    content: string,
    source?: {
      filename?: string;
      source?: string;
      sourceBase64?: string;
      previewDownload?: boolean;
      language?: string;
      pdfLabel?: string;
      pdfError?: string;
    },
  ): Promise<void>;
  saveArtifact(name: string, content: string): Promise<string | null>;
  /**
   * File ▸ Open File…: the system file picker, then the chosen file read for
   * the file viewer; null when the picker is cancelled. A file that cannot
   * be previewed comes back with `error` set.
   */
  chooseLocalFile(): Promise<GeneratedFile | null>;
  /** Base64 bytes of a binary generated-file snapshot. */
  readGeneratedFile(digest: string): Promise<string>;
  saveGeneratedFile(digest: string, name: string): Promise<string | null>;
  /**
   * Snapshots a picture the image tool saved (an `imageGeneration` item's
   * `savedPath`) for its thumbnail and the file viewer. Only PNG, JPEG or
   * WebP files up to 10 MB in Codex's generated images folder; null when
   * the file is gone.
   */
  imageGenerationSnapshot(savedPath: string): Promise<GeneratedImage | null>;
  /**
   * Snapshots a picture the agent viewed (an `imageView` item's path), only
   * inside the conversation's working folders; null when it is gone.
   */
  viewedImageSnapshot(
    conversationId: string,
    path: string,
  ): Promise<GeneratedImage | null>;
}

/** A generated picture's profile snapshot, read with `readGeneratedFile`. */
export interface GeneratedImage {
  digest: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
}

export const artifactsMethods = bridgeMethods<ArtifactsAPI>({
  createBlankArtifact: true,
  readBlankArtifact: true,
  saveBlankArtifact: true,
  restoreArtifactVersion: true,
  captureArtifactScreenshot: true,
  readMcpResource: true,
  readMcpResourceChunk: true,
  saveMcpResourceFile: true,
  artifactData: true,
  artifactDataUsage: true,
  requestArtifactStorageLimit: true,
  artifactDocumentConnectors: true,
  translateArtifactDocument: true,
  saveArtifactDocument: true,
  saveArtifactBytes: true,
  exportDocumentPdf: true,
  widgetResource: true,
  artifactTools: true,
  requestArtifactTool: true,
  respondArtifactTool: true,
  artifactToolPermissions: true,
  revokeArtifactTools: true,
  artifactNotes: true,
  updateArtifactNote: true,
  importArtifactNotes: true,
  duplicateArtifact: true,
  deleteArtifactCopy: true,
  pinArtifact: true,
  syncArtifactShare: true,
  setArtifactShare: true,
  createArtifactPreview: true,
  artifactComplete: true,
  releaseArtifactPreview: true,
  popOutArtifact: true,
  saveArtifact: true,
  chooseLocalFile: true,
  readGeneratedFile: true,
  saveGeneratedFile: true,
  imageGenerationSnapshot: true,
  viewedImageSnapshot: true,
});
