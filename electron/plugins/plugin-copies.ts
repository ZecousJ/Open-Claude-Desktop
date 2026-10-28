import type {
  PluginCopy,
  PluginInstallResult,
} from "../../shared/collections-api";
import {
  pluginGone,
  pluginRenameBusy,
  renameSameName,
} from "../../shared/duplicate-name";
import {
  duplicatePluginFiles,
  personalMarketplace,
  renamePluginFiles,
  samePath,
} from "./plugin-copy";
import { text } from "./plugins-support";
import { splitPluginId } from "./plugins-support";
import type { PluginService } from "./plugins";

/**
 * Duplicate plugin: copies a plugin whose listing has a local source into
 * the personal marketplace under `home`, then installs the copy (the live
 * flow installs it right after duplicating). A failed install takes the
 * copy back out.
 */
export async function duplicate(
  this: PluginService,
  id: string,
  copy: PluginCopy,
  home: string,
): Promise<PluginInstallResult & { id: string }> {
  const { name, marketplace } = splitPluginId(id);
  const rpc = await this.rpc();
  const response = await rpc.call("plugin/list", {});
  const raw = (response?.marketplaces ?? [])
    .find((item: any) => item?.name === marketplace)
    ?.plugins?.find((item: any) => item?.name === name);
  if (!raw) throw new Error("That plugin isn't in a marketplace any more.");
  const source = raw.source;
  if (source?.type !== "local" || typeof source.path !== "string")
    throw new Error(
      "This plugin’s files aren’t on this computer, so it can’t be duplicated.",
    );
  const written = duplicatePluginFiles(
    {
      folder: source.path,
      category: text(raw.interface?.category, 100),
      authPolicy: text(raw.authPolicy, 40),
    },
    copy,
    home,
  );
  try {
    // The runtime reads the personal marketplace when it lists plugins.
    const listed = await rpc.call("plugin/list", {});
    const personal = (listed?.marketplaces ?? []).find(
      (item: any) => item?.path === written.marketplacePath,
    );
    const entry = personal?.plugins?.find(
      (item: any) => item?.name === copy.name,
    );
    if (!personal || !entry)
      throw new Error(
        "The agent didn’t pick up the copy from your personal marketplace.",
      );
    const installed = await rpc.call("plugin/install", {
      pluginName: copy.name,
      marketplacePath: written.marketplacePath,
    });
    return {
      id: text(entry.id, 400) ?? `${copy.name}@${personal.name}`,
      appsNeedingAuth: (installed?.appsNeedingAuth ?? [])
        .map((app: any) => text(app?.name, 200))
        .filter((item: string | undefined): item is string => !!item),
    };
  } catch (error) {
    written.undo();
    throw error;
  }
}

/**
 * Rename plugin: for a plugin in the personal marketplace under `home`. Its
 * files take the new name (see `renamePluginFiles`); an installed one is then
 * installed again under its new id (the old id uninstalled first, as live does)
 * and keeps its settings: the runtime's `[plugins."<id>"]` table, its on/off
 * state included, moves to the new id. Anything failing puts the old name,
 * install and settings back. A second rename of the same plugin while one runs
 * is refused with live's "Another change …" wording.
 */
export async function rename(
  this: PluginService,
  id: string,
  to: PluginCopy,
  home: string,
): Promise<PluginInstallResult & { id: string }> {
  if (this.renaming.has(id)) throw new Error(pluginRenameBusy);
  this.renaming.add(id);
  try {
    return await this.renameNow(id, to, home);
  } finally {
    this.renaming.delete(id);
  }
}

export async function renameNow(
  this: PluginService,
  id: string,
  to: PluginCopy,
  home: string,
): Promise<PluginInstallResult & { id: string }> {
  const { name, marketplace } = splitPluginId(id);
  const rpc = await this.rpc();
  const response = await rpc.call("plugin/list", {});
  const market = (response?.marketplaces ?? []).find(
    (item: any) => item?.name === marketplace,
  );
  const raw = market?.plugins?.find((item: any) => item?.name === name);
  if (!raw) throw new Error(pluginGone);
  const marketplacePath = text(market.path, 1000);
  if (
    !marketplacePath ||
    !samePath(marketplacePath, personalMarketplace(home).file) ||
    raw.source?.type !== "local" ||
    typeof raw.source.path !== "string"
  )
    throw new Error("Only your own plugins can be renamed.");
  const title = text(raw.interface?.displayName, 200);
  if (
    to.name === name &&
    (to.displayName === undefined || to.displayName.trim() === title)
  )
    throw new Error(renameSameName);
  // What to carry over: the runtime's own table for the plugin, with the
  // on/off state the listing reports.
  let settings: Record<string, unknown> | undefined;
  if (raw.installed === true) {
    const config = await rpc.call("config/read", {}).catch(() => undefined);
    const table = config?.config?.plugins?.[id];
    const own: Record<string, unknown> =
      table && typeof table === "object" && !Array.isArray(table)
        ? { ...table }
        : {};
    if (typeof raw.enabled === "boolean") own.enabled = raw.enabled;
    settings = own;
  }
  const written = renamePluginFiles(
    { name, folder: raw.source.path },
    to,
    home,
  );
  const newId = `${to.name}@${marketplace}`;
  if (!settings) return { id: newId, appsNeedingAuth: [] };
  const kept = settings;
  const keep = (pluginId: string, value: Record<string, unknown>) =>
    rpc.call("config/batchWrite", {
      edits: [
        {
          keyPath: "plugins",
          value: { [pluginId]: value },
          mergeStrategy: "upsert",
        },
      ],
      reloadUserConfig: true,
    });
  const moving = to.name !== name;
  let uninstalled = false;
  let installed = false;
  try {
    if (moving) {
      await rpc.call("plugin/uninstall", { pluginId: id });
      uninstalled = true;
    }
    const listed = await rpc.call("plugin/list", {});
    const entry = (listed?.marketplaces ?? [])
      .find((item: any) => item?.name === marketplace)
      ?.plugins?.find((item: any) => item?.name === to.name);
    if (!entry)
      throw new Error(
        "The agent didn’t pick up the new name from your personal marketplace.",
      );
    // Installing again (also for a new display name) refreshes the
    // runtime's installed copy of the files.
    const result = await rpc.call("plugin/install", {
      pluginName: to.name,
      marketplacePath,
    });
    installed = true;
    const renamedId = text(entry.id, 400) ?? newId;
    await keep(renamedId, kept);
    return {
      id: renamedId,
      appsNeedingAuth: (result?.appsNeedingAuth ?? [])
        .map((app: any) => text(app?.name, 200))
        .filter((item: string | undefined): item is string => !!item),
    };
  } catch (error) {
    if (moving && installed)
      await rpc
        .call("plugin/uninstall", { pluginId: newId })
        .catch(() => undefined);
    written.undo();
    if (uninstalled || !moving) {
      await rpc
        .call("plugin/install", { pluginName: name, marketplacePath })
        .catch(() => undefined);
      await keep(id, kept).catch(() => undefined);
    }
    throw error;
  }
}
