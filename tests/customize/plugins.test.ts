import test from "node:test";
import assert from "node:assert/strict";
import { PluginService, type PluginRpc } from "../../electron/plugins/plugins";
import { splitPluginId } from "../../electron/plugins/plugins-support";
import {
  marketplaceSource,
  pluginCatalog,
  pluginDetails,
} from "../../electron/plugins/plugin-catalog";

const listing = {
  marketplaces: [
    {
      name: "claude-plugins-official",
      path: "/home/u/.codex/.tmp/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json",
      interface: null,
      plugins: [
        {
          id: "zeta@claude-plugins-official",
          name: "zeta",
          source: { type: "git", url: "https://github.com/x/y.git" },
          installed: false,
          enabled: false,
          installPolicy: "AVAILABLE",
          availability: "AVAILABLE",
          interface: {
            displayName: null,
            developerName: "Zeta Co",
            category: "Security",
            websiteUrl: "https://zeta.example",
          },
        },
        {
          id: "alpha@claude-plugins-official",
          name: "alpha",
          source: { type: "local", path: "/x" },
          installed: true,
          enabled: true,
          installPolicy: "AVAILABLE",
          availability: "AVAILABLE",
          interface: {
            displayName: "Alpha Tools",
            shortDescription: "Helps with alpha.",
            category: null,
          },
        },
        {
          id: "blocked@claude-plugins-official",
          name: "blocked",
          source: { type: "git" },
          installed: false,
          installPolicy: "NOT_AVAILABLE",
          interface: {},
        },
      ],
    },
  ],
  marketplaceLoadErrors: [{ marketplacePath: "/x", message: "no manifest" }],
};

test("the runtime's plugin list becomes the pages' catalogue, by title", () => {
  const catalog = pluginCatalog(listing);
  assert.deepEqual(catalog.marketplaces, [
    {
      name: "claude-plugins-official",
      path: listing.marketplaces[0].path,
      plugins: 3,
    },
  ]);
  assert.deepEqual(
    catalog.plugins.map((p) => p.title),
    ["Alpha Tools", "blocked", "zeta"],
  );
  const alpha = catalog.plugins[0];
  assert.equal(alpha.installed, true);
  assert.equal(alpha.description, "Helps with alpha.");
  assert.equal(alpha.source, "local");
  assert.equal(alpha.category, undefined);
  const zeta = catalog.plugins[2];
  assert.equal(zeta.category, "security");
  assert.equal(zeta.developer, "Zeta Co");
  assert.equal(zeta.website, "https://zeta.example");
  assert.equal(zeta.installable, true);
  assert.equal(catalog.plugins[1].installable, false);
  assert.deepEqual(catalog.loadErrors, ["no manifest"]);
  assert.deepEqual(pluginCatalog(undefined), {
    marketplaces: [],
    plugins: [],
    loadErrors: [],
  });
});

test("what a plugin brings is read from plugin/read", () => {
  const details = pluginDetails({
    plugin: {
      description: "Does things",
      skills: [
        { name: "review", description: "Reviews", shortDescription: "R" },
      ],
      apps: [{ id: "a1", name: "Drive" }],
      mcpServers: ["docs", "search"],
      hooks: [{ key: "k" }],
    },
  });
  assert.equal(details.description, "Does things");
  assert.deepEqual(details.skills, [
    { name: "review", description: "Reviews" },
  ]);
  assert.deepEqual(details.apps, [{ name: "Drive" }]);
  assert.deepEqual(details.mcpServers, [{ name: "docs" }, { name: "search" }]);
  assert.equal(details.hooks, 1);
  assert.deepEqual(pluginDetails({}), {
    description: "",
    skills: [],
    apps: [],
    mcpServers: [],
    hooks: 0,
  });
});

test("plugin ids split at the last @", () => {
  assert.deepEqual(splitPluginId("a@b@c"), { name: "a@b", marketplace: "c" });
  assert.throws(() => splitPluginId("plain"), /not valid/);
  assert.throws(() => splitPluginId("@x"), /not valid/);
  assert.throws(() => splitPluginId("x@"), /not valid/);
});

test("a marketplace is a GitHub repository or an https address, nothing local", () => {
  assert.equal(
    marketplaceSource(" anthropics/claude-plugins-official "),
    "anthropics/claude-plugins-official",
  );
  assert.equal(marketplaceSource("owner/repo.git"), "owner/repo");
  assert.equal(
    marketplaceSource("https://gitlab.com/team/plugins.git"),
    "https://gitlab.com/team/plugins.git",
  );
  for (const bad of [
    "",
    "/etc",
    "../x",
    "~/plugins",
    "file:///etc",
    "git@github.com:a/b.git",
    "ssh://git@github.com/a/b.git",
    "http://example.com/a.git",
    "https://user:pw@example.com/a.git",
    "a/b/c",
  ])
    assert.throws(() => marketplaceSource(bad), /GitHub|Enter/, bad);
  assert.throws(() => marketplaceSource(42), /Enter/);
});

function fakeRuntime() {
  const calls: [string, unknown][] = [];
  const rpc: PluginRpc = {
    async call(method, params) {
      calls.push([method, params]);
      if (method === "plugin/list") return listing;
      if (method === "plugin/read")
        return { plugin: { description: "Read it", skills: [] } };
      if (method === "plugin/install")
        return { appsNeedingAuth: [{ name: "Drive" }, {}] };
      return {};
    },
  };
  return { calls, service: new PluginService(async () => rpc) };
}

test("install and read find the plugin's marketplace first", async () => {
  const { calls, service } = fakeRuntime();
  const result = await service.install("zeta@claude-plugins-official");
  assert.deepEqual(result, { appsNeedingAuth: ["Drive"] });
  assert.deepEqual(calls.at(-1), [
    "plugin/install",
    { pluginName: "zeta", marketplacePath: listing.marketplaces[0].path },
  ]);
  assert.equal(
    (await service.read("alpha@claude-plugins-official")).description,
    "Read it",
  );
  await assert.rejects(
    service.install("nope@claude-plugins-official"),
    /isn't in a marketplace/,
  );
  await assert.rejects(
    service.install("blocked@claude-plugins-official"),
    /can't be installed/,
  );
});

test("uninstall and marketplace changes go to the runtime as asked", async () => {
  const { calls, service } = fakeRuntime();
  await service.uninstall("alpha@claude-plugins-official");
  await service.addMarketplace("owner/repo");
  await service.removeMarketplace("claude-plugins-official");
  await service.upgradeMarketplaces();
  assert.deepEqual(calls, [
    ["plugin/uninstall", { pluginId: "alpha@claude-plugins-official" }],
    ["marketplace/add", { source: "owner/repo" }],
    ["plugin/list", {}],
    ["plugin/uninstall", { pluginId: "alpha@claude-plugins-official" }],
    ["marketplace/remove", { marketplaceName: "claude-plugins-official" }],
    ["marketplace/upgrade", {}],
  ]);
  await assert.rejects(service.addMarketplace("/etc"), /GitHub/);
  await assert.rejects(service.uninstall("plain"), /not valid/);
});

test("versions: the marketplace's manifest version, and the installed copy's from CODEX_HOME's cache", async () => {
  const { installedPluginVersion } =
    await import("../../electron/plugins/plugins");
  const catalog = pluginCatalog({
    marketplaces: [
      {
        name: "personal",
        path: "/m.json",
        plugins: [
          {
            id: "demo@personal",
            name: "demo",
            version: null,
            localVersion: "1.3.0",
            installed: true,
          },
        ],
      },
    ],
  });
  assert.equal(catalog.plugins[0].availableVersion, "1.3.0");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-plugin-cache-"));
  try {
    assert.equal(
      installedPluginVersion(home, { name: "demo", marketplace: "personal" }),
      undefined,
    );
    fs.mkdirSync(path.join(home, "plugins/cache/personal/demo/1.2.0"), {
      recursive: true,
    });
    assert.equal(
      installedPluginVersion(home, { name: "demo", marketplace: "personal" }),
      "1.2.0",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
