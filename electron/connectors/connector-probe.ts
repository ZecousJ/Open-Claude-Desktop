import { z } from "zod";
import {
  connectorUrlError,
  connectorUsesSse,
} from "../../shared/custom-connector";
import type {
  ConnectorProbe,
  CustomConnector,
} from "../../shared/settings-desktop-api";
import { ConnectorAddressError } from "../../runner/src/connectors";
import { discoverConnectorOAuth } from "../../runner/src/connector-oauth";
import { openSseConnector } from "./connector-sse";

type Transport = NonNullable<CustomConnector["transport"]>;
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "Claudex", version: "1.0" },
  },
};
const initialized = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(initialize.id),
  result: z.object({
    protocolVersion: z.string().min(1),
    capabilities: z.record(z.string(), z.unknown()),
    serverInfo: z.object({ name: z.string(), version: z.string() }),
  }),
});

export class ConnectorProbeError extends Error {
  constructor(
    readonly failure:
      | "not_found"
      | "http_connect_failed"
      | "http_protocol_error"
      | "http_read_timeout",
    readonly httpStatus?: number,
  ) {
    super("The request failed.");
  }
}

const isEgressRefusal = (error: unknown) =>
  (error instanceof ConnectorAddressError && error.reason === "denied") ||
  (error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ECLAUDEXEGRESS");

function discoveryFailure(error: unknown, timeout: AbortSignal): never {
  if (
    error instanceof ConnectorProbeError ||
    error instanceof ConnectorAddressError
  )
    throw error;
  throw new ConnectorProbeError(
    timeout.aborted ? "http_read_timeout" : "http_protocol_error",
  );
}

function validInitialization(text: string) {
  try {
    return initialized.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

async function readInitialization(response: Response) {
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (
    contentType !== "application/json" &&
    contentType !== "text/event-stream"
  ) {
    await response.body?.cancel();
    return false;
  }
  if (!response.body) return false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done)
        return (
          contentType === "application/json" &&
          validInitialization(buffer + decoder.decode())
        );
      bytes += chunk.value.byteLength;
      if (bytes > 256 * 1024) return false;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (contentType === "text/event-stream") {
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data && validInitialization(data)) return true;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function probeConnector(
  url: string,
  request: typeof fetch,
  transport: Transport = connectorUsesSse(url) ? "sse" : "streamable-http",
): Promise<ConnectorProbe> {
  const error = connectorUrlError(url);
  if (error) throw new ConnectorAddressError("denied", error);
  const timeout = AbortSignal.timeout(30_000);
  const send: typeof fetch = async (address, init) => {
    const signal = init?.signal
      ? AbortSignal.any([timeout, init.signal])
      : timeout;
    let response: Response;
    try {
      response = await request(address, { ...init, signal });
    } catch (error) {
      if (isEgressRefusal(error))
        throw new ConnectorAddressError(
          "denied",
          "This connector address is unavailable.",
        );
      throw new ConnectorProbeError(
        timeout.aborted ? "http_read_timeout" : "http_connect_failed",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ConnectorProbeError(
        response.status === 404 ? "not_found" : "http_protocol_error",
        response.status,
      );
    }
    return response;
  };
  try {
    if (transport === "sse") {
      let accept: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        accept = resolve;
      });
      const stream = await openSseConnector(url, send, {}, (message) => {
        if (initialized.safeParse(message).success) accept();
      }).catch((error) => discoveryFailure(error, timeout));
      try {
        await stream.send(initialize);
        await Promise.race([ready, stream.completed]);
      } catch (error) {
        discoveryFailure(error, timeout);
      } finally {
        stream.close();
      }
    } else {
      const response = await send(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(initialize),
        redirect: "error",
      });
      const valid = await readInitialization(response).catch(() => {
        throw new ConnectorProbeError(
          timeout.aborted ? "http_read_timeout" : "http_protocol_error",
          response.status,
        );
      });
      if (!valid) throw new ConnectorProbeError("not_found", response.status);
    }
  } catch (error) {
    if (
      error instanceof ConnectorProbeError &&
      (error.httpStatus === 401 || error.httpStatus === 403)
    ) {
      const metadataSignal = AbortSignal.timeout(5_000);
      const discovery = await discoverConnectorOAuth(url, (input, init) =>
        request(input, {
          ...init,
          signal: AbortSignal.any([
            metadataSignal,
            init?.signal ?? metadataSignal,
          ]),
        }),
      ).catch(() => undefined);
      const server = discovery?.server;
      const supportsOAuth =
        typeof server?.authorization_endpoint === "string" &&
        typeof server?.token_endpoint === "string" &&
        Array.isArray(server?.code_challenge_methods_supported) &&
        server.code_challenge_methods_supported.includes("S256");
      return {
        authRequired: true,
        transport,
        ...(supportsOAuth && {
          suggestedRegistration:
            server.client_id_metadata_document_supported === true
              ? "cimd"
              : typeof server.registration_endpoint === "string"
                ? "dcr"
                : "static_per_installation",
        }),
      };
    }
    throw error;
  }
  return { authRequired: false, transport };
}
