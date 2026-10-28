/**
 * Rename plugin: the person's own plugins in the personal marketplace take a
 * new name or display name, an installed one is installed again under its new
 * id with its settings and on/off state, and a failure puts everything back.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  personalMarketplace,
  renamePluginFiles,
} from "../../electron/plugins/plugin-copy";
import { PluginService, type PluginRpc } from "../../electron/plugins/plugins";
import { pluginCatalog } from "../../electron/plugins/plugin-catalog";
import {
  pluginGone,
  pluginRenameBusy,
  pluginNameTaken,
  pluginRenameFailed,
  pluginRenamePlan,
  renameSameName,
} from "../../shared/duplicate-name";

const { PluginRenameDialog, renameFailureText, duplicateFailureText } =
  await import("../../src/plugins/PluginRenameDialog");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claudex-rename-"));

/** A home folder with a personal marketplace holding `names`. */
function personalHome(names: [string, string?][]) {
  const home = temp();
  const places = personalMarketplace(home);
  for (const [name, displayName] of names) {
    const folder = path.join(places.plugins, name);
    fs.mkdirSync(path.join(folder, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        ...(displayName ? { interface: { displayName } } : {}),
      }),
    );
    fs.writeFileSync(path.join(folder, "README.md"), "readme");
  }
  fs.mkdirSync(path.dirname(places.file), { recursive: true });
  fs.writeFileSync(
    places.file,
    JSON.stringify({
      name: "personal",
      plugins: names.map(([name]) => ({
        name,
        source: { source: "local", path: `./plugins/${name}` },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      })),
    }),
  );
  return { home, places };
}

const manifestOf = (folder: string) =>
  JSON.parse(
    fs.readFileSync(path.join(folder, ".codex-plugin", "plugin.json"), "utf8"),
  );
const marketOf = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the typed text becomes a new name, a new display name, or both (live jc)", () => {
  // No display name of its own: a plain name renames only the name …
  assert.deepEqual(
    pluginRenamePlan("linear-two", { name: "linear", title: "" }),
    {
      unchanged: false,
      savedAs: "linear-two",
    },
  );
  // … other text becomes the display name too.
  assert.deepEqual(
    pluginRenamePlan("Linear  Two", { name: "linear", title: "" }),
    {
      unchanged: false,
      savedAs: "linear-two",
      displayName: "Linear Two",
    },
  );
  // A display name that is the name's own form follows the typed text.
  assert.deepEqual(
    pluginRenamePlan("Tracker", { name: "linear", title: "Linear" }),
    { unchanged: false, savedAs: "tracker", displayName: "Tracker" },
  );
  // A display name of its own: a plain name keeps it …
  assert.deepEqual(
    pluginRenamePlan("issues", { name: "linear", title: "My Issues" }),
    { unchanged: false, savedAs: "issues" },
  );
  // … and other text changes only the display name.
  assert.deepEqual(
    pluginRenamePlan("Our Issues", { name: "linear", title: "My Issues" }),
    { unchanged: false, savedAs: "linear", displayName: "Our Issues" },
  );
  // The current display name, or the current plain name, is no change.
  assert.equal(
    pluginRenamePlan(" Linear ", { name: "linear", title: "Linear" }).unchanged,
    true,
  );
  assert.equal(
    pluginRenamePlan("linear", { name: "linear", title: "" }).unchanged,
    true,
  );
  assert.equal(
    pluginRenamePlan("", { name: "linear", title: "" }).unchanged,
    false,
  );
});

test("renaming moves the plugin's folder, manifest and marketplace entry", () => {
  const { home, places } = personalHome([["linear", "Linear"], ["notes"]]);
  const written = renamePluginFiles(
    { name: "linear", folder: path.join(places.plugins, "linear") },
    { name: "tracker", displayName: "Tracker" },
    home,
  );
  const folder = path.join(places.plugins, "tracker");
  assert.equal(written.folder, folder);
  assert.equal(fs.existsSync(path.join(places.plugins, "linear")), false);
  assert.equal(
    fs.readFileSync(path.join(folder, "README.md"), "utf8"),
    "readme",
  );
  const manifest = manifestOf(folder);
  assert.equal(manifest.name, "tracker");
  assert.equal(manifest.interface.displayName, "Tracker");
  assert.equal(manifest.version, "1.0.0");
  assert.deepEqual(marketOf(places.file).plugins[0], {
    name: "tracker",
    source: { source: "local", path: "./plugins/tracker" },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" },
    category: "Productivity",
  });
  assert.equal(marketOf(places.file).plugins[1].name, "notes", "others stay");
  written.undo();
  const back = path.join(places.plugins, "linear");
  assert.equal(manifestOf(back).name, "linear");
  assert.equal(manifestOf(back).interface.displayName, "Linear");
  assert.equal(fs.existsSync(folder), false);
  assert.deepEqual(
    marketOf(places.file).plugins.map((entry: { name: string }) => entry.name),
    ["linear", "notes"],
  );
});

test("a display name alone changes in place; taken and unchanged names are refused", () => {
  const { home, places } = personalHome([["linear", "Linear"], ["notes"]]);
  const folder = path.join(places.plugins, "linear");
  renamePluginFiles(
    { name: "linear", folder },
    { name: "linear", displayName: "Issues" },
    home,
  );
  assert.equal(manifestOf(folder).interface.displayName, "Issues");
  assert.equal(marketOf(places.file).plugins[0].name, "linear");
  assert.throws(
    () =>
      renamePluginFiles({ name: "linear", folder }, { name: "notes" }, home),
    (error: Error) => error.message === pluginNameTaken,
  );
  assert.throws(
    () =>
      renamePluginFiles({ name: "linear", folder }, { name: "linear" }, home),
    (error: Error) => error.message === renameSameName,
  );
  assert.throws(
    () => renamePluginFiles({ name: "gone", folder }, { name: "fresh" }, home),
    (error: Error) => error.message === pluginGone,
  );
  assert.throws(
    () =>
      renamePluginFiles(
        { name: "linear", folder },
        { name: "fresh", displayName: "<b>" },
        home,
      ),
    /< or >/,
  );
});

test("a plugin kept outside ~/plugins is renamed where it is", () => {
  const { home, places } = personalHome([]);
  const elsewhere = path.join(home, "work", "kit");
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(
    places.file,
    JSON.stringify({
      name: "personal",
      plugins: [{ name: "kit", source: { source: "local", path: elsewhere } }],
    }),
  );
  renamePluginFiles(
    { name: "kit", folder: elsewhere },
    { name: "toolkit" },
    home,
  );
  assert.equal(manifestOf(elsewhere).name, "toolkit", "a manifest is written");
  assert.deepEqual(marketOf(places.file).plugins[0], {
    name: "toolkit",
    source: { source: "local", path: elsewhere },
  });
});

test("the personal marketplace's local plugins are listed as the person's own", () => {
  const { places } = personalHome([]);
  const catalog = pluginCatalog(
    {
      marketplaces: [
        {
          name: "personal",
          path: places.file,
          plugins: [
            {
              id: "mine@personal",
              name: "mine",
              source: { type: "local", path: "/x" },
            },
          ],
        },
        {
          name: "other",
          path: "/elsewhere/marketplace.json",
          plugins: [
            {
              id: "theirs@other",
              name: "theirs",
              source: { type: "local", path: "/y" },
            },
          ],
        },
      ],
    },
    places.file,
  );
  assert.equal(catalog.plugins.find((p) => p.name === "mine")?.personal, true);
  assert.equal(
    catalog.plugins.find((p) => p.name === "theirs")?.personal,
    undefined,
  );
});

/** The runtime as far as Rename uses it, reading the real marketplace file. */
function fakeRuntime(
  home: string,
  state: { installed: Set<string>; enabled: Map<string, boolean> },
  failInstall?: string,
) {
  const calls: { method: string; params: any }[] = [];
  const config: Record<string, Record<string, unknown>> = {};
  const rpc: PluginRpc = {
    async call(method, params: any) {
      calls.push({ method, params });
      const file = personalMarketplace(home).file;
      if (method === "plugin/list") {
        const market = marketOf(file);
        return {
          marketplaces: [
            {
              name: "personal",
              path: file,
              plugins: market.plugins.map((entry: any) => {
                const id = `${entry.name}@personal`;
                return {
                  id,
                  name: entry.name,
                  source: {
                    type: "local",
                    path: path.resolve(
                      path.dirname(file),
                      "..",
                      "..",
                      entry.source.path,
                    ),
                  },
                  installed: state.installed.has(id),
                  enabled: state.enabled.get(id) ?? false,
                };
              }),
            },
          ],
        };
      }
      if (method === "plugin/install") {
        if (params.pluginName === failInstall)
          throw new Error("install refused");
        const id = `${params.pluginName}@personal`;
        state.installed.add(id);
        state.enabled.set(id, true);
        config[id] = { ...config[id], enabled: true };
        return { appsNeedingAuth: [] };
      }
      if (method === "plugin/uninstall") {
        state.installed.delete(params.pluginId);
        state.enabled.delete(params.pluginId);
        delete config[params.pluginId];
        return {};
      }
      if (method === "config/read")
        return { config: { plugins: { ...config } } };
      if (method === "config/batchWrite") {
        for (const [id, value] of Object.entries(params.edits[0].value)) {
          config[id] = { ...config[id], ...(value as object) };
          if (typeof (value as any).enabled === "boolean")
            state.enabled.set(id, (value as any).enabled);
        }
        return {};
      }
      return {};
    },
  };
  return { rpc, calls, config };
}

test("an installed plugin is installed again under its new id, off and with its settings", async () => {
  const { home } = personalHome([["linear", "Linear"]]);
  const state = {
    installed: new Set(["linear@personal"]),
    enabled: new Map([["linear@personal", false]]),
  };
  const { rpc, calls, config } = fakeRuntime(home, state);
  config["linear@personal"] = {
    enabled: false,
    mcp_servers: { a: { enabled: false } },
  };
  const service = new PluginService(
    async () => rpc,
    () => home,
  );
  const result = await service.rename(
    "linear@personal",
    { name: "tracker", displayName: "Tracker" },
    home,
  );
  assert.deepEqual(result, { id: "tracker@personal", appsNeedingAuth: [] });
  assert.deepEqual(
    calls
      .map((call) => call.method)
      .filter((m) => m !== "plugin/list" && m !== "config/read"),
    ["plugin/uninstall", "plugin/install", "config/batchWrite"],
  );
  assert.equal(state.installed.has("linear@personal"), false);
  assert.equal(state.installed.has("tracker@personal"), true);
  assert.equal(state.enabled.get("tracker@personal"), false, "stays off");
  assert.deepEqual(config["tracker@personal"], {
    enabled: false,
    mcp_servers: { a: { enabled: false } },
  });
});

test("a second rename of the same plugin waits for the first", async () => {
  const { home } = personalHome([["linear"]]);
  const state = { installed: new Set<string>(), enabled: new Map() };
  const { rpc } = fakeRuntime(home, state);
  const service = new PluginService(
    async () => rpc,
    () => home,
  );
  const first = service.rename("linear@personal", { name: "tracker" }, home);
  await assert.rejects(
    service.rename("linear@personal", { name: "issues" }, home),
    (error: Error) => error.message === pluginRenameBusy,
  );
  await first;
});

test("a plugin that is not installed is only renamed; other marketplaces are refused", async () => {
  const { home } = personalHome([["linear"]]);
  const state = { installed: new Set<string>(), enabled: new Map() };
  const { rpc, calls } = fakeRuntime(home, state);
  const service = new PluginService(
    async () => rpc,
    () => home,
  );
  assert.deepEqual(
    await service.rename("linear@personal", { name: "tracker" }, home),
    {
      id: "tracker@personal",
      appsNeedingAuth: [],
    },
  );
  assert.equal(
    calls.some((call) => call.method === "plugin/install"),
    false,
  );
  await assert.rejects(
    service.rename("tracker@other", { name: "x" }, home),
    (error: Error) => error.message === pluginGone,
  );
  await assert.rejects(
    service.rename("linear@personal", { name: "x" }, home),
    (error: Error) => error.message === pluginGone,
  );
});

test("a failed reinstall puts the old name, install and settings back", async () => {
  const { home, places } = personalHome([["linear", "Linear"]]);
  const state = {
    installed: new Set(["linear@personal"]),
    enabled: new Map([["linear@personal", false]]),
  };
  const { rpc, config } = fakeRuntime(home, state, "tracker");
  config["linear@personal"] = { enabled: false };
  const service = new PluginService(
    async () => rpc,
    () => home,
  );
  await assert.rejects(
    service.rename("linear@personal", { name: "tracker" }, home),
    /install refused/,
  );
  assert.equal(fs.existsSync(path.join(places.plugins, "linear")), true);
  assert.equal(fs.existsSync(path.join(places.plugins, "tracker")), false);
  assert.equal(marketOf(places.file).plugins[0].name, "linear");
  assert.equal(state.installed.has("linear@personal"), true);
  assert.equal(state.enabled.get("linear@personal"), false);
});

test("the dialog shows live's refusals and a plain failure otherwise", () => {
  assert.equal(
    renameFailureText(
      new Error(
        `Error invoking remote method 'renamePlugin': Error: ${pluginNameTaken}`,
      ),
    ),
    pluginNameTaken,
  );
  assert.equal(renameFailureText(new Error(pluginGone)), "gone");
  // Duplicate fails the same way: refusals as they are, else a plain sentence.
  assert.equal(
    duplicateFailureText(
      new Error(
        `Error invoking remote method 'duplicatePlugin': Error: ${pluginNameTaken}`,
      ),
    ),
    pluginNameTaken,
  );
  assert.equal(
    duplicateFailureText(
      new Error("Error invoking remote method 'duplicatePlugin': ENOENT: cp"),
    ),
    "Plugin duplicate failed. You can try again.",
  );
  assert.equal(
    renameFailureText(new Error("ENOENT: rename")),
    pluginRenameFailed,
  );
  const html = renderToStaticMarkup(
    createElement(PluginRenameDialog, {
      plugin: {
        id: "linear@personal",
        name: "linear",
        title: "Linear",
        marketplace: "personal",
        marketplacePath: "/m",
        installed: true,
        enabled: true,
        installable: true,
        source: "local",
        personal: true,
      },
      rename: async () => ({ id: "x", appsNeedingAuth: [] }),
      onRenamed: () => {},
      onClose: () => {},
    }),
  );
  assert.match(html, /Rename plugin/);
  assert.match(html, /value="Linear"/);
  assert.match(html, /aria-label="New plugin name"/);
  assert.match(html, /Saved as <b[^>]*>linear<\/b>/);
  // The unchanged name is refused only once the person has typed.
  assert.doesNotMatch(html, /different from the current one/);
  assert.match(html, /<button class="primary " disabled=""/);
});
