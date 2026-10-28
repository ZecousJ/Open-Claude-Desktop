import {
  connectorUrlError,
  connectorUsesSse,
} from "../../shared/custom-connector";

export async function probeConnector(
  url: string,
  request: typeof fetch,
  transport?: "sse" | "streamable-http",
) {
  const error = connectorUrlError(url);
  if (error) throw Error(error);
  const response = await request(url, {
    method:
      transport === "sse" || (!transport && connectorUsesSse(url))
        ? "GET"
        : "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body:
      transport === "sse" || (!transport && connectorUsesSse(url))
        ? undefined
        : JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "Claudex", version: "1.0" },
            },
          }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 401 && response.status !== 403)
    throw Error("The request failed.");
  return { authRequired: response.status === 401 || response.status === 403 };
}
