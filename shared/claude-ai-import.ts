import type { HistoryAddResult } from "./history-import";

export interface ClaudeAiImportAPI {
  claudeAiImportSignIn(): Promise<{ email: string }>;
  claudeAiImportFetch(): Promise<HistoryAddResult[]>;
  claudeAiImportCancel(): Promise<void>;
}
