import os from "node:os";
import { directorySubmissionInput } from "../../shared/directory-submissions-input";
import { z } from "zod";
import { Sub2ApiError } from "../sub2api/http";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { assertAccountOperationCurrent } from "../account/operation-lease";
import { connectorConfigurationError } from "../../shared/connector-url-configuration";
import { id, defaultModelChoice } from "./collections";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { PluginService } from "../plugins/plugins";
import type { DirectorySubmissions } from "../connectors/directory-submissions";

/** What registerDirectoryHandlers needs from collections.ts. */
export interface RegisterDirectoryHandlersKit {
  ctx: AppContext;
  handle: IpcHandle;
  plugins: PluginService;
  activePlugins: () => PluginService;
  submissions: () => DirectorySubmissions;
}

export function registerDirectoryHandlers(kit: RegisterDirectoryHandlersKit) {
  const { ctx, handle, plugins, activePlugins, submissions } = kit;
  const verifyTools = async (name: string, endpoint?: string) => {
    const { store, engine, mcpConfig, accountActivationIdentity } = ctx;
    const config = store.settings.mcpServers[name];
    if (!config || typeof config !== "object" || !("url" in config) ||
        typeof config.url !== "string" || "command" in config ||
        ("enabled" in config && config.enabled === false) ||
        (endpoint !== undefined && config.url !== endpoint) ||
        !connectorAllowed(ctx.policy(), name, config))
      throw Error("The selected remote connector is unavailable.");
    const current = () => !ctx.accountRetiring && ctx.store === store && ctx.engine === engine &&
      ctx.mcpConfig === mcpConfig && ctx.accountActivationIdentity === accountActivationIdentity &&
      store.settings.mcpServers[name] === config && connectorAllowed(ctx.policy(), name, config);
    assertAccountOperationCurrent(current);
    if (mcpConfig?.readCatalog) {
      const result = await mcpConfig.readCatalog(name);
      assertAccountOperationCurrent(current);
      const server = result.servers.find(row => row.name === name && row.state === "ready" &&
        row.authStatus !== "notLoggedIn");
      return (server?.toolList ?? []).map(row => row.name);
    }
    const provider = store.settings.providers.find(entry => entry.id === store.settings.activeProviderId);
    if (provider) await engine.ensure(provider);
    assertAccountOperationCurrent(current);
    const response = await engine.rpc?.call("mcpServerStatus/list", {});
    assertAccountOperationCurrent(current);
    const server = response?.data?.find((row: { name: string }) => row.name === name);
    return server?.serverInfo && server.authStatus !== "notLoggedIn"
      ? Object.keys(server.tools ?? {})
      : [];
  };
  handle("listApprovedDirectory", () => submissions().directory());
  handle("listDirectorySubmissions", () => submissions().list());
  handle("saveDirectorySubmission", async (raw: unknown, rawSubmit: unknown) => {
    const service = submissions();
    const input = directorySubmissionInput.parse(raw);
    const submit = z.boolean().parse(rawSubmit);
    if (submit) input.slug ||= input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (input.kind === "mcp" && (submit || (input.original && input.serverName))) {
      const configurationError = connectorConfigurationError(input, input.url);
      if (configurationError) throw new Sub2ApiError(400, "DIRECTORY_CONNECTOR_INVALID", configurationError);
      input.tools = await verifyTools(input.serverName ?? "", input.url);
      if (!input.tools.length)
        throw new Sub2ApiError(400, "DIRECTORY_TOOLS_UNAVAILABLE", "No tools were verified. Reconnect the MCP server and try again.");
      input.toolsVerified = true;
    } else if (input.kind === "mcp" && input.original) {
      input.tools = [];
      input.toolsVerified = false;
    }
    return service.save(input, submit);
  });
  handle("deleteDirectorySubmission", (raw: unknown) =>
    submissions().delete(z.string().uuid().parse(raw)),
  );
  handle("publishDirectorySubmission", (raw: unknown) =>
    submissions().publish(z.string().uuid().parse(raw)),
  );
  handle("verifyDirectorySubmissionTools", (raw: unknown) => verifyTools(id.parse(raw)));
  handle("readPlugin", (raw: unknown) => plugins.read(id.parse(raw)));
  handle("installPlugin", (raw: unknown) => activePlugins().install(id.parse(raw)));
  handle("uninstallPlugin", (raw: unknown) => activePlugins().uninstall(id.parse(raw)));
  handle("setNativePluginEnabled", (raw: unknown, enabled: unknown) =>
    activePlugins().setEnabled(id.parse(raw), z.boolean().parse(enabled)));
  handle("addPluginMarketplace", async (raw: unknown) => {
    await activePlugins().addMarketplace(raw);
  });
  handle("addNativePluginMarketplace", (raw: unknown) => {
    if (!ctx.window || ctx.engine.environment?.kind === "ssh")
      throw Error("Adding this marketplace requires a local desktop runtime.");
    return activePlugins().addMarketplace(raw);
  });
  handle("removeNativePluginMarketplace", (raw: unknown) => {
    if (!ctx.window || ctx.engine.environment?.kind === "ssh")
      throw Error("Removing this marketplace requires a local desktop runtime.");
    return activePlugins().removeMarketplace(id.parse(raw), true);
  });
  handle("refreshNativePluginMarketplace", (raw: unknown) => {
    if (!ctx.window || ctx.engine.environment?.kind === "ssh")
      throw Error("Refreshing this marketplace requires a local desktop runtime.");
    return activePlugins().upgradeMarketplaces(id.parse(raw), true);
  });
  handle("removePluginMarketplace", (raw: unknown) =>
    plugins.removeMarketplace(id.parse(raw)),
  );
  handle("upgradePluginMarketplaces", (raw?: unknown) =>
    plugins.upgradeMarketplaces(raw === undefined ? undefined : id.parse(raw)),
  );
  handle("setPluginMarketplaceAutoSync", (raw: unknown, enabled: unknown) =>
    plugins.setAutoSync(id.parse(raw), z.boolean().parse(enabled)),
  );
  // Duplicate plugin: the copy goes to the personal marketplace in this
  // computer's home folder, which the local runtime reads. A host without a
  // window (the web runner) shares its home folder between users: refused.
  handle("duplicatePlugin", (raw: unknown, rawCopy: unknown) => {
    if (ctx.window === undefined)
      throw new Error("Duplicating plugins needs the Claudex desktop app.");
    const copy = z
      .object({
        name: z.string().min(1).max(64),
        displayName: z.string().min(1).max(256).optional(),
      })
      .parse(rawCopy);
    return plugins.duplicate(id.parse(raw), copy, os.homedir());
  });
  // Rename plugin: the person's own plugins in that personal marketplace.
  handle("renamePlugin", (raw: unknown, rawTo: unknown) => {
    if (ctx.window === undefined)
      throw new Error("Renaming plugins needs the Claudex desktop app.");
    const to = z
      .object({
        name: z.string().min(1).max(64),
        displayName: z.string().min(1).max(256).optional(),
      })
      .parse(rawTo);
    return plugins.rename(id.parse(raw), to, os.homedir());
  });
  // Routines on "Default" follow the default model when Settings change.
  ctx.onSettingsChanged((settings) => {
    const choice = defaultModelChoice(settings);
    if (choice)
      ctx.scheduler?.retargetDefaults(choice.providerId, choice.model);
  });
}
