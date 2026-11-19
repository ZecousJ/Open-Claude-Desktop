export interface ImportedCodeTranscriptRow {
  type: "user" | "assistant" | "system";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  isSidechain: boolean;
  isMeta?: boolean;
  parent_tool_use_id?: string;
  agentId?: string;
  message: {
    role: "user" | "assistant";
    content: string | Record<string, unknown>[];
    stop_reason?: string | null;
    usage?: Record<string, unknown> | null;
  };
  toolUseResult?: unknown;
  mcpMeta?: Record<string, unknown>;
  claudexToolProgress?: string;
  claudexToolResultWarnings?: string[];
  claudexUnsupported?: string[];
  claudexReasoning?: string[];
  claudexSentPrompts?: string[];
  origin?: Record<string, unknown>;
  codeOutput?: { turnId: string; itemId: string; fileId?: string };
  isApiErrorMessage?: boolean;
  subtype?: string;
  content?: string;
  compact_metadata?: Record<string, unknown>;
  compactMetadata?: Record<string, unknown>;
  status?: string | null;
  compact_result?: string;
}
