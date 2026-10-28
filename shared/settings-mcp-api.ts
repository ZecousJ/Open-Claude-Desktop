import type { McpStdioLogSnapshot } from "./mcp-stdio-logs";
import { bridgeMethods } from "./bridge-methods";
/** Local MCP review selection limit. */
export const localMcpImportLimit = 5;
/** Settings28/34: bounded diagnostics and review of local, supported MCP configs. */
export interface McpLogSnapshot {
  name: string;
  /** Connection lifecycle events reported by the runtime; never arbitrary files. */
  kind: "connection-events";
  serverOutput?: McpStdioLogSnapshot;
  lines: string[];
  truncated: boolean;
}

export type LocalMcpReviewState =
  "available" | "duplicate" | "name-in-use" | "managed" | "unsupported";
export interface LocalMcpCandidate {
  id: string;
  name: string;
  source: string;
  state: LocalMcpReviewState;
  /** Redacted, inert text. The original credentials remain on the host. */
  preview: string;
  reason?: string;
}
export interface LocalMcpDiscovery {
  token: string;
  candidates: LocalMcpCandidate[];
  sources: {
    name: string;
    state: "read" | "missing" | "error";
    message?: string;
  }[];
}
export interface LocalMcpImportRequest {
  token: string;
  ids: string[];
}
export interface LocalMcpImportResult {
  imported: string[];
  disabled: true;
}
export interface McpSettingsAPI {
  readMcpLogs(name: string): Promise<McpLogSnapshot>;
  discoverLocalMcp(): Promise<LocalMcpDiscovery>;
  /** Adds the reviewed entries disabled. Never replaces an existing name. */
  importLocalMcp(request: LocalMcpImportRequest): Promise<LocalMcpImportResult>;
}
export const mcpSettingsMethods = bridgeMethods<McpSettingsAPI>({
  readMcpLogs: true,
  discoverLocalMcp: true,
  importLocalMcp: true,
});
