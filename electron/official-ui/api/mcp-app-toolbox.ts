import { randomUUID } from "node:crypto";
import type http from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ClientPolicy } from "../../../shared/client-policy";
import { connectorAllowed } from "../../../shared/client-policy-rules";
import { toolApprovalMode } from "../../../shared/mcp-tool-approval";
import {
  isOfficialMcpSessionId,
  officialMcpAppToolboxHeaders,
  officialMcpAppToolboxTarget,
  officialUiReadMaxBytes,
  officialUiRequestMaxBytes,
  type OfficialMcpAppToolboxMethod,
  type OfficialUiReadResponse,
} from "../../../shared/official-ui-web";
import type { Settings } from "../../../shared/types";
import { widgetUri } from "../../../shared/widget";
import {
  ArtifactConnectorRpcError,
  withArtifactConnector,
} from "../../artifacts/artifact-tools";
import { connectorUuid } from "./connector-auth";
import { organizationUuid, type AdapterContext } from "./context";

export interface McpAppToolboxHost {
  activation: object;
  settings(): Pick<Settings, "mcpServers" | "disableNonessentialServices">;
  policy(): ClientPolicy;
  current(): boolean;
  fetch: typeof fetch;
  headers(name: string, url: string): Record<string, string> | undefined;
  codeScope?(
    scope: OfficialMcpCodeScope,
    target: { serverName: string; toolName: string },
  ): Promise<boolean>;
  onRetire?(close: () => void): () => void;
}

const protocolVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const headersSchema = z.strictObject({
  organizationId: z.string().uuid(),
  clientSessionId: z.string().regex(/^[\x21-\x7e]{1,256}$/),
  sessionId: z.custom<string>(isOfficialMcpSessionId).optional(),
  protocolVersion: protocolVersionSchema.optional(),
});
const fields = z.record(z.string(), z.unknown());
const remoteConfig = z.looseObject({
  url: z.string(),
  command: z.undefined().optional(),
});
const envelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: fields.optional(),
});
const cursorParams = z.object({ cursor: z.string().optional() });
const toolsPage = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  nextCursor: z.string().nullish(),
});
const resourcesPage = z.looseObject({
  resources: z.array(z.looseObject({ uri: z.string() })),
  nextCursor: z.string().nullish(),
});
const initResult = z.looseObject({
  protocolVersion: protocolVersionSchema,
  serverInfo: z.looseObject({ name: z.string(), version: z.string() }),
  capabilities: z.object({
    tools: fields.optional(),
    resources: fields.optional(),
  }),
});
const resourceContent = z
  .looseObject({
    uri: z.string(),
    mimeType: z.enum(["text/html+mcp", "text/html;profile=mcp-app"]),
    text: z.string().optional(),
    blob: z.string().optional(),
  })
  .refine(
    (content) => content.text !== undefined || content.blob !== undefined,
  );
const resourceResult = z.looseObject({ contents: z.tuple([resourceContent]) });
const codeScopeSchema = z.strictObject({
  sessionId: z.string().min(1),
  toolUseId: z.string().min(1),
});
export type OfficialMcpCodeScope = z.infer<typeof codeScopeSchema>;
const toolCall = z.looseObject({
  name: z.string(),
  arguments: fields.optional(),
  _meta: z
    .looseObject({ claudex_code_scope: codeScopeSchema.optional() })
    .optional(),
});
const visibilitySchema = z.object({
  ui: z.object({ visibility: z.array(z.string()).optional() }).optional(),
});

type Rpc = (method: string, params: unknown) => Promise<unknown>;
type Session = {
  clientId: string;
  connectorId: string;
  current: () => boolean;
  protocol: string;
  rpc: Rpc;
  initialized: boolean;
  timer?: NodeJS.Timeout;
  stop: () => void;
};

function httpResult(
  status: number,
  payload?: unknown,
  mcpSessionId?: string,
): OfficialUiReadResponse {
  return {
    status,
    contentType: "application/json",
    body:
      payload === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(payload)),
    ...(mcpSessionId ? { mcpSessionId } : {}),
  };
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function enabled(config: Record<string, unknown>, tool: string) {
  return (
    !(
      Array.isArray(config.disabled_tools) &&
      config.disabled_tools.includes(tool)
    ) &&
    !(
      Array.isArray(config.enabled_tools) &&
      !config.enabled_tools.includes(tool)
    )
  );
}

type Tool = z.infer<typeof toolsPage>["tools"][number];

function appVisible(tool: Tool) {
  const metadata = visibilitySchema.safeParse(tool._meta ?? {});
  return (
    metadata.success && (metadata.data.ui?.visibility?.includes("app") ?? true)
  );
}

async function listedTools(
  rpc: Rpc,
  config: Record<string, unknown>,
  found?: (tool: Tool) => boolean,
) {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const result = toolsPage.parse(
      await rpc("tools/list", cursor ? { cursor } : {}),
    );
    const available = result.tools.filter((tool) => enabled(config, tool.name));
    tools.push(...available);
    if (!result.nextCursor || (found && available.some(found))) return tools;
    cursor = result.nextCursor;
  }
  throw new RpcError(
    -32000,
    "The connector tool inventory exceeds the page limit.",
  );
}

async function appRequest(
  rpc: Rpc,
  method: string,
  params: Record<string, unknown>,
  config: Record<string, unknown>,
  policy: () => ClientPolicy,
  codeScope: (
    scope: OfficialMcpCodeScope,
    toolName: string,
  ) => Promise<boolean> | undefined,
) {
  switch (method) {
    case "ping":
      return {};
    case "tools/list": {
      const result = toolsPage.parse(
        await rpc(method, cursorParams.parse(params)),
      );
      return {
        ...result,
        tools: result.tools.filter((tool) => enabled(config, tool.name)),
      };
    }
    case "resources/list": {
      const uris = new Set((await listedTools(rpc, config)).map(widgetUri));
      const result = resourcesPage.parse(
        await rpc(method, cursorParams.parse(params)),
      );
      return {
        ...result,
        resources: result.resources.filter((resource) =>
          uris.has(resource.uri),
        ),
      };
    }
    case "resources/read": {
      const { uri } = z
        .object({ uri: z.string().startsWith("ui://") })
        .parse(params);
      const announces = (tool: Tool) => widgetUri(tool) === uri;
      if (!(await listedTools(rpc, config, announces)).some(announces))
        throw new RpcError(
          -32002,
          "The connector did not announce this App resource.",
        );
      const result = resourceResult.parse(await rpc(method, params));
      if (result.contents[0].uri !== uri)
        throw new RpcError(
          -32002,
          "The connector returned a different App resource.",
        );
      return result;
    }
    case "tools/call": {
      const input = toolCall.parse(params);
      const scope = input._meta?.claudex_code_scope;
      const assertCodeScope = async () => {
        if (scope && !(await codeScope(scope, input.name)))
          throw new RpcError(
            -32000,
            "This tool is unavailable in the originating Code session.",
          );
      };
      const allowed = () =>
        enabled(config, input.name) &&
        policy().approvalsAlwaysAllow &&
        toolApprovalMode(config, input.name) === "approve";
      if (!allowed())
        throw new RpcError(
          -32000,
          "This connector tool needs Always allow permission.",
        );
      await assertCodeScope();
      const callable = (tool: Tool) =>
        tool.name === input.name && appVisible(tool);
      if (!(await listedTools(rpc, config, callable)).some(callable))
        throw new RpcError(-32602, "This tool is unavailable to the MCP App.");
      await assertCodeScope();
      if (!allowed())
        throw new RpcError(
          -32000,
          "This connector tool needs Always allow permission.",
        );
      if (input._meta?.claudex_code_scope) {
        delete input._meta.claudex_code_scope;
        if (!Object.keys(input._meta).length) delete input._meta;
      }
      return fields.parse(await rpc(method, input));
    }
    default:
      throw new RpcError(-32601, "Method not supported by the MCP App host.");
  }
}

export class McpAppToolbox {
  private readonly sessions = new WeakMap<object, Map<string, Session>>();

  async handle({
    accountId,
    connectorId,
    method,
    headers,
    body,
    contentType,
    host,
    signal,
  }: {
    accountId: string;
    connectorId: string;
    method: OfficialMcpAppToolboxMethod;
    headers: unknown;
    body?: Uint8Array;
    contentType?: string;
    host: McpAppToolboxHost;
    signal?: AbortSignal;
  }): Promise<OfficialUiReadResponse> {
    const parsed = headersSchema.safeParse(headers);
    if (!parsed.success)
      return httpResult(400, { error: "Invalid MCP App transport headers." });
    const { organizationId, clientSessionId, sessionId, protocolVersion } =
      parsed.data;
    if (!host.current() || organizationId !== organizationUuid(accountId))
      return httpResult(404, { error: "Organization not found." });
    const name = Object.keys(host.settings().mcpServers).find(
      (name) => connectorUuid(name) === connectorId,
    );
    if (!name) return httpResult(404, { error: "Connector not found." });
    const configuration = remoteConfig.safeParse(
      host.settings().mcpServers[name],
    );
    if (
      !configuration.success ||
      configuration.data.enabled === false ||
      host.settings().disableNonessentialServices ||
      !connectorAllowed(host.policy(), name, configuration.data)
    )
      return httpResult(404, { error: "Connector not available." });
    if (method === "GET") return httpResult(405);
    let sessions = this.sessions.get(host.activation);
    if (!sessions) this.sessions.set(host.activation, (sessions = new Map()));
    const session =
      sessionId === undefined ? undefined : sessions.get(sessionId);
    if (
      sessionId &&
      (!session ||
        session.clientId !== clientSessionId ||
        session.connectorId !== connectorId)
    )
      return httpResult(404, { error: "The MCP session ended." });
    if (session && !session.current()) {
      session.stop();
      return httpResult(404, { error: "The MCP session ended." });
    }
    if (
      session &&
      protocolVersion !== undefined &&
      protocolVersion !== session.protocol
    )
      return httpResult(400, {
        error: "The MCP session uses a different protocol version.",
      });
    if (method === "DELETE") {
      if (!session)
        return httpResult(400, { error: "An MCP session is required." });
      session.stop();
      return httpResult(204);
    }
    if (!body || !/^application\/json(?:\s*;.*)?$/i.test(contentType ?? ""))
      return httpResult(415, { error: "MCP requests require JSON." });
    if (body.byteLength > officialUiRequestMaxBytes)
      return httpResult(413, { error: "The MCP request is too large." });
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      );
    } catch {
      return httpResult(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON." },
      });
    }
    const message = envelope.safeParse(value);
    if (!message.success)
      return httpResult(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid MCP request." },
      });
    const { method: rpcMethod, id, params = {} } = message.data;
    if (rpcMethod === "server/discover" && !session && id !== undefined)
      return httpResult(200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found." },
      });
    if (rpcMethod === "initialize") {
      if (
        id === undefined ||
        sessionId ||
        typeof params.protocolVersion !== "string"
      )
        return httpResult(400, { error: "Invalid MCP initialize request." });
      const config = structuredClone(configuration.data);
      const savedHeaders = host.headers(name, config.url);
      const current = () =>
        host.current() &&
        !host.settings().disableNonessentialServices &&
        isDeepStrictEqual(host.settings().mcpServers[name], config) &&
        connectorAllowed(host.policy(), name, config) &&
        isDeepStrictEqual(host.headers(name, config.url), savedHeaders);
      const localId = randomUUID();
      const lifetime = new AbortController();
      const stop = () => {
        const entry = sessions.get(localId);
        if (entry) clearTimeout(entry.timer);
        sessions.delete(localId);
        lifetime.abort();
      };
      const stopRetirement = host.onRetire?.(stop);
      try {
        return await new Promise<OfficialUiReadResponse>((resolve, reject) => {
          const alert = (error: unknown) => {
            stop();
            reject(error);
          };
          const abort = () => alert(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted || lifetime.signal.aborted) {
            abort();
            return;
          }
          const fetchConnector: typeof fetch = (input, options) => {
            if (!current())
              throw new Error("The connector configuration changed.");
            if (options?.method === "DELETE") return host.fetch(input, options);
            const signal = options?.signal
              ? AbortSignal.any([options.signal, lifetime.signal])
              : lifetime.signal;
            return host.fetch(input, { ...options, signal });
          };
          void withArtifactConnector(
            config,
            async (request, _capabilities, raw) => {
              if (lifetime.signal.aborted || !current())
                throw new Error("The MCP session ended.");
              const result = initResult.parse(raw);
              const connection: Session = {
                clientId: clientSessionId,
                connectorId,
                current,
                protocol: result.protocolVersion,
                rpc: (method, params) => {
                  if (lifetime.signal.aborted || !current())
                    throw new Error("The MCP session ended.");
                  return request(method, params);
                },
                initialized: false,
                stop,
              };
              const closed = new Promise<void>((done) =>
                lifetime.signal.addEventListener("abort", () => done(), {
                  once: true,
                }),
              );
              sessions.set(localId, connection);
              this.touch(connection);
              signal?.removeEventListener("abort", abort);
              resolve(httpResult(200, { jsonrpc: "2.0", id, result }, localId));
              await closed;
            },
            {
              fetch: fetchConnector,
              headers: savedHeaders,
              remoteOnly: true,
              clientCapabilities: fields.parse(params.capabilities ?? {}),
              resourceResponseLimit: officialUiReadMaxBytes,
            },
          )
            .catch(alert)
            .finally(() => {
              signal?.removeEventListener("abort", abort);
              stopRetirement?.();
            });
        });
      } catch {
        stopRetirement?.();
        return httpResult(502, {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "The MCP connector is unavailable." },
        });
      }
    }
    if (!session)
      return httpResult(400, { error: "An MCP session is required." });
    this.touch(session);
    if (id === undefined) {
      if (rpcMethod === "notifications/initialized") session.initialized = true;
      return httpResult(202);
    }
    if (!session.initialized)
      return httpResult(400, { error: "The MCP session is not initialized." });
    try {
      signal?.throwIfAborted();
      const result = await appRequest(
        (method, params) => {
          signal?.throwIfAborted();
          return session.rpc(method, params);
        },
        rpcMethod,
        params,
        configuration.data,
        () => host.policy(),
        (scope, toolName) =>
          host.codeScope?.(scope, { serverName: name, toolName }),
      );
      if (!session.current() || !sessions.has(sessionId ?? ""))
        return httpResult(404, { error: "The MCP session ended." });
      signal?.throwIfAborted();
      const answer = httpResult(200, { jsonrpc: "2.0", id, result });
      if (answer.body.byteLength <= officialUiReadMaxBytes) return answer;
      throw new RpcError(-32000, "The MCP response is too large.");
    } catch (error) {
      if (!session.current() || !sessions.has(sessionId ?? ""))
        return httpResult(404, { error: "The MCP session ended." });
      if (error instanceof ArtifactConnectorRpcError) {
        const answer = httpResult(200, {
          jsonrpc: "2.0",
          id,
          error: error.rpc,
        });
        if (answer.body.byteLength <= officialUiReadMaxBytes) return answer;
      }
      const failure =
        error instanceof RpcError
          ? error
          : error instanceof z.ZodError
            ? new RpcError(-32602, "Invalid MCP App request or response.")
            : new RpcError(-32000, "The MCP connector is unavailable.");
      return httpResult(200, {
        jsonrpc: "2.0",
        id,
        error: { code: failure.code, message: failure.message },
      });
    }
  }

  private touch(session: Session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(session.stop, 5 * 60_000).unref();
  }
}

export function mcpAppToolboxRoute(
  toolbox: McpAppToolbox,
  ctx: AdapterContext,
) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const target = officialMcpAppToolboxTarget(req.method ?? "", req.url ?? "");
    if (!target) return false;
    const { method, connectorId } = target;
    const accountId = ctx.account()?.id;
    const host = ctx.mcpAppToolbox?.();
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    let answer: OfficialUiReadResponse;
    if (!accountId || !host)
      answer = httpResult(501, { error: "MCP Apps are unavailable." });
    else {
      const chunks: Buffer[] = [];
      let size = 0;
      if (method === "POST") {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > officialUiRequestMaxBytes) break;
          chunks.push(chunk);
        }
      }
      answer =
        size > officialUiRequestMaxBytes
          ? httpResult(413, { error: "The MCP request is too large." })
          : await toolbox.handle({
              accountId,
              connectorId,
              method,
              headers: officialMcpAppToolboxHeaders(header),
              body: method === "POST" ? Buffer.concat(chunks) : undefined,
              contentType: header("content-type"),
              host,
              signal: abort.signal,
            });
    }
    if (!res.destroyed) {
      res.writeHead(answer.status, {
        "Content-Type": answer.contentType,
        "Cache-Control": "no-store",
        ...(answer.status === 405 ? { Allow: "POST, DELETE" } : {}),
        ...(answer.mcpSessionId
          ? { "Mcp-Session-Id": answer.mcpSessionId }
          : {}),
      });
      res.end(answer.body);
    }
    return true;
  };
}
