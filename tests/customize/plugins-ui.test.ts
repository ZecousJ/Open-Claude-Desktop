import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { before } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});

const { PluginsBody } = await import("../../src/plugins/PluginsBody");
before(async () =>
  (await import("../../src/plugins/PluginsBody")).preloadMarketplaces(),
);
const model = await import("../../src/plugins/plugin-model");
const { mcpPluginMenuEntry } = await import("../../src/settings/tabs/Plugins");
const { pluginAddMenu } = await import("../../src/plugins/plugin-menu");
const { PluginsTab } = await import("../../src/settings/tabs/Plugins");

test("Add uses the official visible label and Add plugin accessible name", () => {
  const html = renderToStaticMarkup(createElement(PluginsTab));
  assert.match(html, /aria-label="Add plugin"/);
  assert.match(html, />Add</);
  assert.doesNotMatch(html, />Add plugin</);
});

test("plugin add menu groups live upload, MCP, create and marketplace actions", () => {
  const selected: string[] = [];
  const menu = pluginAddMenu({
    connector: mcpPluginMenuEntry(true, true, false, () =>
      selected.push("mcp"),
    ),
    onUpload: () => selected.push("upload"),
    onCreate: () => selected.push("create"),
    onCreateWithClaudex: () => selected.push("chat"),
    onAddMarketplace: () => selected.push("add"),
    onManageMarketplaces: () => selected.push("manage"),
  });
  assert.deepEqual(
    menu.map((entry) => ("label" in entry ? entry.label : "separator")),
    [
      "Add marketplace",
      "Manage marketplaces",
      "Upload plugin",
      "Create a plugin",
      "Create with Claudex",
      "separator",
      "Add plugin from MCP URL",
    ],
  );
  for (const entry of menu)
    if ("label" in entry) {
      assert.notEqual(entry.disabled, true);
      entry.onSelect();
    }
  assert.deepEqual(selected, [
    "add",
    "manage",
    "upload",
    "create",
    "chat",
    "mcp",
  ]);
  const empty = pluginAddMenu({
    onUpload() {},
    onCreate() {},
    onAddMarketplace() {},
  });
  assert.equal(
    empty.some(
      (entry) => "label" in entry && entry.label === "Manage marketplaces",
    ),
    false,
  );
});

test("MCP URL plugin menu follows host support and edit policy and opens the connector flow", () => {
  let opened = false;
  assert.deepEqual(
    mcpPluginMenuEntry(false, true, false, () => {}),
    [],
  );
  const [entry] = mcpPluginMenuEntry(true, true, false, () => {
    opened = true;
  });
  assert.ok("label" in entry);
  assert.equal(entry.label, "Add plugin from MCP URL");
  assert.equal(entry.disabled, false);
  entry.onSelect();
  assert.equal(opened, true);
  const [blocked] = mcpPluginMenuEntry(true, false, false, () => {});
  assert.ok("label" in blocked);
  assert.equal(blocked.disabled, true);
  assert.match(blocked.title!, /administrator/);
});
type Entry = import("../../shared/collections-api").PluginEntry;
type State = import("../../src/plugins/usePlugins").PluginsState;

const entry = (name: string, extra: Partial<Entry> = {}): Entry => ({
  id: `${name}@official`,
  name,
  title: name,
  marketplace: "official",
  marketplacePath: "/m.json",
  installed: false,
  enabled: false,
  installable: true,
  source: "git",
  ...extra,
});
const state = (over: Partial<State> = {}): State => ({
  loading: false,
  reload: async () => {},
  install: async () => [],
  uninstall: async () => {},
  addMarketplace: async () => {},
  addOfficial: async () => {},
  removeMarketplace: async () => {},
  upgradeMarketplaces: async () => {},
  setAutoSync: async () => {},
  ...over,
});
const catalog = (plugins: Entry[], marketplaces = 1) => ({
  marketplaces: Array.from({ length: marketplaces }, () => ({
    name: "claude-plugins-official",
    path: "/m.json",
    plugins: plugins.length,
  })),
  plugins,
  loadErrors: [],
});
const render = (
  view: "yours" | "discover",
  plugins: State,
  filter: import("../../src/plugins/plugin-model").PluginFilter = {},
) =>
  renderToStaticMarkup(
    createElement(PluginsBody, {
      view,
      filter,
      plugins,
      onOpen: () => {},
      onAddMarketplace: () => {},
      onDiscover: () => {},
      onError: () => {},
    }),
  );

test("before the list arrives the page says it is loading, or why it failed", () => {
  assert.match(render("discover", state()), /aria-label="Loading plugins"/);
  const failed = render(
    "discover",
    state({ failure: "The agent isn't running." }),
  );
  assert.match(failed, /The agent isn(?:\x27|&#x27;)t running\./);
  assert.match(failed, /Try again/);
});

test("plugin empty states distinguish unavailable plugins, filters and personal marketplaces", () => {
  assert.match(
    render("discover", state({ catalog: catalog([]) })),
    /No plugins available/,
  );
  assert.match(
    render("discover", state({ catalog: catalog([entry("a")]) }), {
      category: "design",
    }),
    /No plugins match your filters/,
  );
  const personal = catalog([]);
  personal.marketplaces[0].name = "personal";
  assert.match(
    render("discover", state({ catalog: personal })),
    /When you add plugins to your marketplace, they will appear here\./,
  );
  personal.marketplaces[0].name = "local-desktop-app-uploads";
  assert.match(
    render("discover", state({ catalog: personal })),
    /When you upload plugins, they will appear here\./,
  );
});

test("Yours lists what is installed, or invites to Discover", () => {
  const list = [
    entry("agent-sdk", { installed: true, category: "development" }),
    entry("figma", { category: "design" }),
  ];
  const yours = render("yours", state({ catalog: catalog(list) }));
  assert.match(yours, />agent-sdk</);
  assert.match(yours, />Development</);
  assert.doesNotMatch(yours, />figma</);
  assert.match(yours, />Added</);
  const none = render("yours", state({ catalog: catalog([entry("figma")]) }));
  assert.match(none, /Add your first plugins/);
  assert.match(none, /Discover plugins/);
});

test("Discover lists every plugin with Add, and the marketplaces below", () => {
  const html = render(
    "discover",
    state({
      catalog: catalog([
        entry("figma", {
          category: "design",
          developer: "Figma",
          description: "Design in chat",
        }),
        entry("stripe", { installable: false }),
      ]),
    }),
  );
  assert.match(html, />figma</);
  assert.match(
    html,
    /<strong[^>]*>figma<\/strong><span class="customize-card-description"[^>]*>Design in chat<\/span><small[^>]*>from Figma<\/small>/,
  );
  assert.match(html, /from official/);
  assert.match(html, /aria-label="Add figma"/);
  // A plugin the marketplace blocks cannot be added.
  assert.match(
    html,
    /disabled=""[^>]*title="This plugin can(?:\x27|&#x27;)t be installed\."/,
  );
  assert.match(html, /Marketplaces/);
  assert.match(html, /Community marketplace/);
  assert.match(html, />Update all</);
  const filtered = render(
    "discover",
    state({ catalog: catalog([entry("figma"), entry("stripe")]) }),
    { query: "STRI" },
  );
  assert.match(filtered, />stripe</);
  assert.doesNotMatch(filtered, />figma</);
  assert.doesNotMatch(filtered, /Marketplaces/);
  assert.match(
    render("discover", state({ catalog: catalog([entry("a")]) }), {
      query: "zzz",
    }),
    /No plugins match your search/,
  );
  assert.match(
    render("discover", state({ catalog: catalog([entry("a")]) }), {
      query: "zzz",
    }),
    /No plugins match your search\./,
  );
});

test("with no marketplace Discover offers Anthropic's and a repository", () => {
  const html = render("discover", state({ catalog: catalog([], 0) }));
  assert.match(html, /Add a plugin marketplace/);
  assert.match(html, /Add community marketplace/);
  assert.match(html, /Add from a repository/);
});

test("the marketplace's category names read as labels and pick a glyph", () => {
  assert.equal(model.categoryLabel("developer-tools"), "Developer tools");
  assert.equal(model.categoryLabel("api"), "API");
  assert.equal(model.categoryLabel(""), "Other");
  assert.equal(model.pluginIcon("design"), "palette");
  assert.equal(model.pluginIcon("security"), "server");
  assert.equal(model.pluginIcon("unheard-of"), "briefcase");
  assert.equal(model.pluginIcon(undefined), "briefcase");
  const list = [
    entry("a", { category: "design" }),
    entry("b", { category: "design" }),
    entry("c", { category: "security" }),
    entry("d"),
  ];
  assert.deepEqual(model.pluginCategoriesOf(list), [
    { id: "design", label: "Design", count: 2 },
    { id: "security", label: "Security", count: 1 },
  ]);
  assert.deepEqual(
    model.filterPlugins(list, { category: "design" }).map((p) => p.name),
    ["a", "b"],
  );
  assert.deepEqual(model.filterPlugins(list, { marketplace: "elsewhere" }), []);
  assert.equal(
    model.pluginErrorText(
      new Error("Error invoking remote method 'app:x': boom"),
    ),
    "boom",
  );
});
