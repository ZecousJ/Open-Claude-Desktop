import type { Item } from "../../shared/types";
import type { Store } from "../store/store";

export function rejectedConnectorTool(item: Item): string | undefined {
  const error: unknown = item.error;
  if (
    item.type !== "mcpToolCall" ||
    item.status !== "failed" ||
    !item.server ||
    item.result != null ||
    !error ||
    typeof error !== "object" ||
    !("message" in error) ||
    typeof error.message !== "string" ||
    !/^    Transport send error: Transport \[(?:codex_rmcp_client::event_notification_transport::EventNotificationTransport<)?rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientWorker<[^\n]+>\] error: Auth required$/m.test(
      error.message,
    )
  )
    return;
  return item.server;
}

const rejections = new WeakMap<Store, Map<string, string>>();

export function recordConnectorAuthRejection(
  store: Store,
  name: string,
  url: string,
) {
  let servers = rejections.get(store);
  if (!servers) rejections.set(store, (servers = new Map()));
  servers.set(name, url);
}

export function connectorAuthRejected(
  store: Store,
  name: string,
  url: string,
  authenticated: boolean,
) {
  const servers = rejections.get(store);
  if (authenticated || servers?.get(name) !== url) {
    servers?.delete(name);
    return false;
  }
  return true;
}
