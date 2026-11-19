/** Catalog fixtures only: no plugin loading, installation, filesystem scanning or runtime execution. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createNativePluginReads,
  registerNativePluginReads,
} from "../electron/official-ui/native/plugin-reads";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { runtimePluginLibraryId } from "../electron/official-ui/api/library-plugins";
function fixture() {
  let owner = "owner",
    identity = {},
    mode = "normal",
    calls = 0;
  const mutations: unknown[][] = [];
  let catalog: any = {
    marketplaces: [
      {
        name: "personal",
        title: "My local plugins",
        source: "manual",
        path: "/private/marketplace.json",
        lastUpdated: 123,
      },
      {
        name: "repo",
        source: "https://example.invalid/secret-repo",
        path: "/private/repo",
      },
    ],
    plugins: [{ id: "not-enough-for-native", installed: true, source: "git" }],
    loadErrors: [],
  };
  const refusal = (code: string, message: string) =>
    Object.assign(Error(message), { name: "NativeRefusal", code });
  const ctx = {
    account: () => (owner ? { id: owner } : undefined),
    sessionIdentity: () => identity,
    localCall: async (method: string, ...args: unknown[]) => {
      mutations.push([method, ...args]);
      if (method === "addNativePluginMarketplace")
        return { name: "repo", alreadyAdded: false };
      if (method === "refreshNativePluginMarketplace") return;
      const plugin = catalog.plugins.find(
        (entry: { id: string }) => entry.id === args[0],
      );
      if (method === "setNativePluginEnabled") {
        plugin.enabled = args[1];
        return plugin.enabled;
      }
      plugin.installed = method === "installPlugin";
    },
    call: async (method: string, ...args: unknown[]) => {
      calls++;
      assert.equal(method, "listPlugins");
      assert.deepEqual(args, []);
      if (mode === "error") throw Error("PRIVATE_PATH_OR_TOKEN");
      if (mode === "switch") owner = "other";
      if (mode === "retire") identity = {};
      return catalog;
    },
  } as unknown as AdapterContext;
  return {
    reads: createNativePluginReads(ctx, refusal),
    ctx,
    refusal,
    mutations,
    get calls() {
      return calls;
    },
    mode(m: string) {
      mode = m;
    },
    catalog(v: any) {
      catalog = v;
    },
    signout() {
      owner = "";
    },
  };
}
test("native account marketplaces use real metadata without paths, source provenance or default/organization claims", async () => {
  const f = fixture();
  const rows = await f.reads.listMarketplaces([], { mode: "ccd" });
  assert.deepEqual(rows, [
    {
      name: "personal",
      displayName: "My local plugins",
      sourceType: "manual",
      lastRefreshedAt: 123,
    },
    { name: "repo", sourceType: "unknown" },
  ]);
  assert.ok(!JSON.stringify(rows).includes("/private"));
  assert.ok(!JSON.stringify(rows).includes("secret-repo"));
  assert.deepEqual(
    await f.reads.listMarketplaces([], { mode: "cowork" }),
    rows,
  );
});
test("workspace/install context or renderer egress overrides are refused before source access", async () => {
  const f = fixture();
  for (const context of [
    { mode: "ccd", workspacePath: "/arbitrary" },
    { mode: "cowork", forceInstall: true },
    { mode: "ccd", settingsLevel: "project" },
    { mode: "ccd", pluginSource: "org-provisioned" },
    { mode: "unknown" },
  ])
    await assert.rejects(
      f.reads.listMarketplaces([], context),
      /account-level/,
    );
  for (const domains of [undefined, {}, ["example.invalid"], ["*"]])
    await assert.rejects(f.reads.listMarketplaces(domains), /Domain-scoped/);
  assert.equal(f.calls, 0);
});
test("native installed and downloaded-remote plugin requests explicitly refuse instead of fabricated empty lists", () => {
  const f = fixture();
  assert.throws(
    f.reads.getPlugins,
    (e: any) => e.code === "plugin_inventory_unavailable",
  );
  assert.throws(
    f.reads.getDownloadedRemotePlugins,
    (e: any) => e.code === "remote_plugin_inventory_unavailable",
  );
  assert.equal(f.calls, 0);
  const handlers = new Map<string, any>();
  registerNativePluginReads(
    {
      ctx: f.ctx,
      on(n: string, h: any) {
        handlers.set(n, h);
        return this;
      },
    } as never,
    f.refusal,
  );
  assert.deepEqual(
    [...handlers.keys()],
    [
      "CustomPlugins.listMarketplaces",
      "CustomPlugins.addMarketplace",
      "CustomPlugins.removeMarketplace",
      "CustomPlugins.refreshMarketplace",
      "CustomPlugins.listAvailablePlugins",
      "CustomPlugins.installPlugin",
      "CustomPlugins.uninstallPlugin",
      "LocalPlugins.setPluginEnabled",
      "LocalPlugins.getPlugins",
      "LocalPlugins.getDownloadedRemotePlugins",
    ],
  );
  assert.throws(
    handlers.get("LocalPlugins.getPlugins"),
    /verified installation/,
  );
});
test("repository management returns only owned repositories and their real installed plugins, even after a sync failure", async () => {
  const f = fixture();
  f.catalog({
    marketplaces: [
      { name: "personal", source: "manual" },
      { name: "repo", title: "Repository", userAdded: true, source: "https://example.invalid/private", syncError: "private failure" },
      { name: "empty", userAdded: true },
    ],
    plugins: [
      { id: "sample@repo", name: "sample", title: "Sample", marketplace: "repo", installed: true, installable: false, source: "git" },
      { id: "other@repo", name: "other", title: "Other", marketplace: "repo", installed: false, installable: true, source: "git" },
    ],
    loadErrors: [],
  });
  const context = { mode: "cowork", scope: "registered-repositories" };
  const rows = await f.reads.listMarketplaces([], context);
  assert.deepEqual(rows.map(row => row.name), ["repo", "empty"]);
  assert.deepEqual(rows[0] && "installedPlugins" in rows[0] && rows[0].installedPlugins, [
    { id: "sample@repo", name: "sample", displayName: "Sample", marketplaceName: "repo", isInstalled: true },
  ]);
  assert.ok(!JSON.stringify(rows).includes("private"));
  await assert.rejects(f.reads.listMarketplaces(["*"], context), /Domain-scoped/);
  await assert.rejects(f.reads.listMarketplaces([], { mode: "cowork" }), /incomplete/);
  f.ctx.readOnly = true;
  await assert.rejects(f.reads.listMarketplaces([], context), /local desktop/);
  f.ctx.readOnly = false;
  f.mode("switch");
  await assert.rejects(f.reads.listMarketplaces([], context), /account changed/);
});
test("repository refresh uses the guarded local action and refuses backend or read-only requests", async () => {
  const f = fixture();
  const context = { mode: "ccd" };
  assert.deepEqual(await f.reads.refreshMarketplace("repo", ["*"], context), {});
  await assert.rejects(f.reads.refreshMarketplace("repo", [], context, "marketplace_id"), /unavailable/);
  f.ctx.readOnly = true;
  await assert.rejects(f.reads.refreshMarketplace("repo", [], context), /unavailable/);
  assert.deepEqual(f.mutations, [["refreshNativePluginMarketplace", "repo"]]);
});
test("repository add confirms the runtime marketplace and honors its requested domain", async () => {
  const f = fixture();
  const context = { mode: "ccd" };
  await assert.rejects(f.reads.addMarketplace("owner/repo", ["example.invalid"], context), /POLICY_BLOCKED/);
  await assert.rejects(f.reads.addMarketplace("https://github.com/owner/repo?secret=1", ["*"], context), /POLICY_BLOCKED/);
  await assert.rejects(f.reads.addMarketplace("/private/repo", ["*"], context), /GitHub/);
  assert.deepEqual(f.mutations, []);
  const row = await f.reads.addMarketplace("owner/repo", ["github.com"], context);
  assert.equal(row.name, "repo");
  assert.equal(row.source, "local");
  assert.equal(row.url, "https://github.com/owner/repo");
  assert.deepEqual(f.mutations, [["addNativePluginMarketplace", "owner/repo"]]);
});
test("original marketplace lifecycle reports actual inventory and permits only account-level catalog entries", async () => {
  const f = fixture();
  const id = "sample@personal";
  const entry = {
    id,
    name: "sample",
    title: "Sample",
    marketplace: "personal",
    installed: false,
    installable: true,
    source: "local",
    marketplacePath: "/private/marketplace.json",
  };
  f.catalog({
    marketplaces: [{ name: "personal" }],
    loadErrors: [],
    plugins: [entry],
  });
  const context = {
    mode: "ccd",
    telemetryAttempt: { attempt: 1, maxAttempts: 4 },
  };
  const [available] = await f.reads.listAvailablePlugins([], context);
  assert.equal(available.id, id);
  assert.equal(available.isInstalled, false);
  assert.equal(available.source, "local");
  assert.ok(!JSON.stringify(available).includes("/private"));
  assert.equal(
    (await f.reads.installPlugin("foreign@personal", [], context)).success,
    false,
  );
  await assert.rejects(
    f.reads.installPlugin(id, ["domain.test"], context),
    /Domain-scoped/,
  );
  await assert.rejects(
    f.reads.installPlugin(id, [], { mode: "ccd", workspacePath: "/other" }),
    /account-level/,
  );
  assert.deepEqual(f.mutations, []);
  const installContext = { mode: "ccd", pluginSource: "local" };
  assert.deepEqual(await f.reads.installPlugin(id, [], installContext), {
    success: true,
    pluginId: id,
  });
  assert.equal(
    (await f.reads.listAvailablePlugins([], context))[0].isInstalled,
    true,
  );
  const libraryId = runtimePluginLibraryId(id);
  assert.deepEqual(
    await f.reads.setPluginEnabled(libraryId, false, {
      mode: "ccd",
      settingsLevel: "user",
    }),
    { success: true, enabled: false },
  );
  await assert.rejects(
    f.reads.setPluginEnabled(libraryId, true, {
      mode: "ccd",
      settingsLevel: "project",
    }),
    /account-level/,
  );
  await f.reads.uninstallPlugin(libraryId, [], { mode: "ccd" });
  assert.equal(
    (await f.reads.listAvailablePlugins([], context))[0].isInstalled,
    false,
  );
  assert.deepEqual(f.mutations, [
    ["installPlugin", id],
    ["setNativePluginEnabled", id, false],
    ["uninstallPlugin", id],
  ]);
});
test("catalog failure, partial state, duplicate identities and activation changes never become healthy empty results", async () => {
  for (const mode of ["error", "switch", "retire"]) {
    const f = fixture();
    f.mode(mode);
    await assert.rejects(
      f.reads.listMarketplaces([]),
      (e: any) => !e.message.includes("PRIVATE_PATH_OR_TOKEN"),
    );
  }
  for (const catalog of [
    null,
    {},
    { marketplaces: [], loadErrors: ["private failure"] },
    { marketplaces: [{ name: "a", syncError: "failed" }], loadErrors: [] },
    { marketplaces: [{ name: "a" }, { name: "a" }], loadErrors: [] },
    { marketplaces: [{ name: "a", lastUpdated: NaN }], loadErrors: [] },
  ]) {
    const f = fixture();
    f.catalog(catalog);
    await assert.rejects(f.reads.listMarketplaces([]), /catalog/);
  }
  const f = fixture();
  f.signout();
  await assert.rejects(f.reads.listMarketplaces([]), /Sign in/);
  assert.equal(f.calls, 0);
  const empty = fixture();
  empty.catalog({ marketplaces: [], plugins: [], loadErrors: [] });
  assert.deepEqual(
    await empty.reads.listMarketplaces([]),
    [],
    "confirmed empty host catalog remains valid",
  );
});
