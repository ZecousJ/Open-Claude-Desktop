import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type {
  ArtifactToolCall,
  ArtifactToolGroup,
  ArtifactToolRequest,
} from "../../shared/artifact-tools";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { McpStdioClient } from "../computer-use/driver-host";
import { openSseConnector } from "../connectors/connector-sse";
import { embeddedWidget, widgetDomains, widgetUri } from "../../shared/widget";
import {
  resourceLinks,
  resourceDownloadName,
  resourceChunkBytes,
  maxResourceBytes,
  validResourceBase64,
} from "../../shared/message-resources";

const fail = () => new Error("The request failed.");
const toolName = z.string().min(1).max(200);
const group = z
  .object({ server: toolName, tools: z.array(toolName).min(1).max(100) })
  .strict();
const callSchema = z
  .object({
    server: toolName,
    tool: toolName,
    input: z.record(z.string(), z.unknown()),
    groups: z.array(group).min(1).max(20).optional(),
  })
  .strict();
const identitySchema = z.string().min(1).max(3_000_000);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function readMcpResponse(
  response: Response,
  id: number,
  limit = 2_000_000,
): Promise<any> {
  if (!response.ok || !response.body) throw fail();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let received = 0;
  try {
    for (;;) {
      const part = await reader.read();
      received += part.value?.byteLength ?? 0;
      if (received > limit) throw fail();
      body += decoder.decode(part.value, { stream: !part.done });
      if (body.length > limit) throw fail();
      let messages: any[] = [];
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const events = body.split(/\r?\n\r?\n/);
        body = events.pop() ?? "";
        messages = events.flatMap((event) => {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          return data ? [JSON.parse(data)] : [];
        });
      } else if (part.done) messages = [JSON.parse(body)];
      for (const message of messages)
        if (message.id === id) {
          if (message.error) throw fail();
          return message.result;
        }
      if (part.done) throw fail();
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function withArtifactConnector<Result>(
  config: Record<string, unknown>,
  run: (
    request: (method: string, params: unknown) => Promise<any>,
  ) => Promise<Result>,
  options: { fetch?: typeof fetch; token?: string; remoteOnly?: boolean } = {},
): Promise<Result> {
  let child: ReturnType<typeof spawn> | undefined;
  let session: string | null = null;
  let sequence = 0;
  let protocol: string | undefined;
  let request: (method: string, params: unknown) => Promise<any>;
  let notify: (method: string) => Promise<void>;
  let close = async () => {};
  if (config.claudex_transport === "sse" && typeof config.url === "string") {
    const headers = {
      ...((config.http_headers ?? {}) as Record<string, string>),
    };
    const token =
      options.token ??
      (!options.remoteOnly && typeof config.bearer_token_env_var === "string"
        ? process.env[config.bearer_token_env_var]
        : undefined);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (!options.remoteOnly)
      for (const [name, variable] of Object.entries(
        (config.env_http_headers ?? {}) as Record<string, string>,
      ))
        if (process.env[variable]) headers[name] = process.env[variable]!;
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    const transport = await openSseConnector(
      config.url,
      options.fetch ?? fetch,
      headers,
      (raw) => {
        const message = raw as {
          id?: number;
          result?: unknown;
          error?: unknown;
        };
        const waiting =
          message && typeof message.id === "number"
            ? pending.get(message.id)
            : undefined;
        if (!waiting) return;
        pending.delete(message.id!);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(fail());
        else waiting.resolve(message.result);
      },
    );
    const clear = () => {
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(fail());
      }
      pending.clear();
    };
    void transport.completed.then(clear, clear);
    request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(fail());
        }, 60_000);
        pending.set(id, { resolve, reject, timer });
        void transport
          .send({ jsonrpc: "2.0", id, method, params })
          .catch(() => {
            clearTimeout(timer);
            pending.delete(id);
            reject(fail());
          });
      });
    notify = (method) => transport.send({ jsonrpc: "2.0", method });
    close = async () => {
      transport.close();
      clear();
      await transport.completed.catch(() => {});
    };
  } else if (typeof config.url === "string") {
    const url = new URL(config.url);
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw fail();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    for (const [key, value] of Object.entries(
      (config.http_headers ?? {}) as Record<string, unknown>,
    ))
      if (typeof value === "string") headers[key] = value;
    if (!options.remoteOnly)
      for (const [key, variable] of Object.entries(
        (config.env_http_headers ?? {}) as Record<string, unknown>,
      ))
        if (typeof variable === "string" && process.env[variable])
          headers[key] = process.env[variable]!;
    const token =
      options.token ??
      (!options.remoteOnly && typeof config.bearer_token_env_var === "string"
        ? process.env[config.bearer_token_env_var]
        : undefined);
    if (token) headers.Authorization = `Bearer ${token}`;
    const send = (method: string, params?: unknown, id?: number) =>
      (options.fetch ?? fetch)(url.href, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(
          method === "resources/read" ? 30_000 : 60_000,
        ),
        headers: {
          ...headers,
          ...(session ? { "Mcp-Session-Id": session } : {}),
          ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(id === undefined ? {} : { id }),
          method,
          ...(params === undefined ? {} : { params }),
        }),
      });
    request = async (method, params) => {
      const id = ++sequence;
      const response = await send(method, params, id);
      session ??= response.headers.get("mcp-session-id");
      const result = await readMcpResponse(
        response,
        id,
        method === "resources/read" ? 150_000_000 : undefined,
      );
      if (method === "initialize")
        protocol =
          typeof result?.protocolVersion === "string"
            ? result.protocolVersion
            : "2025-03-26";
      return result;
    };
    notify = async (method) => {
      const response = await send(method);
      if (!response.ok) throw fail();
      await response.body?.cancel();
    };
    close = async () => {
      if (!session) return;
      const response = await (options.fetch ?? fetch)(url.href, {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          ...headers,
          "Mcp-Session-Id": session,
          ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
        },
      }).catch(() => undefined);
      await response?.body?.cancel();
    };
  } else {
    if (options.remoteOnly || typeof config.command !== "string") throw fail();
    const args = Array.isArray(config.args)
      ? z.array(z.string()).parse(config.args)
      : [];
    const env = {
      ...process.env,
      ...z.record(z.string(), z.string()).parse(config.env ?? {}),
    };
    const process_ = spawn(config.command, args, {
      env,
      stdio: "pipe",
      windowsHide: true,
    });
    child = process_;
    const client = new McpStdioClient(process_);
    request = (method, params) =>
      client.request(
        method,
        params,
        method === "resources/read" ? 30_000 : 60_000,
      );
    notify = async (method) => client.notify(method);
  }
  try {
    await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "Claudex", version: "1" },
    });
    await notify("notifications/initialized");
    return await run(request);
  } finally {
    child?.kill();
    await close();
  }
}

export function registerArtifactToolHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  let owner: AppContext["store"] | undefined;
  let grants: Record<string, ArtifactToolGroup[]> = {};
  const downloads = new Map<
    string,
    {
      bytes: Buffer;
      server: string;
      tool: string;
      fingerprint: string;
      at: number;
    }
  >();
  const pending = new Map<
    string,
    {
      identity: string;
      request: ArtifactToolRequest;
      fingerprints: string[];
      at: number;
    }
  >();
  function account() {
    const store = ctx.store;
    if (owner !== store) {
      owner = store;
      grants = {};
      pending.clear();
      downloads.clear();
      try {
        grants = z
          .record(z.string(), z.array(group))
          .parse(
            JSON.parse(
              fs.readFileSync(
                path.join(store.root, "artifact-tool-permissions.json"),
                "utf8",
              ),
            ),
          );
      } catch {}
    }
    return store;
  }
  ctx.onAccountDeactivating?.(() => {
    owner = undefined;
    grants = {};
    pending.clear();
    downloads.clear();
  });
  const key = (identity: string) => hash(identitySchema.parse(identity));
  function config(server: string, tool?: string): Record<string, unknown> {
    account();
    const raw = ctx.store.settings.mcpServers[server];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
    const value = raw as Record<string, unknown>;
    if (
      value.enabled === false ||
      !connectorAllowed(ctx.policy(), server, value)
    )
      throw fail();
    if (
      tool &&
      ((Array.isArray(value.disabled_tools) &&
        value.disabled_tools.includes(tool)) ||
        (Array.isArray(value.enabled_tools) &&
          !value.enabled_tools.includes(tool)))
    )
      throw fail();
    return value;
  }
  const fingerprint = (server: string) => hash(JSON.stringify(config(server)));
  const grantKey = (identity: string, server: string) =>
    `${key(identity)}:${server}:${fingerprint(server)}`;
  const save = () => ctx.store.write("artifact-tool-permissions.json", grants);
  const connect = <Result>(
    server: string,
    run: Parameters<typeof withArtifactConnector<Result>>[1],
  ) => {
    const value = config(server);
    return withArtifactConnector(value, run, {
      fetch: ctx.connectors?.fetch,
      token: ctx.connectors?.getToken?.(server),
      remoteOnly: Boolean(ctx.connectors),
    });
  };
  handle(
    "readMcpResource",
    async (rawConversation: unknown, rawItem: unknown, rawUri: unknown) => {
      const store = account();
      const conversation = store.conversation(toolName.parse(rawConversation));
      const item = conversation.turns
        .flatMap((turn) => turn.items)
        .find((entry) => entry.id === toolName.parse(rawItem));
      const uri = z.string().min(1).max(16_384).parse(rawUri);
      const link =
        item && resourceLinks(item).find((entry) => entry.uri === uri);
      if (
        !item ||
        !link ||
        !["mcpToolCall", "dynamicToolCall"].includes(item.type) ||
        typeof item.server !== "string" ||
        typeof item.tool !== "string"
      )
        throw fail();
      if (!store.settings.mcpServers[item.server])
        throw new Error(
          "Couldn’t fetch the file. This connector is no longer available.",
        );
      const resourceFingerprint = hash(
        JSON.stringify(config(item.server, item.tool)),
      );
      const result = await connect(item.server, (request) =>
        request("resources/read", { uri }),
      );
      if (account() !== store) throw fail();
      if (
        resourceFingerprint !==
        hash(JSON.stringify(config(item.server, item.tool)))
      )
        throw fail();
      if (
        !Array.isArray(result?.contents) ||
        !result.contents.length ||
        result.contents.length > 4096
      )
        throw fail();
      const buffers: Buffer[] = [];
      let size = 0;
      let mimeType = link.mimeType;
      for (const part of result.contents) {
        if (typeof part?.text !== "string" && typeof part?.blob !== "string")
          throw fail();
        if (typeof part.text !== "string" && !validResourceBase64(part.blob))
          throw fail();
        const bytes =
          typeof part.text === "string"
            ? Buffer.from(part.text)
            : Buffer.from(part.blob, "base64");
        size +=
          typeof part.text === "string"
            ? part.text.length * 3
            : Math.floor((part.blob.length * 3) / 4);
        if (size > maxResourceBytes) throw fail();
        buffers.push(bytes);
        if (!mimeType && typeof part.mimeType === "string")
          mimeType = part.mimeType;
      }
      const bytes = Buffer.concat(buffers);
      let downloadId: string | undefined;
      if (bytes.length > resourceChunkBytes) {
        for (const [id, entry] of downloads)
          if (Date.now() - entry.at > 300_000) downloads.delete(id);
        while (downloads.size >= 2)
          downloads.delete(downloads.keys().next().value!);
        downloadId = randomUUID();
        downloads.set(downloadId, {
          bytes,
          server: item.server,
          tool: item.tool,
          fingerprint: resourceFingerprint,
          at: Date.now(),
        });
      }
      return {
        name: resourceDownloadName(link, mimeType),
        mimeType: mimeType ?? "application/octet-stream",
        base64: downloadId ? "" : bytes.toString("base64"),
        ...(downloadId ? { downloadId, byteLength: bytes.length } : {}),
      };
    },
  );
  handle("readMcpResourceChunk", (rawId: unknown, rawOffset: unknown) => {
    account();
    const id = z.string().uuid().parse(rawId);
    const offset = z
      .number()
      .int()
      .min(0)
      .max(maxResourceBytes)
      .parse(rawOffset);
    const entry = downloads.get(id);
    if (
      !entry ||
      Date.now() - entry.at > 300_000 ||
      offset % resourceChunkBytes !== 0 ||
      offset >= entry.bytes.length
    )
      throw fail();
    if (
      entry.fingerprint !==
      hash(JSON.stringify(config(entry.server, entry.tool)))
    )
      throw fail();
    const result = entry.bytes
      .subarray(offset, offset + resourceChunkBytes)
      .toString("base64");
    if (offset + resourceChunkBytes >= entry.bytes.length) downloads.delete(id);
    return result;
  });
  handle(
    "widgetResource",
    async (rawConversation: unknown, rawItem: unknown) => {
      const store = account();
      if (store.settings.disableNonessentialServices) throw fail();
      const conversation = store.conversation(toolName.parse(rawConversation));
      const item = conversation.turns
        .flatMap((turn) => turn.items)
        .find((entry) => entry.id === toolName.parse(rawItem));
      if (
        !item ||
        item.type !== "mcpToolCall" ||
        typeof item.server !== "string" ||
        typeof item.tool !== "string"
      )
        throw fail();
      const server = item.server;
      config(server, item.tool);
      const embedded = embeddedWidget(item.result);
      if (embedded) return { ...embedded, server };
      const resource = await connect(server, async (request) => {
        let uri = widgetUri(item) ?? widgetUri(item.result);
        if (!uri) {
          let cursor: string | undefined;
          for (let page = 0; page < 10 && !uri; page++) {
            if (store.settings.disableNonessentialServices) throw fail();
            const result = await request(
              "tools/list",
              cursor ? { cursor } : {},
            );
            uri = widgetUri(
              result.tools?.find(
                (tool: { name: string }) => tool.name === item.tool,
              ),
            );
            cursor = result.nextCursor;
            if (!cursor) break;
          }
        }
        if (!uri || store.settings.disableNonessentialServices) throw fail();
        const result = await request("resources/read", { uri });
        const content = result.contents?.find(
          (entry: { uri?: string; mimeType?: string; text?: unknown }) =>
            entry.uri === uri &&
            entry.mimeType?.split(";")[0] === "text/html" &&
            typeof entry.text === "string",
        );
        if (!content || content.text.length > 2_000_000) throw fail();
        return {
          html: content.text as string,
          uri,
          server,
          ...widgetDomains(content),
        };
      });
      if (ctx.store !== store || store.settings.disableNonessentialServices)
        throw fail();
      return resource;
    },
  );
  handle("artifactTools", async () => {
    const store = account();
    const listed = [];
    for (const server of Object.keys(ctx.store.settings.mcpServers)) {
      try {
        const tools = await connect(server, async (request) => {
          const all: {
            name: string;
            description?: string;
            inputSchema?: unknown;
          }[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const result = await request(
              "tools/list",
              cursor ? { cursor } : {},
            );
            for (const tool of result.tools ?? []) {
              if (typeof tool.name !== "string") continue;
              try {
                config(server, tool.name);
              } catch {
                continue;
              }
              all.push({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              });
            }
            cursor = result.nextCursor;
            if (!cursor) break;
          }
          return all;
        });
        listed.push({ server, tools });
      } catch {}
    }
    if (ctx.store !== store) throw fail();
    return listed;
  });
  handle("requestArtifactTool", (rawIdentity: unknown, rawCall: unknown) => {
    account();
    const identity = identitySchema.parse(rawIdentity);
    const call: ArtifactToolCall = callSchema.parse(rawCall);
    const input = JSON.stringify(call.input);
    if (input.length > 2_000_000) throw fail();
    call.input = JSON.parse(input);
    const groups = call.groups ?? [{ server: call.server, tools: [call.tool] }];
    if (
      !groups.some(
        (entry) =>
          entry.server === call.server && entry.tools.includes(call.tool),
      )
    )
      throw fail();
    for (const entry of groups)
      for (const tool of entry.tools) config(entry.server, tool);
    for (const [id, entry] of pending)
      if (Date.now() - entry.at > 300_000) pending.delete(id);
    if (pending.size >= 16) throw fail();
    const request: ArtifactToolRequest = {
      ...call,
      groups,
      id: randomUUID(),
      permitted: groups.every((entry) =>
        entry.tools.every((tool) =>
          grants[grantKey(identity, entry.server)]?.some((saved) =>
            saved.tools.includes(tool),
          ),
        ),
      ),
    };
    pending.set(request.id, {
      identity,
      request,
      fingerprints: groups.map((entry) => fingerprint(entry.server)),
      at: Date.now(),
    });
    return request;
  });
  handle("respondArtifactTool", async (rawId: unknown, rawAllow: unknown) => {
    const store = account();
    const id = z.string().uuid().parse(rawId);
    const allow = z.boolean().parse(rawAllow);
    const entry = pending.get(id);
    pending.delete(id);
    if (!entry || Date.now() - entry.at > 300_000 || !allow) throw fail();
    const { request, identity } = entry;
    if (
      request.groups.some(
        (group, index) =>
          fingerprint(group.server) !== entry.fingerprints[index],
      )
    )
      throw fail();
    for (const group of request.groups) {
      for (const tool of group.tools) config(group.server, tool);
      const previous =
        grants[grantKey(identity, group.server)]?.flatMap(
          (saved) => saved.tools,
        ) ?? [];
      grants[grantKey(identity, group.server)] = [
        {
          server: group.server,
          tools: [...new Set([...previous, ...group.tools])],
        },
      ];
    }
    save();
    config(request.server, request.tool);
    const result = await connect(request.server, (call) => {
      if (ctx.store !== store) throw fail();
      config(request.server, request.tool);
      return call("tools/call", {
        name: request.tool,
        arguments: request.input,
      });
    });
    if (ctx.store !== store) throw fail();
    return result;
  });
  handle("artifactToolPermissions", (identity: unknown) => {
    account();
    return Object.entries(grants)
      .filter(([stored]) =>
        stored.startsWith(key(identitySchema.parse(identity)) + ":"),
      )
      .flatMap(([, groups]) => groups);
  });
  handle("revokeArtifactTools", (identity: unknown, rawServer?: unknown) => {
    account();
    const server = toolName.optional().parse(rawServer);
    const prefix =
      key(identitySchema.parse(identity)) + ":" + (server ? server + ":" : "");
    grants = Object.fromEntries(
      Object.entries(grants).filter(([stored]) => !stored.startsWith(prefix)),
    );
    for (const [id, entry] of pending)
      if (
        key(entry.identity) === key(identitySchema.parse(identity)) &&
        (!server ||
          entry.request.groups.some((group) => group.server === server))
      )
        pending.delete(id);
    save();
  });
}
