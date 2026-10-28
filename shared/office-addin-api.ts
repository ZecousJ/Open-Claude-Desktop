import { bridgeMethods } from "./bridge-methods";

export type OfficeApp = "excel" | "word" | "powerpoint";
export interface OfficeConnectedFile {
  id: string;
  addinId: string;
  app: OfficeApp;
  document: string;
  status: "connected" | "working" | "editing" | "disconnected";
  isSelected: boolean;
  lastConnectedAt: number;
  lastActivityAt: number;
}
export interface OfficeHandoff {
  sessionId: string;
  filePath: string;
  title: string;
  messages: { role: string; text: string }[];
  strippedToolCalls: number;
  omittedByRenderer: number;
}
export interface OfficeConversationSummary {
  summary: string;
  taskTitle?: string;
  conversationId?: string;
  isStreaming?: boolean;
}
export interface OfficeAddinAPI {
  officeConnectedFiles(): Promise<OfficeConnectedFile[]>;
  officeSelectFile(id: string): Promise<boolean>;
  officeFocusFile(id: string): Promise<boolean>;
  officeUpdateActiveConversationSummary(
    summary: OfficeConversationSummary | null,
  ): Promise<void>;
  officeQueuePorterHandoff(
    input: OfficeHandoff,
  ): Promise<{ queued: boolean; handoffId?: string }>;
  officeCancelPorterHandoff(handoffId: string): Promise<void>;
  officeInstallAddin(): Promise<{ manifestPath: string }>;
}
export const officeAddinMethods = bridgeMethods<OfficeAddinAPI>({
  officeConnectedFiles: true,
  officeSelectFile: true,
  officeFocusFile: true,
  officeUpdateActiveConversationSummary: true,
  officeQueuePorterHandoff: true,
  officeCancelPorterHandoff: true,
  officeInstallAddin: true,
});
