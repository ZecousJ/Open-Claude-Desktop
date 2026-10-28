import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { connectorSearchExtension } from "../../electron/connectors/connector-search";
import { MarketplaceState } from "../../electron/plugins/marketplace-state";
import { PluginService, type PluginRpc } from "../../electron/plugins/plugins";
import { pluginCatalog } from "../../electron/plugins/plugin-catalog";
import { marketplaceFailure } from "../../shared/marketplace-status";
import { preference } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import { CapabilitiesTab } from "../../src/settings/tabs/Capabilities";
import ConnectorDetail, {
  connectorReview,
} from "../../src/settings/tabs/ConnectorDetail";
import { ConnectorCards } from "../../src/settings/tabs/ConnectorDirectory";
import {
  connectors,
  findConnectors,
  defaultConnectorFilter,
} from "../../shared/connectors-catalogue";
import { connectorLinkId } from "../../src/settings/navigation";
import {
  connectorShareLink,
  desktopConnectorLink,
} from "../../shared/connector-links";
import Marketplaces, { MarketplaceError } from "../../src/plugins/Marketplaces";
import type { PluginsState } from "../../src/plugins/usePlugins";
import type { Settings } from "../../shared/types";
import type {
  DynamicToolCall,
  EngineTurnContext,
} from "../../electron/engine/engine-extensions";
import type { TabProps } from "../../src/settings/context";

test("connector suggestions default on, validate and render as a live switch", () => {
  assert.equal(preference({} as Settings, "connectorSearch"), true);
  assert.equal(preferenceFields.connectorSearch.safeParse(false).success, true);
  assert.equal(
    preferenceFields.connectorSearch.safeParse("false").success,
    false,
  );
  for (const enabled of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(CapabilitiesTab, {
        settings: { connectorSearch: enabled },
        save: async () => true,
        goTo() {},
      } as unknown as TabProps),
    );
    assert.match(
      html,
      new RegExp(`aria-label="Connector search"[^>]*aria-checked="${enabled}"`),
    );
    assert.doesNotMatch(html, /aria-label="Connector search"[^>]*disabled/);
  }
});

test("approved directory entries use the same All, Community and search filters", () => {
  const entries = [
    { ...connectors[0], id: "approved", type: "community" as const },
  ];
  assert.equal(findConnectors(defaultConnectorFilter, entries).length, 1);
  assert.equal(
    findConnectors({ ...defaultConnectorFilter, type: "community" }, entries)
      .length,
    1,
  );
  assert.equal(
    findConnectors({ ...defaultConnectorFilter, type: "verified" }, entries)
      .length,
    0,
  );
  assert.equal(
    findConnectors(
      { ...defaultConnectorFilter, query: "does-not-match" },
      entries,
    ).length,
    0,
  );
});

test("directory search honors the current setting even in a previously opened thread", async () => {
  let settings = {} as Settings;
  const extension = connectorSearchExtension(() => settings);
  const ctx = { mode: "chat", settings } as EngineTurnContext;
  assert.equal(extension.dynamicTools!(ctx)?.length, 1);
  assert.deepEqual(extension.dynamicTools!({ ...ctx, mode: "code" }), []);
  const call = {
    tool: "search_connector_directory",
    namespace: null,
    arguments: { query: "Linear" },
    conversation: { mode: "chat" },
  } as DynamicToolCall;
  const found = await extension.handleDynamicTool!(call);
  assert.equal(found?.success, true);
  assert.match(JSON.stringify(found), /settings\/connectors\?connector=linear/);
  settings = { connectorSearch: false } as Settings;
  assert.equal((await extension.handleDynamicTool!(call))?.success, false);
  assert.equal(
    (await extension.handleDynamicTool!({ ...call, arguments: { query: {} } }))
      ?.success,
    false,
  );
  assert.match(
    JSON.stringify(extension.turnContext!({ ...ctx, settings })),
    /disabled/,
  );
  settings = { connectorSearch: true } as Settings;
  assert.equal((await extension.handleDynamicTool!(call))?.success, true);
  assert.equal(
    connectorLinkId("/settings/connectors?connector=linear"),
    "linear",
  );
  assert.equal(
    connectorLinkId(
      "https://evil.example/settings/connectors?connector=linear",
    ),
    undefined,
  );
});

test("connector detail uses genuine metadata and does not infer unknown authentication", () => {
  const entry = {
    ...connectors.find((entry) => entry.id === "linear")!,
    url: "https://mcp.example/mcp",
    isAuthless: true,
    supportUrl: "https://support.example",
    documentationUrl: "https://docs.example",
    added: "2026-10-14",
  };
  const html = renderToStaticMarkup(
    createElement(ConnectorDetail, {
      entry,
      editable: true,
      onBack() {},
      onConnect: async () => {},
      onSet() {},
      onError() {},
    }),
  );
  for (const label of [
    "Copy link",
    "Support",
    "Documentation",
    "Connector URL",
    "Sign-in",
    "Not required",
    "Review status",
    "Verified in the source directory",
    "Added to directory",
    "Made by",
    "Connected by default",
    "Connect",
    "Cancel",
  ])
    assert.ok(html.includes(label), label);
  assert.match(html, /This connector doesn’t use authentication/);
  const custom = renderToStaticMarkup(
    createElement(ConnectorDetail, {
      server: {
        name: "Custom",
        state: "ready",
        tools: 0,
        authStatus: "unsupported",
        url: "https://custom.example",
      },
      editable: true,
      onBack() {},
      onConnect: async () => {},
      onSet() {},
      onError() {},
    }),
  );
  assert.match(custom, /Not reviewed in the source directory/);
  assert.doesNotMatch(
    custom,
    /Sign-in|Connected by default|>Support<|>Documentation</,
  );
  assert.equal(
    connectorReview({ ...entry, type: "community" }),
    "Not verified in the source directory",
  );
  const cards = renderToStaticMarkup(
    createElement(ConnectorCards, { entries: [entry], onOpen() {} }),
  );
  assert.doesNotMatch(cards, /disabled|not available/);
});

test("connector detail says how the connection stands and offers Disconnect with Reconnect or Connect", () => {
  const render = (server: object | undefined, onDisconnect?: () => void) =>
    renderToStaticMarkup(
      createElement(ConnectorDetail, {
        entry: connectors.find((entry) => entry.id === "linear")!,
        server: server as never,
        editable: true,
        onBack() {},
        onDisconnect,
        onConnect: async () => {},
        onSet() {},
        onError() {},
      }),
    );
  const fresh = render(undefined);
  assert.match(fresh, /You’re not connected to Linear yet\./);
  assert.doesNotMatch(fresh, />Disconnect</);
  const broken = render(
    { name: "linear", state: "failed", tools: 0, url: "https://x.test/mcp" },
    () => {},
  );
  assert.match(
    broken,
    /Your connection to linear stopped working\. Reconnect to continue\./,
  );
  assert.match(broken, />Disconnect</);
  assert.match(broken, />Reconnect</);
  const off = render(
    { name: "linear", state: "disabled", tools: 0, url: "https://x.test/mcp" },
    () => {},
  );
  assert.match(
    off,
    /You disconnected linear\. Claudex can’t access it until you connect it again\./,
  );
  assert.match(off, />Connect</);
  const connected = render(
    { name: "linear", state: "ready", tools: 1, url: "https://x.test/mcp" },
    () => {},
  );
  assert.doesNotMatch(connected, /not connected|stopped working|disconnected/);
  assert.match(connected, />Disconnect</);
  assert.doesNotMatch(connected, />Connect</);
});

test("a suggested connector's confirmation shows who made it, its address, sign-in and review before Connect", async () => {
  const { SuggestionFacts } =
    await import("../../src/settings/tabs/ConnectorsView");
  const entry = {
    ...connectors.find((entry) => entry.id === "linear")!,
    url: "https://mcp.example/mcp",
    isAuthless: false,
    added: "2026-10-14",
  };
  const known = renderToStaticMarkup(
    createElement(SuggestionFacts, {
      suggestion: { name: "Linear", url: "https://mcp.example/mcp" },
      entry,
    }),
  );
  for (const text of [
    "Made by",
    "Connector URL",
    "https://mcp.example/mcp",
    "Sign-in",
    "Required",
    "Review status",
    "Added to directory",
  ])
    assert.ok(known.includes(text), text);
  const unknown = renderToStaticMarkup(
    createElement(SuggestionFacts, {
      suggestion: { name: "Mystery", url: "https://other.example/mcp" },
    }),
  );
  assert.match(unknown, /Not reviewed in the source directory/);
  assert.doesNotMatch(unknown, /Made by|Sign-in|Added to directory/);
});

test("connector detail links work for packaged desktop and hosted web without leaking query tokens", () => {
  const desktop = connectorShareLink(
    "installed:Example",
    "file:///app/index.html?token=secret",
    true,
  );
  assert.equal(
    desktop,
    "claudex://settings/connectors?connector=installed%3AExample",
  );
  assert.equal(desktopConnectorLink(desktop), "installed:Example");
  assert.equal(
    connectorShareLink(
      "linear",
      "https://app.example/chat?token=secret",
      false,
    ),
    "https://app.example/settings/connectors?connector=linear",
  );
  for (const href of [
    "https://settings/connectors?connector=x",
    "claudex://evil/connectors?connector=x",
    "claudex://user@settings/connectors?connector=x",
    "claudex://settings/other?connector=x",
    "invalid",
  ])
    assert.equal(desktopConnectorLink(href), undefined);
});

test("marketplace errors distinguish missing Git and egress restrictions from generic sync failure", () => {
  assert.equal(marketplaceFailure("spawn git ENOENT"), "Git is required");
  assert.equal(marketplaceFailure("Git is required"), "Git is required");
  assert.equal(
    marketplaceFailure("Network access required"),
    "Network access required",
  );
  assert.equal(
    marketplaceFailure("Host github.com blocked by egress settings"),
    "Marketplace unreachable",
  );
  assert.equal(marketplaceFailure("ECONNRESET"), "Sync failed");
  const html = renderToStaticMarkup(
    createElement(MarketplaceError, {
      error: "Host blocked by egress settings",
      source: "https://github.com/owner/repo",
    }),
  );
  assert.match(
    html,
    /Network access to github.com is blocked by egress settings/,
  );
  assert.match(html, /capabilities settings/);
});

test("unreachable marketplaces remain visible before a checkout exists", () => {
  const catalog = pluginCatalog({
    marketplaces: [{ name: "unreachable", path: null, plugins: [] }],
    marketplaceLoadErrors: [
      { message: "Host github.com blocked by egress settings" },
    ],
  });
  assert.equal(catalog.marketplaces[0].name, "unreachable");
  assert.equal(catalog.marketplaces[0].path, "");
  assert.equal(catalog.loadErrors.length, 1);
});

test("marketplace metadata rejects malformed persisted values and private repository credentials", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-marketplace-state-"),
  );
  try {
    fs.writeFileSync(
      path.join(root, "marketplace-sync.json"),
      JSON.stringify({
        broken: null,
        private: {
          source: "https://token@github.com/owner/repo",
          lastUpdated: "yesterday",
          autoSync: "yes",
        },
        public: {
          source: "https://github.com/owner/repo?token=secret#private",
          autoSync: true,
        },
      }),
    );
    const state = new MarketplaceState(() => root);
    const entry = (name: string) =>
      state.describe({ name, path: "", plugins: 0 });
    assert.equal((await entry("private")).source, undefined);
    assert.equal((await entry("private")).lastUpdated, undefined);
    assert.equal((await entry("private")).autoSync, undefined);
    assert.equal(
      (await entry("public")).source,
      "https://github.com/owner/repo",
    );
    assert.equal(state.hasAutoSync(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const fixture = () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-marketplace-parity-"),
  );
  const state = new MarketplaceState(() => root);
  const listing = {
    marketplaces: ["first", "second"].map((name) => ({
      name,
      path: root,
      plugins: [
        { name: "added", id: `added@${name}`, installed: true, enabled: true },
        { name: "other", id: `other@${name}`, installed: false },
      ],
    })),
  };
  const calls: [string, unknown][] = [];
  const rpc: PluginRpc = {
    async call(method, params) {
      calls.push([method, params]);
      if (method === "plugin/list") return listing;
      return {};
    },
  };
  return {
    root,
    state,
    calls,
    rpc,
    listing,
    clean: () => fs.rmSync(root, { recursive: true, force: true }),
  };
};

test("refresh targets one marketplace, stores success and preserves partial update results", async () => {
  const item = fixture();
  try {
    const service = new PluginService(
      async () => item.rpc,
      () => undefined,
      item.state,
    );
    await service.upgradeMarketplaces("first");
    assert.deepEqual(item.calls.at(-1), [
      "marketplace/upgrade",
      { marketplaceName: "first" },
    ]);
    assert.ok((await service.list()).marketplaces[0].lastUpdated);
    const original = item.rpc.call;
    item.rpc.call = async (method, params) =>
      method === "marketplace/upgrade"
        ? { errors: [{ marketplaceName: "second", message: "fetch failed" }] }
        : original(method, params);
    await assert.rejects(service.upgradeMarketplaces(), /fetch failed/);
    const list = await service.list();
    assert.equal(list.marketplaces[0].syncError, undefined);
    assert.equal(list.marketplaces[1].syncError, "fetch failed");
    await assert.rejects(service.upgradeMarketplaces("missing"), /not valid/);
  } finally {
    item.clean();
  }
});

test("remove uninstalls only that marketplace's installed plugins before removing it", async () => {
  const item = fixture();
  try {
    item.state.update("first", { autoSync: true });
    const service = new PluginService(
      async () => item.rpc,
      () => undefined,
      item.state,
    );
    await service.removeMarketplace("first");
    assert.deepEqual(
      item.calls.filter(([method]) => method !== "plugin/list"),
      [
        ["plugin/uninstall", { pluginId: "added@first" }],
        ["marketplace/remove", { marketplaceName: "first" }],
      ],
    );
    assert.equal(item.state.hasAutoSync(), false);
    item.rpc.call = async (method) => {
      if (method === "plugin/list") return item.listing;
      throw Error("uninstall failed");
    };
    await assert.rejects(
      service.removeMarketplace("second"),
      /uninstall failed/,
    );
  } finally {
    item.clean();
  }
});

test("GitHub auto sync persists per account, detects unchanged commits and respects network access", async () => {
  const item = fixture();
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: item.root, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git(
      "-c",
      "user.name=Parity",
      "-c",
      "user.email=parity@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
      "--quiet",
    );
    git(
      "remote",
      "add",
      "origin",
      "https://user:secret@github.com/owner/repository.git",
    );
    const commit = git("rev-parse", "HEAD");
    const service = new PluginService(
      async () => item.rpc,
      () => undefined,
      item.state,
    );
    const list = await service.list();
    assert.equal(
      list.marketplaces[0].source,
      "https://github.com/owner/repository.git",
    );
    assert.equal(list.marketplaces[0].syncedCommit, commit);
    assert.equal(list.marketplaces[0].autoSync, undefined);
    await service.setAutoSync("first", true);
    assert.equal(new MarketplaceState(() => item.root).hasAutoSync(), true);
    let changed = false;
    item.state.changed = async () => changed;
    const before = item.calls.length;
    await service.syncAutomatically();
    assert.equal(
      item.calls
        .slice(before)
        .some(([method]) => method === "marketplace/upgrade"),
      false,
    );
    changed = true;
    await service.syncAutomatically();
    assert.ok(
      item.calls.some(
        ([method, params]) =>
          method === "marketplace/upgrade" &&
          (params as { marketplaceName: string }).marketplaceName === "first",
      ),
    );
    const denied = new PluginService(
      async () => item.rpc,
      () => undefined,
      item.state,
      () => false,
    );
    await assert.rejects(
      denied.upgradeMarketplaces("first"),
      /Network access required/,
    );
    await assert.rejects(
      denied.addMarketplace("owner/repo"),
      /Network access required/,
    );
    assert.equal(
      (await denied.list()).marketplaces[0].syncError,
      "Network access required",
    );
    git("remote", "set-url", "origin", "https://git.example/owner/repo.git");
    await assert.rejects(
      service.setAutoSync("second", true),
      /Failed to update auto-sync setting/,
    );
  } finally {
    item.clean();
  }
});

test("marketplace metadata renders the saved refresh date and seven-character commit", () => {
  const plugins = {
    loading: false,
    catalog: {
      marketplaces: [
        {
          name: "custom",
          path: "/tmp",
          plugins: 2,
          source: "https://github.com/owner/repo",
          lastUpdated: Date.UTC(2026, 9, 14),
          syncedCommit: "abcdef123456",
        },
      ],
      plugins: [],
      loadErrors: [],
    },
  } as unknown as PluginsState;
  const html = renderToStaticMarkup(
    createElement(Marketplaces, { plugins, onAdd() {}, onError() {} }),
  );
  const { document } = parseHTML(html);
  const text = document.documentElement.textContent ?? "";
  assert.ok(text.includes("Last updated:"));
  assert.ok(text.includes("Synced commit: abcdef1"));
  assert.equal(text.includes("abcdef123456"), false);
  assert.ok(
    document.querySelector('button[aria-label="More actions for custom"]'),
  );
});
