import type { McpServerState } from "../../../shared/settings-desktop-api";

export interface ReconnectQueue {
  account: string;
  startedAt: number;
  connectors: { name: string; url: string }[];
  waiting?: string;
}

export const reconnectQueueKey = "claudex:connector-reconnect";

export function readReconnectQueue(
  raw: string | null,
  account: string,
  now = Date.now(),
): ReconnectQueue | undefined {
  try {
    const queue = JSON.parse(raw ?? "null") as ReconnectQueue;
    if (
      queue?.account !== account ||
      !Number.isFinite(queue.startedAt) ||
      queue.startedAt > now ||
      now - queue.startedAt > 30 * 60_000 ||
      !Array.isArray(queue.connectors) ||
      queue.connectors.length > 1000 ||
      !queue.connectors.every(
        (entry) =>
          typeof entry.name === "string" && typeof entry.url === "string",
      ) ||
      (queue.waiting !== undefined && typeof queue.waiting !== "string")
    )
      return;
    return queue;
  } catch {
    return;
  }
}

export function nextReconnect(
  queue: ReconnectQueue,
  servers: McpServerState[],
) {
  const connectors = queue.connectors.filter((entry) =>
    servers.some(
      (server) =>
        server.name === entry.name &&
        server.url === entry.url &&
        !(server.state === "ready" && server.authStatus !== "notLoggedIn"),
    ),
  );
  if (queue.waiting && connectors.some((entry) => entry.name === queue.waiting))
    return { ...queue, connectors };
  return { ...queue, connectors, waiting: undefined };
}
