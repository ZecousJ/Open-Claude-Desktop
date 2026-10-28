import { bridgeMethods } from "./bridge-methods";

export type PrivacyDataAvailability =
  | { supported: true }
  | {
      supported: false;
      reason: "local-account" | "unsupported-service" | "unsupported-host";
    };
export interface PrivacyDataStatus {
  feedback: PrivacyDataAvailability;
  uploads: PrivacyDataAvailability;
}
export interface FeedbackHistoryItem {
  id: string;
  createdAt: string;
  rating: "up" | "down";
  categories: string[];
  comment: string;
  hasExcerpt: boolean;
}
export interface FeedbackHistoryPage {
  items: FeedbackHistoryItem[];
  nextCursor?: string;
}
export interface UploadedFileItem {
  id: string;
  name: string;
  bytes: number;
  uploadedAt: number | null;
  /** Where it was attached: Code sessions, or Chat (Cowork included). */
  surface: "chat" | "code";
  locations: { conversationId: string; title: string }[];
  /** Only app-owned attachment copies; never an external original. */
  storage: "managed-attachment";
}
export interface UploadedFilesPage {
  items: UploadedFileItem[];
  nextCursor?: string;
  /** This protocol does not enumerate project knowledge or transfer blobs. */
  complete: false;
  scope: "managed-attachments";
  skipped: number;
  truncated: boolean;
}
export interface PrivacyDataAPI {
  privacyDataStatus(): Promise<PrivacyDataStatus>;
  feedbackHistory(input?: { cursor?: string }): Promise<FeedbackHistoryPage>;
  withdrawFeedback(id: string): Promise<{ withdrawn: true }>;
  uploadedFiles(input?: { cursor?: string }): Promise<UploadedFilesPage>;
  /** Removes one stored copy; chats keep the text already taken from it. */
  deleteUploadedFile(id: string): Promise<{ deleted: true }>;
}
export const privacyDataMethods = bridgeMethods<PrivacyDataAPI>({
  privacyDataStatus: true,
  feedbackHistory: true,
  withdrawFeedback: true,
  uploadedFiles: true,
  deleteUploadedFile: true,
});
