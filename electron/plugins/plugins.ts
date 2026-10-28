import fs from "node:fs";
import path from "node:path";
import type {
  PluginCatalog,
  PluginDetails,
  PluginEntry,
  PluginInstallResult,
} from "../../shared/collections-api";
import { personalMarketplace } from "./plugin-copy";
import { MarketplaceState } from "./marketplace-state";
import {
  pluginCatalog,
  pluginDetails,
  marketplaceSource,
} from "./plugin-catalog";
import { text } from "./plugins-support";
import { splitPluginId } from "./plugins-support";
import * as pluginCopies from "./plugin-copies";
import { installMethods } from "./install-methods";

/** The agent runtime's calls the plugin pages use (CodexRPC's shape). */
export interface PluginRpc {
  call(method: string, params?: unknown): Promise<any>;
}

/** Marketplaces Claudex offers by name; the rest the person adds themselves. */
export const officialMarketplace = {
  name: "claude-plugins-official",
  source: "anthropics/claude-plugins-official",
};

/**
 * The version Codex installed (CODEX_HOME/plugins/cache/<marketplace>/<name>/
 * <version>): `plugin/list` reports the marketplace's manifest instead, and
 * installing again brings the installed copy up to it.
 */
export function installedPluginVersion(
  codexHome: string,
  plugin: Pick<PluginEntry, "name" | "marketplace">,
): string | undefined {
  try {
    const folder = path.join(
      codexHome,
      "plugins",
      "cache",
      plugin.marketplace,
      plugin.name,
    );
    const versions = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
    return versions.length === 1 ? versions[0].slice(0, 100) : undefined;
  } catch {
    return undefined;
  }
}

/** The plugin pages' calls to the agent runtime. */
export class PluginService {
  /**
   * `home`: the home folder the runtime's personal marketplace sits in, when
   * it is this person's own (desktop home or account-private runner folder);
   * its plugins are listed as `personal`.
   */
  constructor(
    public rpc: () => Promise<PluginRpc>,
    private home: () => string | undefined = () => undefined,
    private syncState?: MarketplaceState,
    private networkAllowed: () => boolean = () => true,
    /** CODEX_HOME on this computer: installed versions live in its cache. */
    private codexHome: () => string | undefined = () => undefined,
  ) {}

  async list(): Promise<PluginCatalog> {
    const home = this.home();
    const catalog = pluginCatalog(
      await (
        await this.rpc()
      ).call("plugin/list", home ? { cwds: [home] } : {}),
      home === undefined ? undefined : personalMarketplace(home).file,
    );
    if (this.syncState)
      catalog.marketplaces = await Promise.all(
        catalog.marketplaces.map((marketplace) =>
          this.syncState!.describe(marketplace),
        ),
      );
    if (!this.networkAllowed())
      catalog.loadErrors.push("Network access required");
    const codexHome = this.codexHome();
    if (codexHome)
      for (const plugin of catalog.plugins)
        if (plugin.installed) {
          const version = installedPluginVersion(codexHome, plugin);
          if (version) plugin.installedVersion = version;
        }
    return catalog;
  }

  private async find(id: string) {
    const { name, marketplace } = splitPluginId(id);
    const catalog = await this.list();
    const plugin = catalog.plugins.find(
      (item) => item.name === name && item.marketplace === marketplace,
    );
    if (!plugin)
      throw new Error("That plugin isn't in a marketplace any more.");
    return plugin;
  }

  async read(id: string): Promise<PluginDetails> {
    const plugin = await this.find(id);
    return pluginDetails(
      await (
        await this.rpc()
      ).call("plugin/read", {
        pluginName: plugin.name,
        marketplacePath: plugin.marketplacePath,
      }),
    );
  }

  async install(id: string): Promise<PluginInstallResult> {
    const plugin = await this.find(id);
    if (!plugin.installable) throw new Error("This plugin can't be installed.");
    const response = await (
      await this.rpc()
    ).call("plugin/install", {
      pluginName: plugin.name,
      marketplacePath: plugin.marketplacePath,
    });
    return {
      appsNeedingAuth: (response?.appsNeedingAuth ?? [])
        .map((app: any) => text(app?.name, 200))
        .filter((name: string | undefined): name is string => !!name),
    };
  }

  async uninstall(id: string) {
    splitPluginId(id);
    await (await this.rpc()).call("plugin/uninstall", { pluginId: id });
  }

  async addMarketplace(source: unknown) {
    if (!this.networkAllowed()) throw new Error("Network access required");
    const repository = marketplaceSource(source);
    const result = await (
      await this.rpc()
    ).call("marketplace/add", {
      source: repository,
    });
    if (result?.marketplaceName)
      this.syncState?.update(result.marketplaceName, {
        source: repository.startsWith("https://")
          ? repository
          : `https://github.com/${repository}`,
        lastUpdated: Date.now(),
      });
  }

  async removeMarketplace(name: string) {
    if (!name.trim() || name.length > 200)
      throw new Error("That marketplace name is not valid.");
    const catalog = await this.list();
    for (const plugin of catalog.plugins.filter(
      (entry) => entry.marketplace === name && entry.installed,
    ))
      await this.uninstall(plugin.id);
    await (
      await this.rpc()
    ).call("marketplace/remove", { marketplaceName: name });
    this.syncState?.update(name);
  }

  async upgradeMarketplaces(name?: string) {
    const names = this.syncState
      ? (await this.list()).marketplaces
          .filter((entry) => !name || entry.name === name)
          .map((entry) => entry.name)
      : [];
    if (name && this.syncState && !names.length)
      throw new Error("That marketplace name is not valid.");
    let result;
    try {
      if (!this.networkAllowed()) throw new Error("Network access required");
      result = await (
        await this.rpc()
      ).call("marketplace/upgrade", name ? { marketplaceName: name } : {});
    } catch (error) {
      for (const selected of names)
        this.syncState?.update(selected, {
          syncError: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
    const errors: { marketplaceName: string; message: string }[] =
      result?.errors ?? [];
    for (const selected of names) {
      const failure = errors.find(
        (error) => error.marketplaceName === selected,
      );
      this.syncState?.update(
        selected,
        failure
          ? { syncError: failure.message }
          : { lastUpdated: Date.now(), syncError: undefined },
      );
    }
    if (errors.length)
      throw new Error(errors.map((error) => error.message).join("\n"));
  }

  async setAutoSync(name: string, enabled: boolean) {
    const marketplace = (await this.list()).marketplaces.find(
      (entry) => entry.name === name,
    );
    if (
      !this.syncState ||
      !marketplace?.source ||
      new URL(marketplace.source).hostname !== "github.com"
    )
      throw new Error("Failed to update auto-sync setting.");
    this.syncState?.update(name, { autoSync: enabled });
  }

  async syncAutomatically() {
    if (!this.networkAllowed() || !this.syncState?.hasAutoSync()) return;
    const catalog = await this.list();
    for (const marketplace of catalog.marketplaces)
      if (
        marketplace.autoSync &&
        marketplace.source &&
        new URL(marketplace.source).hostname === "github.com"
      )
        try {
          if (await this.syncState.changed(marketplace))
            await this.upgradeMarketplaces(marketplace.name);
          else if (marketplace.syncError)
            this.syncState.update(marketplace.name, { syncError: undefined });
        } catch (error) {
          this.syncState.update(marketplace.name, {
            syncError: error instanceof Error ? error.message : String(error),
          });
        }
  }

  renaming = new Set<string>();
}

export interface PluginService {
  duplicate: OmitThisParameter<typeof pluginCopies.duplicate>;
  rename: OmitThisParameter<typeof pluginCopies.rename>;
  renameNow: OmitThisParameter<typeof pluginCopies.renameNow>;
}
installMethods(PluginService.prototype, pluginCopies);
