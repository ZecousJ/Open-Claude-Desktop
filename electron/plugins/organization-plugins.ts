import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Sub2ApiError } from "../sub2api/http";
import path from "node:path";
import { assertAccountOperationCurrent } from "../account/operation-lease";
import { extractPluginArchive } from "./plugin-upload";
import { pluginCatalog, pluginDetails } from "./plugin-catalog";
import type { OrganizationPluginGrant, OrganizationPluginPackages } from "./organization-plugin-package";
import type { PluginRpc } from "./plugins";
import type { OrganizationRuntimeCandidates, OrganizationRuntimeStates } from "../../shared/official-organization-catalog";

interface Activation {
  root: string;
  packages: Pick<OrganizationPluginPackages, "authorize" | "archive" | "catalog">;
  rpc(): Promise<PluginRpc>;
  current(): boolean;
  sandboxReadable?: boolean;
}

const runtimeMarketplace = (grant: Pick<OrganizationPluginGrant, "marketplace_id" | "id">) => "org-" + grant.marketplace_id + "-" + grant.id.slice(7);
const marketplacePath = (root: string) => path.join(root, ".agents", "plugins", "marketplace.json");

function writeEnabled(rpc: PluginRpc, id: string, enabled: boolean) {
  return rpc.call("config/batchWrite", {
    edits: [{ keyPath: "plugins", value: { [id]: { enabled } }, mergeStrategy: "upsert" }],
    reloadUserConfig: true,
  });
}

async function readManagedPlugin(rpc: PluginRpc, id: string, snapshot: string, current: () => void) {
  const file = fs.realpathSync(marketplacePath(snapshot));
  const result = await rpc.call("plugin/list", { cwds: [snapshot] });
  current();
  const matches = pluginCatalog(result).plugins.filter((row) =>
    row.id === id && fs.realpathSync(row.marketplacePath) === file);
  if (matches.length !== 1) throw Error("The organization plugin could not be read from Codex.");
  return matches[0];
}

function privateDirectory(parent: string, name: string) {
  const folder = path.join(parent, name);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(folder).isDirectory()) throw Error("The managed plugin directory is unavailable.");
  return folder;
}

function snapshotIdentity(snapshot: string, id: string) {
  const manifest = z.object({ name: z.string(), plugins: z.tuple([z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
    source: z.object({ source: z.literal("local"), path: z.string() }),
  })]) }).parse(JSON.parse(fs.readFileSync(marketplacePath(snapshot), "utf8")));
  const plugin = manifest.plugins[0];
  const match = /^org-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-([a-f0-9]{24})$/.exec(manifest.name);
  if (!match || match[2] !== id.slice(7) || plugin.source.path !== "./plugins/" + plugin.name ||
    "plugin_" + createHash("sha256").update("organization-plugin:" + match[1] + "/" + plugin.name).digest("hex").slice(0, 24) !== id)
    throw Error("The organization plugin snapshot identity is invalid.");
  return { name: plugin.name, runtimeId: plugin.name + "@" + manifest.name };
}

function makeSnapshotReadable(folder: string) {
  fs.chmodSync(folder, 0o755);
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) makeSnapshotReadable(file);
    else if (entry.isFile()) fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o755 : 0o644);
    else throw Error("The managed plugin snapshot contains an invalid entry.");
  }
}

function prepareSandboxSnapshot(activation: Pick<Activation, "root" | "sandboxReadable">, id: string, snapshot: string) {
  if (!activation.sandboxReadable) return;
  snapshotIdentity(snapshot, id);
  const managed = path.join(activation.root, "organization-plugins");
  fs.chmodSync(managed, 0o755);
  fs.chmodSync(path.join(managed, id), 0o755);
  makeSnapshotReadable(snapshot);
}

function organizationPluginRecord(grant: OrganizationPluginGrant, installed: boolean, enabled: boolean) {
  return {
    id: grant.id,
    name: grant.name,
    display_name: grant.display_name,
    description: grant.description,
    partition_by: "organization",
    marketplace_id: grant.marketplace_id,
    marketplace_name: runtimeMarketplace(grant),
    marketplace_kind: "org_marketplace",
    version: grant.version || null,
    enabled,
    installed,
    can_toggle: installed && grant.installation_preference !== "required",
    can_remove: installed && grant.installation_preference === "available",
    claudex_organization_plugin: true,
  };
}

export class OrganizationPlugins {
  private operations = new Set<string>();
  private reconciliations = new Map<string, Promise<void>>();

  async syncForConversation(account: Activation, conversation: Activation): Promise<boolean> {
    const current = () => {
      assertAccountOperationCurrent(account.current);
      assertAccountOperationCurrent(conversation.current);
    };
    current();
    if (fs.realpathSync(account.root) === fs.realpathSync(conversation.root))
      throw Error("The conversation plugin root must be separate from the account root.");
    const key = conversation.root + "/organization-plugin-sync";
    if (this.operations.has(key)) throw Error("The conversation plugins are already being synchronized.");
    this.operations.add(key);
    try {
      await this.reconcile(account);
      current();
      const catalog = await account.packages.catalog();
      current();
      const states = await this.states(catalog, account);
      current();
      const desired = new Map<string, { digest: string; snapshot: string; runtimeId: string; name: string }>();
      for (const row of catalog) {
        if (!states[row.id]?.enabled || row.package_available === false) continue;
        const grant = await account.packages.authorize(row.id);
        current();
        if (grant.name !== row.name || grant.marketplace_id !== row.marketplace_id)
          throw Error("Organization plugin authorization changed.");
        const owner = path.join(account.root, "organization-plugins", row.id);
        const digest = fs.readFileSync(path.join(owner, "installed-digest"), "utf8");
        if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("The organization plugin receipt is invalid.");
        if (digest !== grant.sha256) throw Error("The installed organization plugin version is no longer approved.");
        const snapshot = path.join(owner, digest);
        const identity = snapshotIdentity(snapshot, row.id);
        if (identity.runtimeId !== grant.name + "@" + runtimeMarketplace(grant))
          throw Error("Organization plugin authorization changed.");
        desired.set(row.id, { digest, snapshot, ...identity });
      }

      const managed = privateDirectory(fs.realpathSync(conversation.root), "organization-plugins");
      if (conversation.sandboxReadable) fs.chmodSync(managed, 0o755);
      const dirty = path.join(managed, ".sync-dirty");
      let changed = fs.existsSync(dirty);
      const markChanged = () => {
        if (!changed) fs.writeFileSync(dirty, "", { mode: 0o600 });
        changed = true;
      };
      let rpc: PluginRpc | undefined;
      const runtime = async () => {
        if (!rpc) { rpc = await conversation.rpc(); current(); }
        return rpc;
      };
      for (const entry of fs.readdirSync(managed, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^plugin_[a-f0-9]{24}$/.test(entry.name)) continue;
        const owner = path.join(managed, entry.name);
        const wanted = desired.get(entry.name);
        for (const item of fs.readdirSync(owner, { withFileTypes: true })) {
          if (item.name.startsWith(".pending-")) {
            markChanged();
            fs.rmSync(path.join(owner, item.name), { recursive: true, force: true });
            continue;
          }
          if (!item.isDirectory() || !/^[a-f0-9]{64}$/.test(item.name) || item.name === wanted?.digest) continue;
          const snapshot = path.join(owner, item.name);
          const identity = snapshotIdentity(snapshot, entry.name);
          const peer = await runtime();
          const installed = await readManagedPlugin(peer, identity.runtimeId, snapshot, current);
          if (installed.installed) {
            markChanged();
            await peer.call("plugin/uninstall", { pluginId: identity.runtimeId });
            current();
            if ((await readManagedPlugin(peer, identity.runtimeId, snapshot, current)).installed)
              throw Error("The conversation plugin removal could not be confirmed.");
          }
          markChanged();
          fs.rmSync(snapshot, { recursive: true, force: true });
        }
        if (!wanted) {
          markChanged();
          fs.rmSync(owner, { recursive: true, force: true });
        }
      }
      for (const [id, wanted] of desired) {
        current();
        const owner = privateDirectory(managed, id);
        if (conversation.sandboxReadable) fs.chmodSync(owner, 0o755);
        const snapshot = path.join(owner, wanted.digest);
        if (!fs.existsSync(snapshot)) {
          markChanged();
          const stage = fs.mkdtempSync(path.join(owner, ".pending-"));
          try {
            fs.cpSync(wanted.snapshot, stage, { recursive: true, errorOnExist: false });
            snapshotIdentity(stage, id);
            current();
            fs.renameSync(stage, snapshot);
          } finally { fs.rmSync(stage, { recursive: true, force: true }); }
        }
        if (snapshotIdentity(snapshot, id).runtimeId !== wanted.runtimeId)
          throw Error("The conversation plugin snapshot identity is invalid.");
        if (conversation.sandboxReadable) makeSnapshotReadable(snapshot);
        const peer = await runtime();
        let installed = await readManagedPlugin(peer, wanted.runtimeId, snapshot, current);
        if (!installed.installed) {
          markChanged();
          await peer.call("plugin/install", { pluginName: wanted.name, marketplacePath: marketplacePath(snapshot) });
          current();
          installed = await readManagedPlugin(peer, wanted.runtimeId, snapshot, current);
        }
        if (!installed.installed) throw Error("The conversation plugin installation could not be confirmed.");
        if (!installed.enabled) {
          markChanged();
          await writeEnabled(peer, wanted.runtimeId, true);
          current();
        }
        const verified = await readManagedPlugin(peer, wanted.runtimeId, snapshot, current);
        if (!verified.installed || !verified.enabled) throw Error("The conversation plugin setting could not be confirmed.");
        const fresh = await account.packages.authorize(id);
        current();
        if (fresh.sha256 !== wanted.digest || fresh.name !== wanted.name || fresh.name + "@" + runtimeMarketplace(fresh) !== wanted.runtimeId)
          throw Error("Organization plugin authorization changed.");
        const receipt = path.join(owner, "installed-digest");
        if (!fs.existsSync(receipt) || fs.readFileSync(receipt, "utf8") !== wanted.digest) {
          fs.writeFileSync(receipt + ".tmp", wanted.digest, { mode: 0o600 });
          fs.renameSync(receipt + ".tmp", receipt);
        }
      }
      const latestCatalog = await account.packages.catalog();
      current();
      const latestStates = await this.states(latestCatalog, account);
      current();
      const latestEnabled = latestCatalog.filter((row) => latestStates[row.id]?.enabled && row.package_available !== false);
      if (latestEnabled.length !== desired.size || latestEnabled.some((row) => {
        const wanted = desired.get(row.id);
        if (!wanted || wanted.runtimeId !== row.name + "@" + runtimeMarketplace(row)) return true;
        const receipt = path.join(account.root, "organization-plugins", row.id, "installed-digest");
        return !fs.existsSync(receipt) || fs.readFileSync(receipt, "utf8") !== wanted.digest;
      })) throw Error("Organization plugin settings changed during synchronization.");
      fs.rmSync(dirty, { force: true });
      return changed;
    } finally { this.operations.delete(key); }
  }

  async reconcile(activation: Activation): Promise<void> {
    const previous = this.reconciliations.get(activation.root);
    const work = (async () => {
      if (previous) await previous.catch(() => {});
      assertAccountOperationCurrent(activation.current);
      await this.reconcileAccount(activation);
    })();
    this.reconciliations.set(activation.root, work);
    try { await work; }
    finally {
      if (this.reconciliations.get(activation.root) === work) this.reconciliations.delete(activation.root);
    }
  }

  private async reconcileAccount(activation: Activation): Promise<void> {
    const current = () => assertAccountOperationCurrent(activation.current);
    const catalog = await activation.packages.catalog();
    current();
    const byId = new Map(catalog.map((row) => [row.id, row]));
    for (const row of catalog) {
      if (row.installation_preference !== "available" && row.package_available === true) {
        await this.applyEnabled(row.id, true, activation, row.installation_preference);
      }
    }
    const managed = path.join(activation.root, "organization-plugins");
    if (!fs.existsSync(managed)) return;
    for (const entry of fs.readdirSync(managed, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^plugin_[a-f0-9]{24}$/.test(entry.name)) continue;
      const row = byId.get(entry.name);
      if (row && row.package_available !== false) continue;
      const key = activation.root + "/" + entry.name;
      if (this.operations.has(key)) throw Error("This organization plugin is already being changed.");
      this.operations.add(key);
      try {
        const owner = path.join(managed, entry.name);
        const receipt = path.join(owner, "installed-digest");
        const receiptFile = fs.lstatSync(receipt, { throwIfNoEntry: false });
        if (!receiptFile) continue;
        if (!receiptFile.isFile()) throw Error("The organization plugin receipt is invalid.");
        const digest = fs.readFileSync(receipt, "utf8");
        if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("The organization plugin receipt is invalid.");
        const snapshot = path.join(owner, digest);
        prepareSandboxSnapshot(activation, entry.name, snapshot);
        const manifest = z.object({ name: z.string(), plugins: z.tuple([z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
          source: z.object({ source: z.literal("local"), path: z.string() }),
        })]) }).parse(JSON.parse(fs.readFileSync(marketplacePath(snapshot), "utf8")));
        const plugin = manifest.plugins[0];
        const match = /^org-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-([a-f0-9]{24})$/.exec(manifest.name);
        if (!match || match[2] !== entry.name.slice(7) || plugin.source.path !== "./plugins/" + plugin.name ||
          "plugin_" + createHash("sha256").update("organization-plugin:" + match[1] + "/" + plugin.name).digest("hex").slice(0, 24) !== entry.name)
          throw Error("The organization plugin snapshot identity is invalid.");
        const runtimeID = plugin.name + "@" + manifest.name;
        const rpc = await activation.rpc();
        current();
        const installed = await readManagedPlugin(rpc, runtimeID, snapshot, current);
        try {
          await activation.packages.authorize(entry.name);
          current();
          continue;
        } catch (error) {
          current();
          if (!(error instanceof Sub2ApiError && error.status === 404 && error.code === "CLAUDEX_PLUGIN_ORGANIZATION_NOT_FOUND")) throw error;
        }
        if (installed.installed) {
          await rpc.call("plugin/uninstall", { pluginId: runtimeID });
          current();
          if ((await readManagedPlugin(rpc, runtimeID, snapshot, current)).installed)
            throw Error("The organization plugin removal could not be confirmed.");
        }
        fs.rmSync(receipt, { force: true });
      } finally {
        this.operations.delete(key);
      }
    }
  }

  async details(id: string, activation: Activation) {
    const current = () => assertAccountOperationCurrent(activation.current);
    const grant = await activation.packages.authorize(id);
    current();
    const managed = privateDirectory(fs.realpathSync(activation.root), "organization-plugins");
    const owner = privateDirectory(managed, grant.id);
    const snapshot = path.join(owner, grant.sha256);
    const marketplace = runtimeMarketplace(grant);
    if (!fs.existsSync(snapshot))
      await this.prepareSnapshot(owner, snapshot, marketplace, grant, activation, current);
    if (!fs.lstatSync(snapshot).isDirectory()) throw Error("The managed plugin snapshot is unavailable.");
    prepareSandboxSnapshot(activation, grant.id, snapshot);
    const rpc = await activation.rpc();
    current();
    const details = pluginDetails(await rpc.call("plugin/read", {
      pluginName: grant.name, marketplacePath: marketplacePath(snapshot),
    }));
    current();
    const states = await this.states([grant], activation);
    const fresh = await activation.packages.authorize(id);
    current();
    if (fresh.sha256 !== grant.sha256) throw Error("The approved version changed.");
    const state = states[id];
    return { record: organizationPluginRecord(fresh, state !== undefined, state?.enabled === true), details };
  }

  async states(candidates: OrganizationRuntimeCandidates, activation: Pick<Activation, "root" | "rpc" | "current" | "sandboxReadable">) {
    const current = () => assertAccountOperationCurrent(activation.current);
    current();
    const snapshots = candidates.flatMap((candidate) => {
      const owner = path.join(activation.root, "organization-plugins", candidate.id);
      const receipt = path.join(owner, "installed-digest");
      if (!fs.lstatSync(receipt, { throwIfNoEntry: false })?.isFile()) return [];
      const digest = fs.readFileSync(receipt, "utf8");
      if (!/^[a-f0-9]{64}$/.test(digest)) return [];
      const cwd = path.join(owner, digest);
      const file = marketplacePath(cwd);
      if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return [];
      prepareSandboxSnapshot(activation, candidate.id, cwd);
      return [{
        id: candidate.id,
        runtimeId: candidate.name + "@" + runtimeMarketplace(candidate),
        cwd,
        file: fs.realpathSync(file),
      }];
    });
    const states: OrganizationRuntimeStates = {};
    if (!snapshots.length) return states;
    const runtime = await activation.rpc();
    current();
    const result = await runtime.call("plugin/list", { cwds: snapshots.map((row) => row.cwd) });
    current();
    const plugins = pluginCatalog(result).plugins;
    for (const snapshot of snapshots) {
      const row = plugins.find((entry) => entry.id === snapshot.runtimeId && entry.installed &&
        fs.realpathSync(entry.marketplacePath) === snapshot.file);
      if (row) states[snapshot.id] = { enabled: row.enabled };
    }
    return states;
  }

  async setEnabled(id: string, enabled: boolean, activation: Activation) {
    return this.applyEnabled(id, enabled, activation, "member");
  }

  private async applyEnabled(id: string, enabled: boolean, activation: Activation, policy: "member" | "required" | "auto_install") {
    const current = () => assertAccountOperationCurrent(activation.current);
    current();
    const key = activation.root + "/" + id;
    if (this.operations.has(key)) throw Error("This organization plugin is already being changed.");
    this.operations.add(key);
    let startedInstallation = false;
    let enabledExisting = false;
    let rpc: PluginRpc | undefined;
    let runtimeID: string | undefined;
    try {
      const grant = await activation.packages.authorize(id);
      current();
      if (policy === "member" ? grant.installation_preference === "required" : grant.installation_preference !== policy)
        throw Error("This organization plugin is managed by its installation policy.");
      const managed = privateDirectory(fs.realpathSync(activation.root), "organization-plugins");
      const owner = privateDirectory(managed, grant.id);
      const snapshot = path.join(owner, grant.sha256);
      const marketplace = runtimeMarketplace(grant);
      runtimeID = grant.name + "@" + marketplace;
      if (!fs.existsSync(snapshot)) {
        if (!enabled) throw Error("This organization plugin is not installed.");
        await this.prepareSnapshot(owner, snapshot, marketplace, grant, activation, current);
      }
      if (!fs.lstatSync(snapshot).isDirectory())
        throw Error("The managed plugin snapshot is unavailable.");
      prepareSandboxSnapshot(activation, grant.id, snapshot);
      const reauthorize = async () => {
        const fresh = await activation.packages.authorize(id);
        current();
        if (fresh.sha256 !== grant.sha256 || fresh.installation_preference !== grant.installation_preference)
          throw Error("Organization plugin authorization changed.");
      };
      rpc = await activation.rpc();
      current();
      const readRuntime = () => readManagedPlugin(rpc!, runtimeID!, snapshot, current);
      const before = await readRuntime();
      if (!before.installed && !enabled) throw Error("This organization plugin is not installed.");
      await reauthorize();
      const receipt = path.join(owner, "installed-digest");
      const previousDigest = fs.existsSync(receipt) ? fs.readFileSync(receipt, "utf8") : undefined;
      const desired = policy === "auto_install" && before.installed ? before.enabled : enabled;
      if (policy !== "member" && before.installed && before.enabled === desired && previousDigest === grant.sha256)
        return organizationPluginRecord(grant, true, desired);
      if (enabled && (!before.installed || previousDigest !== grant.sha256)) {
        startedInstallation = true;
        await rpc.call("plugin/install", { pluginName: grant.name, marketplacePath: marketplacePath(snapshot) });
        current();
      }
      const installed = await readRuntime();
      if (!installed.installed) throw Error("The organization plugin installation could not be confirmed.");
      if (installed.enabled !== desired) {
        enabledExisting = desired;
        await writeEnabled(rpc, runtimeID, desired);
        current();
      }
      const verified = await readRuntime();
      await reauthorize();
      if (!verified.installed || verified.enabled !== desired)
        throw Error("The organization plugin setting could not be confirmed.");
      fs.writeFileSync(receipt + ".tmp", grant.sha256, { mode: 0o600 });
      fs.renameSync(receipt + ".tmp", receipt);
      return organizationPluginRecord(grant, true, desired);
    } catch (error) {
      if (rpc && runtimeID && activation.current()) {
        if (startedInstallation) await rpc.call("plugin/uninstall", { pluginId: runtimeID }).catch(() => {});
        else if (enabledExisting) await writeEnabled(rpc, runtimeID, false).catch(() => {});
      }
      throw error;
    } finally {
      this.operations.delete(key);
    }
  }

  async remove(id: string, activation: Activation) {
    const current = () => assertAccountOperationCurrent(activation.current);
    current();
    const key = activation.root + "/" + id;
    if (this.operations.has(key)) throw Error("This organization plugin is already being changed.");
    this.operations.add(key);
    try {
      const grant = await activation.packages.authorize(id);
      current();
      if (grant.installation_preference !== "available")
        throw Error("This organization plugin is managed by its installation policy.");
      const owner = path.join(activation.root, "organization-plugins", grant.id);
      const receipt = path.join(owner, "installed-digest");
      const entry = fs.lstatSync(receipt, { throwIfNoEntry: false });
      if (!entry) return organizationPluginRecord(grant, false, false);
      if (!entry.isFile()) throw Error("The organization plugin receipt is invalid.");
      const digest = fs.readFileSync(receipt, "utf8");
      if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("The organization plugin receipt is invalid.");
      const snapshot = path.join(owner, digest);
      prepareSandboxSnapshot(activation, grant.id, snapshot);
      const runtimeID = grant.name + "@" + runtimeMarketplace(grant);
      const rpc = await activation.rpc();
      current();
      const installed = await readManagedPlugin(rpc, runtimeID, snapshot, current);
      if (installed.installed) {
        const fresh = await activation.packages.authorize(id);
        current();
        if (fresh.installation_preference !== "available")
          throw Error("Organization plugin authorization changed.");
        await rpc.call("plugin/uninstall", { pluginId: runtimeID });
        current();
        if ((await readManagedPlugin(rpc, runtimeID, snapshot, current)).installed)
          throw Error("The organization plugin removal could not be confirmed.");
      }
      fs.rmSync(receipt, { force: true });
      return organizationPluginRecord(grant, false, false);
    } finally {
      this.operations.delete(key);
    }
  }

  private async prepareSnapshot(
    owner: string,
    snapshot: string,
    marketplace: string,
    grant: OrganizationPluginGrant,
    activation: Activation,
    current: () => void,
  ) {
    const archive = await activation.packages.archive(grant);
    current();
    const stage = fs.mkdtempSync(path.join(owner, ".pending-"));
    try {
      const plugin = path.join(stage, "plugins", grant.name);
      const manifest = await extractPluginArchive(archive, plugin);
      current();
      const normalized = JSON.parse(fs.readFileSync(path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
      if (manifest.name !== grant.name || (normalized.version ?? "") !== grant.version)
        throw Error("The plugin manifest does not match its approved name and version.");
      const file = marketplacePath(stage);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({
        name: marketplace,
        plugins: [{
          name: grant.name,
          source: { source: "local", path: "./plugins/" + grant.name },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        }],
      }), { mode: 0o600 });
      try {
        fs.renameSync(stage, snapshot);
      } catch (error) {
        if (!fs.lstatSync(snapshot, { throwIfNoEntry: false })?.isDirectory()) throw error;
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}
