import type http from "node:http";
import { z } from "zod";
import type {
  PluginCatalog,
  PluginDetails,
  PluginEntry,
} from "../../../shared/collections-api";
import {
  installedPluginLibrary,
  isPersonalRuntimePlugin,
  runtimePluginLibraryId,
} from "./library-plugins";
import { officialUiReadMaxBytes } from "../../../shared/official-ui-web";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";
import { Sub2ApiError } from "../../sub2api/http";
import { readInstalledOrganizationPlugins } from "./plugin-organization-read";
import { officialOrganizationPluginMutation } from "../../../shared/official-plugin-organizations";

function record(entry: PluginEntry, mutable = false) {
  return {
    id: runtimePluginLibraryId(entry.id),
    name: entry.name,
    display_name: entry.title || null,
    description: entry.description ?? null,
    enabled: entry.enabled,
    can_edit: false,
    can_toggle: mutable,
    can_remove: mutable && entry.installed,
    claudex_local_marketplace: mutable || undefined,
    marketplace_name: entry.marketplace,
    marketplace_id: null,
    partition_by:
      entry.personal === true || mutable ? "account" : "marketplace",
    version: entry.installedVersion ?? null,
    created_at: null,
    updated_at: null,
    content_scan: null,
  };
}
function checkedDetails(value: PluginDetails) {
  if (
    !value ||
    typeof value.description !== "string" ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.mcpServers) ||
    !Array.isArray(value.apps) ||
    !Number.isSafeInteger(value.hooks) ||
    value.hooks < 0 ||
    value.hooks > 10000 ||
    value.description.length > 20000 ||
    Buffer.byteLength(value.description, "utf8") > 20000 ||
    value.skills.length > 1000 ||
    value.mcpServers.length > 1000 ||
    value.apps.length > 1000 ||
    [...value.skills, ...value.mcpServers, ...value.apps].some(
      (entry) =>
        !entry ||
        typeof entry.name !== "string" ||
        !entry.name ||
        entry.name.length > 512 ||
        Buffer.byteLength(entry.name, "utf8") > 512 ||
        ("description" in entry &&
          entry.description !== undefined &&
          (typeof entry.description !== "string" ||
            entry.description.length > 20000 ||
            Buffer.byteLength(entry.description, "utf8") > 20000)),
    )
  )
    throw Error("The plugin details are invalid.");
  let bytes = Buffer.byteLength(value.description, "utf8");
  for (const list of [value.skills, value.mcpServers, value.apps])
    for (const item of list) {
      bytes +=
        Buffer.byteLength(item.name, "utf8") +
        ("description" in item && typeof item.description === "string"
          ? Buffer.byteLength(item.description, "utf8")
          : 0);
      if (bytes > 1024 * 1024) throw Error("The plugin details are too large.");
    }
  return value;
}

function describePlugin(value: PluginDetails) {
  const details = checkedDetails(value);
  return {
    description: details.description,
    skills: details.skills.map((skill) => ({
      name: skill.name, description: skill.description ?? null,
    })),
    mcp_servers: Object.fromEntries(details.mcpServers.map((server) => [server.name, null])),
  };
}

/** Independently recheck organization and identity around every runtime read. */
export async function pluginReadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  const match =
    /^\/api\/organizations\/([^/]+)\/plugins\/(list-plugins|plugin_[a-f0-9]{24})(\/enabled)?$/.exec(
      p,
    );
  if (!match) return false;
  const localCall = ctx.readOnly ? undefined : ctx.localCall;
  const enabledRoute = !!match[3] && match[2] !== "list-plugins";
  const method = req.method ?? "GET";
  const managed = officialOrganizationPluginMutation(method, p + url.search);
  if (
    enabledRoute ? method !== "PUT" || (!localCall && !managed) : !managed && (method !== "GET" || match[3])
  )
    return false;
  const bad = (message: string, status = 400) =>
    reply(res, { error: { type: "invalid_request_error", message } }, status);
  const owner = ctx.account()?.id,
    identity = ctx.sessionIdentity?.(),
    root = ctx.stateDirectory?.();
  if (!owner) return bad("Sign in to continue.", 401);
  if (match[1] !== organizationUuid(owner))
    return bad("Organization not found.", 404);
  const current = () => {
    if (
      identity == null ||
      identity === "" ||
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== identity ||
      ctx.stateDirectory?.() !== root
    )
      throw Error("The account changed.");
  };
  const call = async (method: string, ...args: unknown[]) => {
    current();
    const result = await ctx.call(method, ...args);
    current();
    return result;
  };
  const send = (value: unknown) => {
    current();
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body, "utf8") > officialUiReadMaxBytes)
      return bad("The plugin response is too large.", 413);
    return reply(res, value);
  };
  const params = url.searchParams;
  if (managed?.kind === "remove") {
    if (!ctx.removeOrganizationPlugin) return bad("Organization plugin removal is unavailable.", 501);
    if (req.headers["content-length"] && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"])
      return bad("Organization plugin removal does not accept a request body.");
    try {
      current();
      return send(await ctx.removeOrganizationPlugin(match[2]));
    } catch {
      return bad("The organization plugin could not be removed.", 409);
    }
  }
  const eligible = (entry: PluginEntry, catalog: PluginCatalog) =>
    !!localCall && isPersonalRuntimePlugin(entry, catalog);
  const readEntry = async () => {
    const catalog = (await call("listPlugins")) as PluginCatalog;
    installedPluginLibrary(catalog);
    const entries = catalog.plugins.filter(
      (entry) =>
        (entry.installed || (eligible(entry, catalog) && entry.installable)) &&
        runtimePluginLibraryId(entry.id) === match[2],
    );
    if (entries.length > 1) throw Error("Duplicate plugin identity.");
    const entry = entries[0];
    if (entry && !entry.installed) {
      installedPluginLibrary({
        ...catalog,
        plugins: [{ ...entry, installed: true }],
      });
      if (
        entry.id !== `${entry.name}@${entry.marketplace}` ||
        !catalog.marketplaces.some(
          (market) => market.name === entry.marketplace,
        )
      )
        throw Error("Plugin identity is not in its marketplace.");
    }
    return entry && { entry, mutable: eligible(entry, catalog) };
  };
  if (enabledRoute) {
    const organization = managed?.kind === "enable";
    if (params.size && !organization) return bad("Unsupported plugin update query.");
    if (organization && !ctx.setOrganizationPluginEnabled) return bad("Organization plugin installation is unavailable.", 501);
    try {
      const { enabled } = z
        .object({ enabled: z.boolean() })
        .strict()
        .parse(await readBoundedJson(req, 1024));
      if (organization) {
        current();
        return send(await ctx.setOrganizationPluginEnabled!(match[2], enabled));
      }
      if (!localCall) return bad("Plugin installation is unavailable.", 501);
      const target = await readEntry();
      if (!target?.mutable) return bad("Plugin not found.", 404);
      const { entry } = target;
      if (enabled && !entry.installable)
        return bad("This plugin cannot be enabled.", 409);
      current();
      if (!entry.installed) {
        if (!enabled) return send(record(entry, true));
        await localCall("installPlugin", entry.id);
        current();
      }
      const afterInstall = (await readEntry())?.entry;
      if (!afterInstall?.installed)
        return bad("The plugin installation could not be confirmed.", 409);
      if (afterInstall.enabled !== enabled) {
        current();
        await localCall("setNativePluginEnabled", afterInstall.id, enabled);
        current();
      }
      const result = (await readEntry())?.entry;
      if (!result?.installed || result.enabled !== enabled)
        return bad("The plugin setting could not be confirmed.", 409);
      return send(record(result, true));
    } catch (error) {
      if (error instanceof RequestBodyError)
        return bad(error.message, error.status);
      if (error instanceof z.ZodError) return bad("Invalid plugin setting.");
      return bad("The plugin setting could not be saved.", 409);
    }
  }
  if (match[2] === "list-plugins") {
    const allowed = new Set(["enabled_only", "limit", "offset"]);
    if (
      [...params.keys()].some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => params.getAll(key).length > 1)
    )
      return bad("Unsupported plugin list query.");
    if (
      params.has("enabled_only") &&
      !["true", "false"].includes(params.get("enabled_only")!)
    )
      return bad("Invalid plugin enabled filter.");
    const limit = params.get("limit") ?? "1000",
      offset = params.get("offset") ?? "0";
    if (
      !/^[1-9][0-9]{0,3}$/.test(limit) ||
      Number(limit) > 1000 ||
      !/^(0|[1-9][0-9]*)$/.test(offset) ||
      !Number.isSafeInteger(Number(offset))
    )
      return bad("Invalid plugin list page.");
    try {
      const catalog = (await call("listPlugins")) as PluginCatalog;
      installedPluginLibrary(catalog); // Fail on partial/malformed catalogs; never fake an empty success.
      const organizationItems = await readInstalledOrganizationPlugins(ctx);
      const entries = [
        ...catalog.plugins.filter((entry) => entry.installed).map((entry) => record(entry, eligible(entry, catalog))),
        ...organizationItems.map((item) => ({
          id: item.id, name: item.name, display_name: item.display_name, description: item.description,
          partition_by: item.plugin.partition_by, version: item.version, installed: true,
          marketplace_id: item.provenance.marketplace_id, marketplace_name: item.provenance.marketplace_name,
          marketplace_kind: item.provenance.marketplace_kind,
          claudex_organization_plugin: item.claudex_organization_plugin,
          ...item.viewer.installed!,
        })),
      ].filter((entry) => params.get("enabled_only") !== "true" || entry.enabled);
      const end = Number(offset) + Number(limit);
      return send({
        plugins: entries.slice(Number(offset), end),
        has_more: end < entries.length,
      });
    } catch {
      return bad("The installed plugin catalog could not be read.", 500);
    }
  }
  if (params.size) return bad("Unsupported plugin detail query.");
  try {
    const target = await readEntry();
    if (!target && ctx.readOrganizationPluginDetails) {
      try {
        current();
        const managed = await ctx.readOrganizationPluginDetails(match[2]);
        if (managed) return send({ ...managed.record, ...describePlugin(managed.details) });
      } catch (error) {
        if (!(error instanceof Sub2ApiError && error.status === 404)) throw error;
      }
    }
    if (!target) return bad("Plugin not found.", 404);
    const { entry, mutable } = target;
    return send({
      ...record(entry, mutable),
      ...describePlugin((await call("readPlugin", entry.id)) as PluginDetails),
      // File bytes, command bodies, hook configuration, scan and version history
      // are unavailable here; their endpoints remain explicitly unsupported.
    });
  } catch {
    return bad("The installed plugin details could not be read.", 500);
  }
}
