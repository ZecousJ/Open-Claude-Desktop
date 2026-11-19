import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { mcpEditingRefusal } from "../../shared/client-policy";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { probeConnector } from "../connectors/connector-probe";
import { connectorFetch } from "../../runner/src/connectors";
import type { CustomConnectorInput } from "../connectors/mcp-config-file";
import { connectorUrlError } from "../../shared/custom-connector";
import {
  connectorCredentials,
  ConnectorClients,
} from "../connectors/connector-clients";
import {
  customConnectorEntry,
  validBearerToken,
  withToolEnabled,
  withToolApproval,
  withoutAlwaysAllowed,
} from "../connectors/mcp-config-file";
import {
  forgetDesktopConnectorToken,
  desktopConnectorLogin,
  revokeDesktopConnectorAuth,
} from "../connectors/connector-auth";
import { ConnectorOAuthRevocationError } from "../../runner/src/connector-oauth";
import { shell } from "electron";
import { connectorSignInUrl } from "../connectors/connector-owner";
import { registerSkillHandlers } from "./skills";
import type { ConnectorHistory } from "../connectors/connector-history";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { McpServers } from "../../shared/settings-desktop-api";

/** What registerSettingsConnectorHandlers needs from settings-desktop.ts. */
export interface RegisterSettingsConnectorHandlersKit {
  connectorHistory: () => ConnectorHistory;
  connectorLease: (
    key: string,
    resource: string,
  ) => {
    configuration: Record<string, unknown>;
    wait<T>(promise: Promise<T>): Promise<T>;
    current: () => boolean;
    assertCurrent(): void;
  };
  ctx: AppContext;
  handle: IpcHandle;
  mcpServers: (startLocal?: boolean, refreshName?: string) => Promise<McpServers>;
}

export function registerSettingsConnectorHandlers(
  kit: RegisterSettingsConnectorHandlersKit,
) {
  const { connectorHistory, connectorLease, ctx, handle, mcpServers } = kit;
  const credentialWrites = new Map<string, {
    entry: unknown;
    previous: ReturnType<ConnectorClients["get"]>;
  }>();
  const readAfterPermissionWrite = async () => {
    const store = ctx.store,
      engine = ctx.engine,
      configuration = store.settings.mcpServers;
    const current = () => {
      if (
        ctx.store !== store ||
        ctx.engine !== engine ||
        store.settings.mcpServers !== configuration
      )
        throw Error(
          "The connector configuration or account changed during this request.",
        );
    };
    for (let attempt = 0; ; attempt++) {
      current();
      try {
        const result = await mcpServers();
        current();
        return result;
      } catch (error) {
        current();
        if (
          attempt >= 4 ||
          !/engine is not connected|connection closed|not running|engine.*starting/i.test(
            String(error),
          )
        )
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 150 * (attempt + 1)),
        );
      }
    }
  };
  handle("mcpServers", (startLocal?: boolean) => mcpServers(startLocal));
  // Settings → Connectors (R13-D): the same file and policy as Edit config.
  const configFile = () => {
    const file = ctx.mcpConfig;
    if (!file) throw Error("Sign in to change connectors.");
    return file;
  };
  const serverName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
  handle(
    "probeConnector",
    async (raw: unknown, rawName?: unknown, rawTransport?: unknown) => {
      if (!ctx.policy().localMcpEditing)
        throw Error(mcpEditingRefusal(ctx.policy()));
      const url = z.string().max(2048).parse(raw);
      const name = serverName.optional().parse(rawName) ?? "connector";
      if (!connectorAllowed(ctx.policy(), name, { url }))
        throw Error("Your administrator doesn't allow this connector.");
      const transport = z
        .enum(["sse", "streamable-http"])
        .optional()
        .parse(rawTransport);
      const connectors = ctx.connectors;
      const lease = connectorLease(
        `probe:${name}`,
        JSON.stringify([url, transport]),
      );
      const result = await lease.wait(
        probeConnector(
          url,
          connectors?.fetch ?? connectorFetch({ level: "full" }),
          transport,
        ),
      );
      if (
        ctx.connectors !== connectors ||
        !ctx.policy().localMcpEditing ||
        !connectorAllowed(ctx.policy(), name, { url })
      )
        throw Error(
          "The connector configuration changed. Refresh and try again.",
        );
      return result;
    },
  );
  handle("addCustomConnector", async (raw: unknown) => {
    const file = configFile();
    const store = ctx.store;
    const connectors = ctx.connectors;
    const policy = ctx.policy();
    if (!policy.localMcpEditing) throw Error(mcpEditingRefusal(policy));
    const current = store.settings.mcpServers;
    const input = raw as CustomConnectorInput;
    const urlError = connectorUrlError(String(input?.url ?? ""));
    if (urlError) throw Error(urlError);
    const client = connectorCredentials(input ?? {});
    const [name, entry] = customConnectorEntry(input, current);
    const lease = connectorLease(
      `connector:${name}`,
      JSON.stringify([name, entry.url, entry.transport]),
    );
    const token = validBearerToken(input?.bearerToken);
    if (client.staticAuth && (token || entry.bearer_token_env_var))
      throw Error("Supply connector authentication once.");
    if (connectors) {
      if (entry.bearer_token_env_var)
        throw Error("Enter the token itself, not a variable name.");
      await lease.wait(connectors.assertUrl(String(entry.url)));
    } else if (token)
      throw Error("Use an environment variable name for the token.");
    const assertWrite = () => {
      lease.assertCurrent();
      if (
        ctx.connectors !== connectors ||
        ctx.mcpConfig !== file ||
        store.settings.mcpServers !== current
      )
        throw Error(
          "The connector configuration changed. Refresh and try again.",
        );
      if (!ctx.policy().localMcpEditing)
        throw Error(mcpEditingRefusal(ctx.policy()));
      if (!connectorAllowed(ctx.policy(), name, entry))
        throw Error("Your administrator doesn't allow this connector.");
    };
    assertWrite();
    const clients = new ConnectorClients(store.root);
    const oldEntry = current[name] as { url?: string } | undefined;
    const credentialKey = JSON.stringify([store.root, name]);
    const staged = credentialWrites.get(credentialKey);
    const previousClient = staged && staged.entry === oldEntry
      ? staged.previous
      : oldEntry?.url ? clients.get(name, oldEntry.url) : undefined;
    assertWrite();
    clients.set(
      name,
      input.replaceName && oldEntry?.url === entry.url
        ? previousClient
        : client,
      String(entry.url),
    );
    const writtenClient = clients.get(name);
    const write = { entry: oldEntry, previous: previousClient };
    credentialWrites.set(credentialKey, write);
    try {
      assertWrite();
      const next = { ...current, [name]: entry };
      if (file.commitCustomConnector) await file.commitCustomConnector(next, assertWrite);
      else file.update(next);
    } catch (error) {
      // Rollback always belongs to the captured profile, even if a callback retired it.
      const persisted = new ConnectorClients(store.root);
      if (credentialWrites.get(credentialKey) === write &&
        store.settings.mcpServers[name] === oldEntry &&
        isDeepStrictEqual(persisted.get(name), writtenClient))
        persisted.set(name, previousClient, oldEntry?.url);
      lease.assertCurrent();
      throw error;
    } finally {
      if (credentialWrites.get(credentialKey) === write)
        credentialWrites.delete(credentialKey);
    }
    lease.assertCurrent();
    if (input.replaceName && oldEntry?.url !== entry.url && !connectors)
      await lease.wait(forgetDesktopConnectorToken(ctx, name, oldEntry?.url, lease.assertCurrent));
    lease.assertCurrent();
    if (token) connectors?.setToken(name, token);
    return lease.wait(mcpServers());
  });
  handle("refreshConnectorTools", async (raw: unknown, officialAssertCurrent?: () => void) => {
    const name = serverName.parse(raw);
    const file = configFile();
    const configuration = ctx.store.settings.mcpServers;
    const server = configuration[name];
    if (!server || typeof server !== "object" || !("url" in server) ||
        typeof server.url !== "string" || "command" in server ||
        "enabled" in server && server.enabled === false ||
        !connectorAllowed(ctx.policy(), name, server))
      throw Error("This remote connector is unavailable.");
    officialAssertCurrent?.();
    const lease = connectorLease(`refresh:${name}`, server.url);
    const result = await lease.wait(mcpServers(!file.readCatalog, name));
    officialAssertCurrent?.();
    if (ctx.mcpConfig !== file || ctx.store.settings.mcpServers !== configuration ||
        !connectorAllowed(ctx.policy(), name, server))
      throw Error("The connector configuration changed.");
    return !result.configError &&
      result.servers.some((item) => item.name === name && item.state === "ready" && item.authStatus !== "notLoggedIn");
  });
  handle("revokeConnector", async (rawName: unknown, rawResource: unknown) => {
    const name = serverName.parse(rawName);
    const resource = z.string().url().parse(rawResource);
    const store = ctx.store;
    const configured = store.settings.mcpServers[name] as
      { claudex_transport?: unknown } | undefined;
    const lease = connectorLease(`connector:${name}`, resource);
    const assertTarget = () => {
      lease.assertCurrent();
      const current = store.settings.mcpServers[name] as
        { url?: string; command?: string; claudex_transport?: unknown } | undefined;
      if (ctx.accountRetiring || ctx.connectors ||
          current?.url !== resource || current.command ||
          current.claudex_transport !== configured?.claudex_transport ||
          !connectorAllowed(ctx.policy(), name, current))
        throw Error("The connector configuration changed. Refresh and try again.");
    };
    assertTarget();
    try {
      const revoked = await lease.wait(revokeDesktopConnectorAuth(ctx, name, resource, assertTarget));
      assertTarget();
      return revoked;
    } catch (error) {
      assertTarget();
      if (error instanceof ConnectorOAuthRevocationError && error.reason === "unavailable")
        return false;
      throw error;
    }
  });
  handle("removeConnector", async (raw: unknown, officialAssertCurrent?: () => void) => {
    const name = serverName.parse(raw);
    const file = configFile(), store = ctx.store, connectors = ctx.connectors;
    const current = store.settings.mcpServers;
    if (!Object.hasOwn(current, name)) throw Error("This connector no longer exists.");
    const { [name]: removed, ...rest } = current;
    const lease = connectorLease(`connector:${name}`, name);
    const assertWrite = () => {
      officialAssertCurrent?.();
      lease.assertCurrent();
      if (ctx.accountRetiring || ctx.mcpConfig !== file || ctx.connectors !== connectors ||
          store.settings.mcpServers !== current)
        throw Error("The connector configuration changed. Refresh and try again.");
      if (!ctx.policy().localMcpEditing) throw Error(mcpEditingRefusal(ctx.policy()));
    };
    assertWrite();
    if (file.commitCustomConnector) await file.commitCustomConnector(rest, assertWrite);
    else file.update(rest);
    lease.assertCurrent();
    if (ctx.connectors !== connectors || Object.hasOwn(store.settings.mcpServers, name))
      throw Error("The connector was not removed.");
    connectors?.setToken(name, undefined);
    new ConnectorClients(store.root).set(name);
    if (!connectors)
      await lease.wait(forgetDesktopConnectorToken(
        ctx,
        name,
        (removed as { url?: string } | undefined)?.url,
        lease.assertCurrent,
      ));
    lease.assertCurrent();
    if (!officialAssertCurrent) return mcpServers();
  });
  handle(
    "setConnectorTool",
    async (rawName: unknown, rawTool: unknown, rawEnabled: unknown) => {
      const name = serverName.parse(rawName);
      const tool = z.string().min(1).max(200).parse(rawTool);
      const enabled = z.boolean().parse(rawEnabled);
      const current = ctx.store.settings.mcpServers;
      const server = current[name];
      if (!server || typeof server !== "object")
        throw Error("This connector no longer exists.");
      configFile().update({
        ...current,
        [name]: withToolEnabled(
          server as Record<string, unknown>,
          tool,
          enabled,
        ),
      });
      return mcpServers();
    },
  );
  handle(
    "setConnectorToolPermission",
    async (rawName: unknown, rawTool: unknown, rawPermission: unknown) => {
      const name = serverName.parse(rawName);
      const tool = z.string().min(1).max(200).parse(rawTool);
      const permission = z.enum(["allow", "ask", "block"]).parse(rawPermission);
      if (permission === "allow" && ctx.policy().approvalsAlwaysAllow === false)
        throw Error(
          "Your administrator requires approving each request. Choose Needs approval.",
        );
      const current = ctx.store.settings.mcpServers;
      const server = current[name];
      if (!server || typeof server !== "object")
        throw Error("This connector no longer exists.");
      // Blocked is `disabled_tools`; Always allow never asks; Needs approval
      // asks each time (Codex `approval_mode`).
      const unblocked = withToolEnabled(
        server as Record<string, unknown>,
        tool,
        permission !== "block",
      );
      configFile().update({
        ...current,
        [name]: withToolApproval(
          unblocked,
          tool,
          permission === "allow"
            ? "approve"
            : permission === "ask"
              ? "prompt"
              : undefined,
        ),
      });
      return readAfterPermissionWrite();
    },
  );
  handle("setConnectorToolPermissions", async (raw: unknown) => {
    const changes = z
      .array(
        z
          .object({
            name: serverName,
            tool: z.string().min(1).max(200),
            permission: z.enum(["allow", "ask", "block"]),
          })
          .strict(),
      )
      .min(1)
      .max(500)
      .parse(raw);
    // Validate the entire request before changing configuration. In particular,
    // a refused grant must not leave earlier tools in a partly changed state.
    const next = { ...ctx.store.settings.mcpServers };
    for (const { name, tool, permission } of changes) {
      if (permission === "allow" && ctx.policy().approvalsAlwaysAllow === false)
        throw Error(
          "Your administrator requires approving each request. Choose Needs approval.",
        );
      const server = next[name];
      if (!server || typeof server !== "object")
        throw Error("This connector no longer exists.");
      next[name] = withToolApproval(
        withToolEnabled(
          server as Record<string, unknown>,
          tool,
          permission !== "block",
        ),
        tool,
        permission === "allow"
          ? "approve"
          : permission === "ask"
            ? "prompt"
            : undefined,
      );
    }
    const file = configFile();
    if (file.commitToolPolicy) {
      const store = ctx.store;
      const lease = connectorLease("tool-policy", "tool-permission-batch");
      const current = () => {
        try { lease.assertCurrent(); } catch { return false; }
        return ctx.store === store && ctx.mcpConfig === file &&
          (ctx.policy().approvalsAlwaysAllow !== false ||
            !changes.some((change) => change.permission === "allow"));
      };
      await file.commitToolPolicy(next, current);
    } else file.update(next);
    return readAfterPermissionWrite();
  });
  handle("forgetConnectorApprovals", async (rawName?: unknown) => {
    const name =
      rawName === undefined || rawName === null
        ? undefined
        : serverName.parse(rawName);
    configFile().update(
      withoutAlwaysAllowed(ctx.store.settings.mcpServers, name) as Record<
        string,
        unknown
      >,
    );
    return mcpServers();
  });
  handle(
    "completeConnectorLogin",
    async (rawState: unknown, rawCode: unknown, rawName?: unknown, rawIssuer?: unknown) => {
      const connectors = ctx.connectors;
      if (!connectors?.completeLogin)
        throw Error("Only remote connectors sign in with a browser.");
      const store = ctx.store;
      const configured = store.settings.mcpServers;
      const state = z.string().min(1).max(512).parse(rawState);
      const code = z.string().min(1).max(8192).parse(rawCode);
      const issuer = z.string().url().max(2048).optional().parse(rawIssuer);
      const expectedName = serverName.optional().parse(rawName);
      const lease = connectorLease("complete", "oauth-callback");
      const name = await lease.wait(connectors.completeLogin(state, code, issuer, expectedName));
      const before = configured[name] as { url?: string } | undefined;
      const server = store.settings.mcpServers[name] as
        { url?: string } | undefined;
      if (
        ctx.connectors !== connectors ||
        !before?.url ||
        server?.url !== before.url ||
        !connectorAllowed(ctx.policy(), name, server)
      )
        throw Error(
          "The connector configuration changed. Refresh and try again.",
        );
      lease.assertCurrent();
      connectorHistory().complete(name, server.url);
      return name;
    },
  );
  handle("connectConnector", async (raw: unknown, returnUrl?: unknown, prepareOnly?: unknown) => {
    const store = ctx.store;
    const connectors = ctx.connectors;
    const name = serverName.parse(raw);
    const server = store.settings.mcpServers[name] as
      Record<string, unknown> | undefined;
    if (!server || typeof server.url !== "string")
      throw Error("Only remote connectors sign in with a browser.");
    const resource = server.url;
    const credentials = new ConnectorClients(store.root).get(name, resource);
    if (credentials?.staticAuth)
      throw Error("This connector uses request headers to authenticate.");
    const transport = server.transport;
    const lease = connectorLease(
      `connector:${name}`,
      JSON.stringify([name, resource, transport]),
    );
    const assertTarget = () => {
      lease.assertCurrent();
      const current = store.settings.mcpServers[name] as
        Record<string, unknown> | undefined;
      if (
        ctx.connectors !== connectors ||
        current?.url !== resource ||
        current?.transport !== transport
      )
        throw Error(
          "The connector configuration changed. Refresh and try again.",
        );
      if (!connectorAllowed(ctx.policy(), name, current))
        throw Error("Your administrator doesn't allow this connector.");
    };
    assertTarget();
    if (prepareOnly !== undefined && (prepareOnly !== true || connectors))
      throw Error("Connector sign-in preparation is unavailable.");
    if (connectors?.beginLogin) {
      const address = await lease.wait(
        connectors.beginLogin(
          name,
          resource,
          z.string().url().max(8192).parse(returnUrl),
        ),
      );
      assertTarget();
      connectorHistory().begin(name, resource);
      return address;
    }
    if (
      server.display_name ||
      credentials
    ) {
      const address = await lease.wait(
        desktopConnectorLogin(ctx, name, resource, lease.assertCurrent),
      );
      assertTarget();
      if (prepareOnly === true) return connectorSignInUrl(address);
      await lease.wait(shell.openExternal(connectorSignInUrl(address)));
      assertTarget();
      connectorHistory().begin(name, resource);
      return;
    }
    const rpc = ctx.engine.rpc;
    if (!rpc || ctx.engine.state.state !== "ready")
      throw Error("Wait for Claudex to finish starting, then try again.");
    const result = await lease.wait(
      rpc.call("mcpServer/oauth/login", { name }),
    );
    assertTarget();
    if (ctx.engine.rpc !== rpc || ctx.engine.state.state !== "ready")
      throw Error(
        "This connector operation belongs to a retired account or connector. Open it again.",
      );
    const address = connectorSignInUrl(result?.authorizationUrl);
    assertTarget();
    if (prepareOnly === true) return address;
    await lease.wait(shell.openExternal(address));
    assertTarget();
    connectorHistory().begin(name, resource);
  });
  handle("listMcp", async () => {
    const rpc = ctx.engine.rpc;
    if (!rpc) return [];
    const r = await rpc.call("mcpServerStatus/list", {});
    return r.data ?? [];
  });
  handle("setupWindowsSandbox", async () => {
    ctx.noActive();
    return ctx.engine.setupWindowsSandbox();
  });
  registerSkillHandlers(handle, ctx);
}
