import { z } from "zod";
import { mcpEditingRefusal } from "../../shared/client-policy";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { probeConnector } from "../connectors/connector-probe";
import { connectorFetch } from "../../runner/src/connectors";
import type { CustomConnectorInput } from "../connectors/mcp-config-file";
import { connectorUrlError } from "../../shared/custom-connector";
import {
  connectorOAuthClient,
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
} from "../connectors/connector-auth";
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
  mcpServers: () => Promise<McpServers>;
}

export function registerSettingsConnectorHandlers(
  kit: RegisterSettingsConnectorHandlersKit,
) {
  const { connectorHistory, connectorLease, ctx, handle, mcpServers } = kit;
  handle("mcpServers", mcpServers);
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
    const client = connectorOAuthClient(input ?? {});
    const [name, entry] = customConnectorEntry(input, current);
    const lease = connectorLease(
      `connector:${name}`,
      JSON.stringify([name, entry.url, entry.transport]),
    );
    const token = validBearerToken(input?.bearerToken);
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
    const previousClient = clients.get(name);
    assertWrite();
    clients.set(
      name,
      input.replaceName && oldEntry?.url === entry.url
        ? previousClient
        : client,
      String(entry.url),
    );
    try {
      assertWrite();
      file.update({ ...current, [name]: entry });
    } catch (error) {
      // Rollback always belongs to the captured profile, even if a callback retired it.
      clients.set(name, previousClient, oldEntry?.url);
      lease.assertCurrent();
      throw error;
    }
    lease.assertCurrent();
    if (input.replaceName && oldEntry?.url !== entry.url && !connectors)
      forgetDesktopConnectorToken(store.root, name, oldEntry?.url);
    lease.assertCurrent();
    if (token) connectors?.setToken(name, token);
    return lease.wait(mcpServers());
  });
  handle("removeConnector", async (raw: unknown) => {
    const name = serverName.parse(raw);
    const current = ctx.store.settings.mcpServers;
    if (!(name in current)) throw Error("This connector no longer exists.");
    const { [name]: _removed, ...rest } = current;
    configFile().update(rest);
    ctx.connectors?.setToken(name, undefined);
    new ConnectorClients(ctx.store.root).set(name);
    if (!ctx.connectors)
      forgetDesktopConnectorToken(
        ctx.store.root,
        name,
        (_removed as { url?: string } | undefined)?.url,
      );
    return mcpServers();
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
      return mcpServers();
    },
  );
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
    async (rawState: unknown, rawCode: unknown) => {
      const connectors = ctx.connectors;
      if (!connectors?.completeLogin)
        throw Error("Only remote connectors sign in with a browser.");
      const store = ctx.store;
      const configured = store.settings.mcpServers;
      const state = z.string().min(1).max(512).parse(rawState);
      const code = z.string().min(1).max(8192).parse(rawCode);
      const lease = connectorLease("complete", "oauth-callback");
      const name = await lease.wait(connectors.completeLogin(state, code));
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
  handle("connectConnector", async (raw: unknown, returnUrl?: unknown) => {
    const store = ctx.store;
    const connectors = ctx.connectors;
    const name = serverName.parse(raw);
    const server = store.settings.mcpServers[name] as
      Record<string, unknown> | undefined;
    if (!server || typeof server.url !== "string")
      throw Error("Only remote connectors sign in with a browser.");
    const resource = server.url;
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
      new ConnectorClients(store.root).get(name, resource)
    ) {
      const address = await lease.wait(
        desktopConnectorLogin(ctx, name, resource, lease.assertCurrent),
      );
      assertTarget();
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
