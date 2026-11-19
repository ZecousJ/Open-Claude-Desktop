import { z } from "zod";
import { runtimePluginLibraryId } from "../api/library-plugins";
import { marketplaceSource } from "../../plugins/plugin-catalog";
import type { AdapterContext } from "../api/context";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";

export function createNativePluginReads(
  ctx: AdapterContext,
  refusal: (code: string, message: string) => Error,
) {
  const scope = sessionAccountScope(ctx, () => {});
  const unsupported = (message: string): never => {
    throw refusal("plugin_context_unavailable", message);
  };
  const contextSchema = z
    .object({
      mode: z.enum(["ccd", "cowork"]),
      telemetryAttempt: z
        .object({
          attempt: z.number().int().positive(),
          maxAttempts: z.number().int().positive(),
        })
        .strict()
        .refine((value) => value.attempt <= value.maxAttempts)
        .optional(),
    })
    .strict();
  const mutationContextSchema = contextSchema.extend({
    pluginSource: z.literal("local").optional(),
    settingsLevel: z.literal("user").optional(),
  });
  const managementContextSchema = contextSchema.extend({
    scope: z.literal("registered-repositories"),
  });
  const idSchema = z.string().min(1).max(400);
  const marketplaceSchema = z.object({
    name: z.string().min(1).max(512),
    title: z.string().max(1024).optional(),
    source: z.string().max(4096).optional(),
    lastUpdated: z.number().finite().min(0).max(8640000000000000).optional(),
    syncError: z.string().optional(),
    userAdded: z.literal(true).optional(),
  });
  const catalogSchema = z.object({
    marketplaces: z.array(marketplaceSchema).max(1024),
    loadErrors: z.array(z.string()).max(1024),
  });
  const pluginSchema = z.object({
    id: idSchema,
    name: z.string().min(1).max(200),
    title: z.string().max(200),
    marketplace: z.string().min(1).max(200),
    installed: z.boolean(),
    installable: z.boolean(),
    source: z.enum(["git", "local", "other"]),
    description: z.string().max(600).optional(),
    developer: z.string().max(200).optional(),
    category: z.string().max(100).optional(),
    availableVersion: z.string().max(100).optional(),
    installedVersion: z.string().max(100).optional(),
  });
  const catalogFailure = () =>
    refusal(
      "plugin_catalog_unavailable",
      "The plugin marketplace catalog is incomplete or unavailable.",
    );
  const checkRequest = (
    domains: unknown,
    context: unknown,
    mutation = false,
    acceptsRepositoryDomains = false,
  ) => {
    if (!ctx.account()?.id)
      throw refusal(
        "account_unavailable",
        "Sign in to read plugin marketplaces.",
      );
    if (ctx.isCurrent?.() === false)
      throw Error("The account changed during this request.");
    if (
      context !== undefined &&
      !(mutation ? mutationContextSchema : contextSchema).safeParse(context)
        .success
    )
      unsupported(
        "Only account-level plugin marketplaces are available. Workspace and installation contexts are not supported.",
      );
    const allowed = z.array(z.string().max(253)).max(256).safeParse(domains);
    if (
      !allowed.success ||
      (!acceptsRepositoryDomains && allowed.data.length !== 0)
    )
      return unsupported(
        "Domain-scoped plugin marketplace reads are not available on this host.",
      );
    return allowed.data;
  };
  const readCatalog = async (allowSyncErrors = false) => {
    let source: unknown;
    try {
      source = await scope.guard(() => ctx.call("listPlugins"));
    } catch {
      scope.sync();
      throw refusal(
        "plugin_catalog_unavailable",
        "Plugin marketplaces could not be read. Try again.",
      );
    }
    scope.sync();
    if (ctx.isCurrent?.() === false)
      throw Error("The account changed during this request.");
    const parsed = catalogSchema.safeParse(source);
    if (
      !parsed.success ||
      parsed.data.loadErrors.length ||
      (!allowSyncErrors && parsed.data.marketplaces.some((m) => m.syncError))
    )
      throw catalogFailure();
    if (
      new Set(parsed.data.marketplaces.map((m) => m.name)).size !==
      parsed.data.marketplaces.length
    )
      throw refusal(
        "plugin_catalog_unavailable",
        "The plugin marketplace catalog contains duplicate identities.",
      );
    return { metadata: parsed.data, source };
  };
  const catalogPlugins = ({
    metadata,
    source,
  }: Awaited<ReturnType<typeof readCatalog>>) => {
    const { success, data } = z
      .object({ plugins: z.array(pluginSchema).max(4096) })
      .safeParse(source);
    const markets = new Set(metadata.marketplaces.map((m) => m.name));
    if (
      !success ||
      new Set(data.plugins.map((entry) => entry.id)).size !==
        data.plugins.length ||
      data.plugins.some(
        (entry) =>
          entry.id !== `${entry.name}@${entry.marketplace}` ||
          !markets.has(entry.marketplace),
      )
    )
      throw catalogFailure();
    return data.plugins;
  };
  const readPlugins = async () =>
    catalogPlugins(await readCatalog()).filter((entry) => entry.source !== "other");
  const bounded = <T>(rows: T[]): T[] => {
    if (Buffer.byteLength(JSON.stringify(rows)) > 1024 * 1024)
      throw refusal(
        "plugin_catalog_unavailable",
        "The plugin marketplace catalog is too large.",
      );
    return rows;
  };
  return {
    removeMarketplace: (
      raw: unknown,
      domains: unknown,
      context?: unknown,
      backendId?: unknown,
    ) =>
      scope.run(async () => {
        checkRequest(domains, context, false, true);
        const call = ctx.localCall;
        if (ctx.readOnly || !call || backendId !== undefined)
          return unsupported("This marketplace is unavailable for removal.");
        const name = idSchema.parse(raw);
        await scope.guard(() => call("removeNativePluginMarketplace", name));
      }),
    refreshMarketplace: (
      raw: unknown,
      domains: unknown,
      context?: unknown,
      backendId?: unknown,
    ) =>
      scope.run(async () => {
        checkRequest(domains, context, false, true);
        const call = ctx.localCall;
        if (ctx.readOnly || !call || backendId !== undefined)
          return unsupported("This marketplace is unavailable for refresh.");
        const name = idSchema.parse(raw);
        await scope.guard(() => call("refreshNativePluginMarketplace", name));
        return {};
      }),
    addMarketplace: (input: unknown, domains: unknown, context?: unknown) =>
      scope.run(async () => {
        const allowed = checkRequest(domains, context, false, true);
        const source = marketplaceSource(input);
        const url = new URL(
          source.startsWith("https://")
            ? source
            : `https://github.com/${source}`,
        );
        if (
          url.search ||
          url.hash ||
          (allowed.length &&
            !allowed.some((domain) => {
              const rule = domain.toLowerCase();
              return (
                rule === "*" ||
                rule === url.hostname ||
                (rule.startsWith("*.") && url.hostname.endsWith(rule.slice(1)))
              );
            }))
        )
          throw refusal(
            "plugin_context_unavailable",
            "MARKETPLACE_ERROR:POLICY_BLOCKED Repository access is unavailable.",
          );
        const call = ctx.localCall;
        if (ctx.readOnly || !call)
          return unsupported(
            "Repository marketplaces are unavailable on this host.",
          );
        const { name, alreadyAdded } = z
          .object({
            name: z.string().min(1).max(200),
            alreadyAdded: z.boolean(),
          })
          .parse(
            await scope.guard(() => call("addNativePluginMarketplace", source)),
          );
        const { metadata } = await readCatalog();
        const row = metadata.marketplaces.find((item) => item.name === name);
        if (!row) throw catalogFailure();
        if (!row.userAdded && alreadyAdded)
          throw refusal(
            "plugin_context_unavailable",
            "This marketplace is already on this computer.",
          );
        return {
          name,
          displayName: row.title,
          sourceType: url.hostname === "github.com" ? "github" : "git",
          url: url.href,
          source: "local",
          lastRefreshedAt: row.lastUpdated,
          alreadyConnected: alreadyAdded,
        };
      }),
    listMarketplaces: (domains: unknown, context?: unknown) =>
      scope.run(async () => {
        const management = managementContextSchema.safeParse(context);
        if (management.success) {
          const { mode, telemetryAttempt } = management.data;
          checkRequest(domains, { mode, telemetryAttempt });
          if (ctx.readOnly || !ctx.localCall)
            return unsupported(
              "Repository marketplace management requires a local desktop.",
            );
          const catalog = await readCatalog(true);
          const repositories = catalog.metadata.marketplaces.filter(
            (marketplace) => marketplace.userAdded,
          );
          if (!repositories.length) return [];
          const installed = new Map<string, z.infer<typeof pluginSchema>[]>();
          for (const plugin of catalogPlugins(catalog)) {
            if (!plugin.installed) continue;
            const plugins = installed.get(plugin.marketplace) ?? [];
            plugins.push(plugin);
            installed.set(plugin.marketplace, plugins);
          }
          return bounded(repositories.map((marketplace) => ({
            name: marketplace.name,
            displayName: marketplace.title,
            sourceType: "unknown" as const,
            lastRefreshedAt: marketplace.lastUpdated,
            installedPlugins: (installed.get(marketplace.name) ?? []).map(
              (plugin) => ({
                id: plugin.id,
                name: plugin.name,
                displayName: plugin.title,
                marketplaceName: marketplace.name,
                isInstalled: true,
              }),
            ),
          })));
        }
        checkRequest(domains, context);
        const { metadata } = await readCatalog();
        return bounded(
          metadata.marketplaces.map((m) => ({
            name: m.name,
            ...(m.title ? { displayName: m.title } : {}),
            sourceType: m.source === "manual" ? "manual" : "unknown",
            ...(m.lastUpdated === undefined
              ? {}
              : { lastRefreshedAt: m.lastUpdated }),
          })),
        );
      }),
    listAvailablePlugins: (domains: unknown, context?: unknown) =>
      scope.run(async () => {
        checkRequest(domains, context);
        return bounded(
          (await readPlugins())
            .filter((entry) => entry.installable || entry.installed)
            .map((entry) => ({
              id: entry.id,
              name: entry.name,
              displayName: entry.title,
              description: entry.description,
              marketplaceName: entry.marketplace,
              isInstalled: entry.installed,
              source: "local" as const,
              category: entry.category,
              version: entry.installedVersion,
              availableVersion: entry.availableVersion,
              author: entry.developer ? { name: entry.developer } : undefined,
            })),
        );
      }),
    installPlugin: (rawId: unknown, domains: unknown, context?: unknown) =>
      scope.run(async () => {
        checkRequest(domains, context, true);
        const pluginId = idSchema.parse(rawId);
        const entry = (await readPlugins()).find(
          (item) => item.id === pluginId,
        );
        const call = ctx.localCall;
        if (!entry?.installable || ctx.readOnly || !call)
          return {
            success: false,
            pluginId,
            error: "This plugin is unavailable for installation.",
          };
        if (!entry.installed)
          await scope.guard(() => call("installPlugin", pluginId));
        return { success: true, pluginId };
      }),
    uninstallPlugin: (rawId: unknown, domains: unknown, context?: unknown) =>
      scope.run(async () => {
        checkRequest(domains, context, true);
        const pluginId = idSchema.parse(rawId);
        const entry = (await readPlugins()).find(
          (item) =>
            item.id === pluginId ||
            runtimePluginLibraryId(item.id) === pluginId,
        );
        const call = ctx.localCall;
        if (!entry || ctx.readOnly || !call)
          return unsupported("This plugin is unavailable for removal.");
        if (entry.installed)
          await scope.guard(() => call("uninstallPlugin", entry.id));
      }),
    setPluginEnabled: (
      rawId: unknown,
      rawEnabled: unknown,
      context?: unknown,
    ) =>
      scope.run(async () => {
        checkRequest([], context, true);
        const id = idSchema.parse(rawId);
        const enabled = z.boolean().parse(rawEnabled);
        const entry = (await readPlugins()).find(
          (item) => item.id === id || runtimePluginLibraryId(item.id) === id,
        );
        const call = ctx.localCall;
        if (
          !entry?.installed ||
          ctx.readOnly ||
          !call ||
          (enabled && !entry.installable)
        )
          return {
            success: false,
            error: "This plugin is unavailable for configuration.",
          };
        const result = await scope.guard(() =>
          call("setNativePluginEnabled", entry.id, enabled),
        );
        if (result !== enabled) throw catalogFailure();
        return { success: true, enabled };
      }),
    getPlugins: () => {
      try {
        ctx.log("[skill-search] LocalPlugins.getPlugins", {
          outcome: "unsupported",
        });
      } catch {
        /* Keep the original refusal even if diagnostics fail. */
      }
      throw refusal(
        "plugin_inventory_unavailable",
        "Native installed-plugin details require verified installation paths, scope and component inventories, which this host does not expose.",
      );
    },
    getDownloadedRemotePlugins: () => {
      try {
        ctx.log("[skill-search] LocalPlugins.getDownloadedRemotePlugins", {
          outcome: "unsupported",
        });
      } catch {
        /* Keep the original refusal even if diagnostics fail. */
      }
      throw refusal(
        "remote_plugin_inventory_unavailable",
        "This host does not expose verified downloaded-remote plugin installation provenance.",
      );
    },
  };
}

/** Pass the host's NativeRefusal constructor through a factory, keeping reads testable without Electron. */
export function registerNativePluginReads(
  host: NativeHost,
  refusal: (code: string, message: string) => Error,
) {
  const reads = createNativePluginReads(host.ctx, refusal);
  host.on("CustomPlugins.listMarketplaces", reads.listMarketplaces);
  host.on("CustomPlugins.addMarketplace", reads.addMarketplace);
  host.on("CustomPlugins.removeMarketplace", reads.removeMarketplace);
  host.on("CustomPlugins.refreshMarketplace", reads.refreshMarketplace);
  host.on("CustomPlugins.listAvailablePlugins", reads.listAvailablePlugins);
  host.on("CustomPlugins.installPlugin", reads.installPlugin);
  host.on("CustomPlugins.uninstallPlugin", reads.uninstallPlugin);
  host.on("LocalPlugins.setPluginEnabled", reads.setPluginEnabled);
  host.on("LocalPlugins.getPlugins", reads.getPlugins);
  host.on(
    "LocalPlugins.getDownloadedRemotePlugins",
    reads.getDownloadedRemotePlugins,
  );
}
