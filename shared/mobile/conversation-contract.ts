import type { Conversation, Turn } from "../types";

/** Versioned display-only boundary. Never put account credentials in this state. */
export const conversationProtocolVersion = 1 as const;
export interface ConversationMedia {
  /** Raster data URLs only. Keys must belong to the active conversation. */
  attachmentPreviews?: Record<string, string>;
  /** Base64 snapshot bytes, keyed by the snapshot digest already present in a turn. */
  generatedFileBytes?: Record<string, string>;
}
export interface ConversationRenderState {
  version: 1;
  /** Opaque native lease: rotate on login/account/conversation/navigation change. */
  sessionId: string;
  revision: number;
  conversation: Conversation;
  theme: "light" | "dark";
  /** Optional native UI locale; omission uses the existing device/default locale. */
  locale?: string;
  replyFeedback?: Record<string, "up" | "down">;
  sending?: boolean;
  media?: ConversationMedia;
}
export type ConversationChange =
  | { type: "appendItemText"; turnId: string; itemId: string; text: string }
  | { type: "upsertTurn"; turn: Turn }
  | { type: "removeTurn"; turnId: string };
export interface ConversationUpdate {
  version: 1;
  sessionId: string;
  baseRevision: number;
  revision: number;
  changes: ConversationChange[];
  theme?: "light" | "dark";
  /** Omission retains the current locale. */
  locale?: string;
  replyFeedback?: Record<string, "up" | "down">;
  sending?: boolean;
  /** Replace the complete bounded media snapshot; omit to retain, {} to clear. */
  media?: ConversationMedia;
}
/**
 * File identities are claims, not capabilities. Native resolves against its
 * current conversation, never opens an arbitrary supplied path or digest.
 */
export interface ConversationFileIdentity {
  conversationId: string;
  artifactId: string;
  sourcePath?: string;
  sourceDigest?: string;
}
/** A user-cancelled batch reports files already saved; lifecycle cancellation rejects. */
export interface ConversationDownloadResult {
  saved: number;
  cancelled: boolean;
}
export const maxConversationDownloadFiles = 32;
export interface ConversationActionPayloads {
  copyText: { text: string };
  editPrompt: { conversationId: string; turnId: string; text: string };
  retryResponse: { conversationId: string; turnId: string };
  selectVersion: {
    conversationId: string;
    turnId: string;
    versionId: string;
    prompt: boolean;
  };
  replyFeedback: {
    conversationId: string;
    turnId: string;
    rating: "up" | "down" | null;
  };
  continueResponse: { conversationId: string };
  /** Raw selected/rendered text. Native adds Markdown quote prefixes exactly once. */
  quoteReply: { conversationId: string; text: string };
  openAttachment: { conversationId: string; attachmentId: string };
  openArtifact: ConversationFileIdentity;
  downloadArtifact: ConversationFileIdentity;
  /** One gesture authorizes this bounded list only. Native owns the chooser sequence. */
  downloadArtifacts: {
    conversationId: string;
    files: ConversationFileIdentity[];
  };
  openLink: { url: string };
  /** Explicit Load image gesture only; native validates public URL and bounded raster bytes. */
  loadRemoteImage: { url: string };
  openWorkflow: { conversationId: string };
  openAgent: { conversationId: string; agentId: string; turnId?: string };
  openPlan: { conversationId: string };
  openChanges: { conversationId: string };
}
export type ConversationActionType = keyof ConversationActionPayloads;
export type ConversationAction = {
  [K in ConversationActionType]: {
    version: 1;
    sessionId: string;
    requestId: string;
    type: K;
    payload: ConversationActionPayloads[K];
  };
}[ConversationActionType];
export interface ConversationActionResult {
  version: 1;
  sessionId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  cancelled?: boolean;
  /**
   * Explicit Retry/Open link confirmation declined before dispatch or mutation.
   * Only meaningful with ok:false + cancelled:true. Omit for lifecycle/request
   * cancellation, including an operation that may already have been submitted.
   * Export chooser cancellation retains its existing successful result shape.
   */
  cancellationReason?: "userDeclined";
}
export type ConversationEvent =
  | ConversationAction
  | { version: 1; type: "ready" }
  | { version: 1; sessionId: string; type: "stateApplied"; revision: number }
  | {
      version: 1;
      sessionId: string;
      type: "stateRejected";
      revision: number;
      error: string;
    }
  | { version: 1; sessionId: string; type: "cancelRequest"; requestId: string };

/** Read-only source document supplied by the native file viewer after validation. */
export interface ConversationDocumentState {
  version: 1;
  sessionId: string;
  revision: number;
  theme: "light" | "dark";
  /** Optional native UI locale; omission uses the existing device/default locale. */
  locale?: string;
  document: { id: string; language: string; content: string; name: string };
}
