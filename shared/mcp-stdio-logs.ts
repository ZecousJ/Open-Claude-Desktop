export const mcpStdioCaptureEnvironment = "CLAUDEX_MCP_STDIO_CAPTURE";
export const mcpStdioFileBytes = 10 * 1024 * 1024;
export const mcpStdioFiles = 5;
export interface McpStdioLogSnapshot {
  source: "stdio-stderr";
  availability: "pending" | "available" | "unsupported" | "unavailable";
  lines: string[];
  truncated: boolean;
}
/** Private process environment only. Never argv, settings, IPC, or a file. */
export interface McpStdioDescriptor {
  directory: string;
  owner: string;
  version: string;
  token: string;
  command: string;
  args: string[];
  cwd?: string;
  environment: Record<string, string>;
  restoreRunAsNode?: { value?: string };
  secrets: string[];
}

export interface McpStdioBootstrap {
  socketPath: string;
  owner: string;
  version: string;
  token: string;
}
