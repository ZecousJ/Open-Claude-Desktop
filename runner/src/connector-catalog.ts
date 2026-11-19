import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { withArtifactConnector } from "../../electron/artifacts/artifact-tools";
import { mcpServerStates } from "../../electron/connectors/mcp-config-file";
import { ConnectorClients } from "../../electron/connectors/connector-clients";
import { connectorAuthRejected } from "../../electron/connectors/connector-auth-rejection";
import type { ConnectorHost } from "../../electron/app/app-context";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { mcpConnectionIdentity } from "../../shared/mcp-connection-identity";
import { widgetToolMetadata } from "../../shared/widget";
import type { McpServers } from "../../shared/settings-desktop-api";
import type { ConnectorCredentials } from "../../shared/custom-connector";
import type { WebAppContext } from "./web-app-context";

const page = z.object({
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(16_000).optional(),
        inputSchema: z.record(z.string(), z.unknown()),
        annotations: z.record(z.string(), z.unknown()).optional(),
        _meta: z
          .unknown()
          .optional()
          .transform((_meta) => widgetToolMetadata({ _meta })),
      }),
    )
    .max(500),
  nextCursor: z.string().min(1).max(1000).nullish(),
});

interface ListedConnector {
  name: string;
  tools: Record<string, unknown>;
  authStatus: "unsupported" | "bearerToken" | "notLoggedIn" | "staticHeaders";
}

export class WebConnectorCatalog {
  private readonly recent = new Map<
    string,
    {
      key: string;
      token: string | undefined;
      client: ConnectorCredentials | undefined;
      expires: number;
      result: Promise<ListedConnector>;
    }
  >();

  private readonly authFailures = new Set<string>();
  private readonly verified = new Map<string, { url: string; token: string }>();

  isAuthenticated(name: string, url: string) {
    const entry = this.verified.get(name);
    const oauthStatus = this.ctx.connectorOAuth?.status(name, url);
    return this.activation === this.ctx.officialSessionIdentity() &&
      this.store === this.ctx.store &&
      oauthStatus !== "reconnect" && oauthStatus !== "disconnected" &&
      entry !== undefined && entry.url === url &&
      this.ctx.connectors?.getToken?.(name) === entry.token;
  }

  markAuthFailure(name: string) {
    this.authFailures.add(name);
  }
  clearAuthFailure(name: string) {
    this.authFailures.delete(name);
  }

  private activation: unknown;
  private store?: WebAppContext["store"];

  constructor(private readonly ctx: WebAppContext) {}

  async read(refreshName?: string): Promise<McpServers> {
    const { ctx } = this;
    const store = ctx.store;
    const identity = ctx.officialSessionIdentity();
    if (this.activation !== identity || this.store !== store) {
      this.recent.clear();
      this.authFailures.clear();
      this.verified.clear();
      this.activation = identity;
      this.store = store;
    }
    if (refreshName !== undefined) {
      this.recent.delete(refreshName);
      this.verified.delete(refreshName);
    }
    const configuration = store.settings.mcpServers;
    const host = ctx.connectors;
    const current = () => {
      if (
        ctx.closed ||
        ctx.store !== store ||
        ctx.officialSessionIdentity() !== identity ||
        store.settings.mcpServers !== configuration ||
        ctx.connectors !== host
      )
        throw Error("The account or connector configuration changed.");
    };
    current();
    const listed: ListedConnector[] = [];
    const states = new Map<string, { status: string; error?: string }>();
    const entries = Object.entries(configuration ?? {});
    const credentials = new ConnectorClients(store.root);
    for (const name of this.recent.keys())
      if (!Object.hasOwn(configuration, name)) this.recent.delete(name);
    for (const name of this.verified.keys())
      if (!Object.hasOwn(configuration, name)) this.verified.delete(name);
    const deadline = AbortSignal.timeout(12_000);
    for (let at = 0; at < entries.length; at += 4) {
      await Promise.all(
        entries.slice(at, at + 4).map(async ([name, raw]) => {
          if (
            !host?.fetch ||
            !raw ||
            typeof raw !== "object" ||
            !("url" in raw) ||
            typeof raw.url !== "string" ||
            !connectorAllowed(ctx.policy(), name, raw)
          ) {
            states.set(name, { status: "failed" });
            return;
          }
          const config = raw as Record<string, unknown>;
          const token = host.getToken?.(name);
          const client = credentials.get(name, raw.url);
          const check = () => {
            current();
            if (
              !connectorAllowed(ctx.policy(), name, config) ||
              host.getToken?.(name) !== token
            )
              throw Error("The connector authorization changed.");
          };
          try {
            check();
            const oauthStatus = client?.staticAuth ? undefined : ctx.connectorOAuth?.status(name, raw.url);
            if (oauthStatus === "reconnect" || oauthStatus === "disconnected") {
              this.verified.delete(name);
              listed.push({ name, tools: {}, authStatus: "notLoggedIn" });
              return;
            }
            const result = await this.list(
              host,
              name,
              config,
              token,
              client,
              deadline,
              check,
            );
            check();
            if (token && result.authStatus === "notLoggedIn")
              ctx.connectorOAuth?.rejectAccess(name, raw.url, token);
            if (token && result.authStatus === "bearerToken")
              this.verified.set(name, { url: raw.url, token });
            else this.verified.delete(name);
            const rejected = client?.oauth?.posture === "defer_auth" &&
              connectorAuthRejected(store, name, raw.url, token !== undefined);
            listed.push(rejected && result.authStatus === "unsupported"
              ? { ...result, authStatus: "notLoggedIn" }
              : result);
          } catch {
            check();
            states.set(name, {
              status: "failed",
              error: "Connector tools are unavailable.",
            });
          }
        }),
      );
    }
    current();
    for (const item of listed)
      if (item.authStatus === "notLoggedIn" && this.authFailures.has(item.name))
        states.set(item.name, {
          status: "failed",
          error: "Connector sign-in failed.",
        });
    return {
      servers: mcpServerStates(configuration, true, states, listed).map((server) => {
        if (!server.url || credentials.get(server.name, server.url)?.staticAuth) return server;
        const oauthStatus = ctx.connectorOAuth?.status(server.name, server.url);
        return oauthStatus ? { ...server, oauthStatus } : server;
      }),
      configPath: "",
    };
  }

  private list(
    host: ConnectorHost,
    name: string,
    config: Record<string, unknown>,
    token: string | undefined,
    client: ConnectorCredentials | undefined,
    deadline: AbortSignal,
    check: () => void,
  ) {
    const key = mcpConnectionIdentity({ [name]: config });
    const existing = this.recent.get(name);
    if (
      existing?.key === key &&
      existing.expires > Date.now() &&
      existing.token === token &&
      isDeepStrictEqual(existing.client, client)
    )
      return existing.result;
    const result = this.discover(
      host,
      name,
      config,
      token,
      client,
      deadline,
      check,
    );
    this.recent.set(name, {
      key,
      token,
      client,
      expires: Date.now() + 15_000,
      result,
    });
    void result.catch(() => {
      if (this.recent.get(name)?.result === result) this.recent.delete(name);
    });
    return result;
  }

  private async discover(
    host: ConnectorHost,
    name: string,
    config: Record<string, unknown>,
    token: string | undefined,
    client: ConnectorCredentials | undefined,
    deadline: AbortSignal,
    check: () => void,
  ): Promise<ListedConnector> {
    if (client?.oauth?.posture === "auth_required" && !token)
      return { name, tools: {}, authStatus: "notLoggedIn" };
    let authRequired = false;
    const request: typeof fetch = async (input, init) => {
      check();
      const signal = init?.signal
        ? AbortSignal.any([deadline, init.signal])
        : deadline;
      const response = await host.fetch!(input, { ...init, signal });
      if (response.status === 401 || response.status === 403)
        authRequired = true;
      return response;
    };
    try {
      const tools = await withArtifactConnector(
        config,
        async (rpc) => {
          const tools = new Map<string, unknown>();
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const result = page.parse(
              await rpc("tools/list", cursor ? { cursor } : {}),
            );
            for (const tool of result.tools) {
              if (tools.has(tool.name) || tools.size >= 500)
                throw Error("Invalid tool inventory.");
              tools.set(tool.name, tool);
            }
            cursor = result.nextCursor ?? undefined;
            if (cursor) {
              if (seen.has(cursor) || seen.size >= 20)
                throw Error("Invalid tool inventory cursor.");
              seen.add(cursor);
            }
          } while (cursor);
          return Object.fromEntries(tools);
        },
        { fetch: request, token, headers: client?.headers, remoteOnly: true },
      );
      return {
        name,
        tools,
        authStatus: client?.staticAuth
          ? "staticHeaders"
          : token
            ? "bearerToken"
            : "unsupported",
      };
    } catch (error) {
      if (authRequired && !client?.staticAuth)
        return { name, tools: {}, authStatus: "notLoggedIn" };
      throw error;
    }
  }
}
