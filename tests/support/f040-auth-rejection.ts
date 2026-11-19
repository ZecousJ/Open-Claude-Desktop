import type { Item } from "../../shared/types";

export const protectedToolFailure = {
  id: "protected-call",
  type: "mcpToolCall",
  server: "wiki",
  mcpAuthRejectionUrl: "https://example.test/mcp",
  tool: "protected_fixture",
  arguments: {},
  status: "failed",
  lifecycleStatus: "completed",
  result: null,
  error: {
    message:
      "tool call error: tool call failed for `wiki/protected_fixture`\n\nCaused by:\n    Transport send error: Transport [codex_rmcp_client::event_notification_transport::EventNotificationTransport<rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientWorker<codex_rmcp_client::http_client_adapter::StreamableHttpClientAdapter>>>] error: Auth required",
  },
} satisfies Item;
