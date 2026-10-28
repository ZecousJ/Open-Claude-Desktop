import path from "node:path";
import { type ClientPolicy } from "../../shared/client-policy";
import { allowedMcpServers } from "../../shared/client-policy-rules";
import type { EnvironmentRef } from "../../shared/types";
import { withoutAlwaysAllowed } from "../../shared/mcp-tool-approval";
import { remoteMcpServers } from "./mcp-servers";

export interface McpConfigInput {
  /** Settings → Connectors' servers. */
  servers: Record<string, unknown>;
  policy: ClientPolicy;
  /** Names the app provides per thread (a user server so named is left out). */
  reserved: ReadonlySet<string>;
  environmentKind: EnvironmentRef["kind"];
  /** The agent runs on another computer (SSH). */
  remote: boolean;
  /** The native owner's protected package launch (undefined: none). */
  runtimeConfig?: (
    name: string,
    raw: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  launchConfig?: (
    name: string,
    entry: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  /** A connector's extra request headers (the web's bearer tokens). */
  headers?: (name: string) => Record<string, string> | undefined;
  /** The provider service script, beside which connector-sse-mcp.mjs ships. */
  serviceScript: string;
  nodeExecutable?: string;
  /** Settings → Extensions: run extensions with the built-in Node. */
  builtInNode: boolean;
}

/**
 * The MCP servers Codex is started with, as JSON: only connectors the
 * administrator allows; a user server named like one the app provides is
 * left out (the app's runs per thread); extensions go through their
 * protected launch; SSE connectors run through connector-sse-mcp; servers
 * with secrets stay on this computer (R9).
 */
export function mcpServersConfig(input: McpConfigInput): string {
  const reserved = input.reserved;
  const allowed = allowedMcpServers(input.servers, input.policy);
  const servers = Object.fromEntries(
    Object.entries(
      // "Always allow" choices stay in the settings but do not apply while
      // the administrator requires approving each request.
      input.policy.approvalsAlwaysAllow === false ||
        input.environmentKind === "ssh"
        ? withoutAlwaysAllowed(allowed)
        : allowed,
    ).filter(([name]) => !reserved.has(name)),
  );
  // The web keeps a connector's bearer token on the runner, apart from the
  // settings: it joins the server's requests as a header, here only.
  const resolved = Object.fromEntries(
    Object.entries(servers).flatMap(([name, raw]) => {
      if (!raw || typeof raw !== "object") return [[name, raw]];
      const entry = raw as Record<string, unknown>;
      if (
        entry.claudex_extension &&
        (input.remote || input.environmentKind !== "local")
      )
        return [];
      if (
        entry.claudex_extension_settings !== undefined &&
        (!input.runtimeConfig || !input.launchConfig)
      )
        return [];
      const value = input.runtimeConfig
        ? input.runtimeConfig(name, entry)
        : entry;
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const headers = input.headers;
  const withTokens = headers
    ? Object.fromEntries(
        Object.entries(resolved).map(([name, server]) => {
          const extra = headers(name);
          return [
            name,
            extra && server && typeof server === "object"
              ? {
                  ...server,
                  http_headers: {
                    ...((server as { http_headers?: object }).http_headers ??
                      {}),
                    ...extra,
                  },
                }
              : server,
          ];
        }),
      )
    : resolved;
  const transported = Object.fromEntries(
    Object.entries(withTokens).map(([name, raw]) => {
      const server = raw as Record<string, unknown>;
      if (server?.claudex_transport !== "sse" || typeof server.url !== "string")
        return [name, raw];
      const {
        url,
        http_headers,
        bearer_token_env_var,
        env_http_headers,
        claudex_transport,
        ...rest
      } = server;
      const headers = { ...((http_headers as Record<string, string>) ?? {}) };
      if (
        typeof bearer_token_env_var === "string" &&
        process.env[bearer_token_env_var]
      )
        headers.Authorization = `Bearer ${process.env[bearer_token_env_var]}`;
      for (const [header, variable] of Object.entries(
        (env_http_headers as Record<string, string>) ?? {},
      ))
        if (process.env[variable]) headers[header] = process.env[variable]!;
      return [
        name,
        {
          ...rest,
          command: process.execPath,
          args: [
            path.join(
              path.dirname(input.serviceScript),
              "connector-sse-mcp.mjs",
            ),
          ],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            CLAUDEX_MCP_URL: url,
            CLAUDEX_MCP_HEADERS: JSON.stringify(headers),
          },
        },
      ];
    }),
  );
  // R9: servers with secrets in their settings stay on this computer.
  const runtimeServers = Object.fromEntries(
    Object.entries(transported).flatMap(([name, value]) => {
      if (!value || typeof value !== "object") return [[name, value]];
      const { claudex_extension, ...server } = value as Record<string, unknown>;
      if (claudex_extension && server.command === "node" && input.builtInNode) {
        server.command = input.nodeExecutable ?? process.execPath;
        server.env = {
          ...((server.env as Record<string, string>) ?? {}),
          ELECTRON_RUN_AS_NODE: "1",
        };
      }
      const launched = input.launchConfig
        ? input.launchConfig(name, server)
        : server;
      return launched === undefined ? [] : [[name, launched]];
    }),
  );
  return JSON.stringify(
    input.remote ? remoteMcpServers(runtimeServers) : runtimeServers,
  );
}
