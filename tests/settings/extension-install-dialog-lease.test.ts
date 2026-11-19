/** Runs only dialog cancellation/retirement with inert manifest fixtures.
 * No extension is installed, enabled, imported as code, or executed. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { openPolicy } from "../../shared/client-policy";

let open: (...args: any[]) => Promise<any> = async () => ({
  canceled: true,
  filePaths: [],
});
let confirm: (...args: any[]) => Promise<any> = async () => ({ response: 1 });
(globalThis as any).__extensionLeaseElectron = {
  app: { on() {}, off() {}, getPath: () => os.tmpdir(), getVersion: () => "0.0.39" },
  dialog: {
    showOpenDialog: (...args: any[]) => open(...args),
    showMessageBox: (...args: any[]) => confirm(...args),
  },
  Menu: {},
  session: {},
  shell: {},
  globalShortcut: {},
  nativeImage: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  Tray: class {},
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  BrowserWindow: class {},
  ipcMain: {},
};
const exports = Object.keys((globalThis as any).__extensionLeaseElectron);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "const e=globalThis.__extensionLeaseElectron;" +
              exports
                .map((name) => `export const ${name}=e.${name};`)
                .join("") +
              "export default e;",
          ),
      };
    return next(specifier, context);
  },
});
const { registerSettingsDesktopHandlers } =
  await import("../../electron/ipc/settings-desktop");
function fixture(t: { after(fn: () => void): void }, publish?: (servers: Record<string, unknown>) => void) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "extension-dialog-inert-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "http://localhost/settings/extensions" },
  });
  const window = { isDestroyed: () => false, webContents };
  const retired: (() => void)[] = [],
    activated: (() => void)[] = [],
    handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let writes = 0;
  let maintenance: (() => Promise<() => void>) | undefined;
  const ctx = {
    activeAccount: { id: "owner" },
    store: {
      root,
      settings: { locale: "en-US", mcpServers: {} },
      conversations: [],
    },
    callerWindow: () => window,
    window,
    dataRoot: root,
    engine: {},
    policy: () => openPolicy,
    noActive() {},
    mcpConfig: {
      update() {
        writes++;
        throw Error("Installation must not occur in this test.");
      },
    },
    onAccountDeactivating(fn: () => void) {
      retired.push(fn);
    },
    onAccountActivated(fn: () => void) {
      activated.push(fn);
    },
  };
  registerSettingsDesktopHandlers(
    (name, fn) => handlers.set(name, fn),
    ctx as never,
    undefined,
    publish,
    () => maintenance!(),
  );
  return {
    root,
    ctx,
    window,
    setMaintenance(fn: () => Promise<() => void>) { maintenance = fn; },
    get writes() {
      return writes;
    },
    reactivation() {
      retired.forEach((fn) => fn());
      activated.forEach((fn) => fn());
    },
    run: (method: string, ...args: unknown[]) => handlers.get(method)!(...args),
  };
}

test("actual install handlers preserve OS-picker cancellation without reading or installing a source", async (t) => {
  const f = fixture(t);
  let calls = 0;
  open = async (window) => {
    assert.equal(window, f.window);
    calls++;
    return { canceled: true, filePaths: [] };
  };
  for (const method of ["installExtension", "installUnpackedExtension"])
    assert.equal(await f.run(method), null);
  assert.equal(calls, 2);
  assert.equal(f.writes, 0);
});

test("a previously selected folder reaches confirmation without another picker", async (t) => {
  const { pickedExtensionFolder } = await import("../../electron/connectors/extension-picked-folder");
  const f = fixture(t);
  const folder = path.join(f.root, "extension");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({ name: "inert-test", server: { mcp_config: { command: "DO_NOT_EXECUTE" } } }));
  let picks = 0, confirmations = 0;
  open = async () => { picks++; throw Error("Unexpected picker"); };
  confirm = async () => { confirmations++; return { response: 1 }; };
  await assert.rejects(f.run("installUnpackedExtension", {}), /Choose/);
  assert.equal(await f.run("installUnpackedExtension", pickedExtensionFolder(folder)), null);
  assert.equal(picks, 0);
  assert.equal(confirmations, 1);
  assert.equal(f.writes, 0);
});

test("actual install handlers reject same-store reactivation during the picker", async (t) => {
  for (const method of ["installExtension", "installUnpackedExtension"]) {
    const f = fixture(t);
    open = async () => {
      f.reactivation();
      return {
        canceled: false,
        filePaths: [path.join(f.root, "must-not-read.mcpb")],
      };
    };
    await assert.rejects(f.run(method));
    assert.equal(f.writes, 0);
  }
});

test("actual install handler final confirmation cannot commit after same-page navigation", async (t) => {
  for (const method of ["installExtension", "installUnpackedExtension"]) {
    const f = fixture(t),
      folder = path.join(f.root, "inert-folder");
    fs.mkdirSync(folder);
    const manifest = JSON.stringify({
      name: "inert-test",
      server: { mcp_config: { command: "DO_NOT_EXECUTE" } },
    });
    fs.writeFileSync(path.join(folder, "manifest.json"), manifest);
    const zip = new JSZip();
    zip.file("manifest.json", manifest);
    const archive = path.join(f.root, "inert.mcpb");
    fs.writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer" }));
    open = async () => ({
      canceled: false,
      filePaths: [method === "installExtension" ? archive : folder],
    });
    confirm = async () => {
      f.window.webContents.emit(
        "did-navigate-in-page",
        {},
        f.window.webContents.mainFrame.url,
        true,
      );
      return { response: 0 };
    };
    await assert.rejects(f.run(method));
    assert.equal(f.writes, 0);
    assert.equal(fs.existsSync(path.join(f.root, "desktop-extensions")), false);
  }
});

test("actual archive confirmation Cancel never installs its inert selection", async (t) => {
  const f = fixture(t);
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({
      name: "cancel-test",
      server: { mcp_config: { command: "DO_NOT_EXECUTE" } },
    }),
  );
  const archive = path.join(f.root, "cancel.mcpb");
  fs.writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer" }));
  open = async () => ({ canceled: false, filePaths: [archive] });
  confirm = async (_window, options) => {
    assert.equal(options.defaultId, 1);
    assert.equal(options.cancelId, 1);
    assert.equal(options.detail, "This desktop extension will be installed on your computer and made available to Claudex.");
    return { response: 1 };
  };
  assert.equal(await f.run("installExtension"), null);
  assert.equal(f.writes, 0);
  assert.equal(fs.existsSync(path.join(f.root, "desktop-extensions")), false);
});

test("UV install confirmation keeps the original message when no exact translation exists", async (t) => {
  const f = fixture(t);
  f.ctx.store.settings.locale = "zh-CN";
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ name: "uv-test", server: { type: "uv", mcp_config: { command: "uv" } } }));
  const archive = path.join(f.root, "uv.mcpb");
  fs.writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer" }));
  open = async () => ({ canceled: false, filePaths: [archive] });
  confirm = async (_window, options) => {
    assert.equal(options.detail, "This desktop extension will be installed on your computer. In order to install this extension we need to fetch a few dependencies. This may take a few minutes.");
    return { response: 1 };
  };
  assert.equal(await f.run("installExtension"), null);
});

test("native compatibility uses detected runtimes and original requirement states", async () => {
  const { registerExtensions } = await import("../../electron/official-ui/native/extensions");
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const host = {
    ctx: {
      settings: () => ({ extensionBuiltInNode: false }),
      call: async (method: string) => {
        assert.equal(method, "extensionTools");
        return [
          { name: "Node.js", versions: ["v20.11.0"], builtInVersion: "22.0.0" },
          { name: "Python", versions: [], builtInVersion: null },
        ];
      },
    },
    answer(value: unknown, ...names: string[]) {
      for (const name of names) handlers.set(name, () => value);
      return this;
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
      return this;
    },
  };
  registerExtensions(host as never);
  const check = handlers.get("Extensions.getManifestCompatibilityResult")!;
  const outcome = await check({
    manifest_version: "0.4",
    server: { type: "node", mcp_config: { command: "node" } },
    compatibility: { platforms: [process.platform], runtimes: { node: ">=22" } },
  }) as { compatible: boolean; requirements: { name: string; met: boolean }[] };
  assert.equal(outcome.compatible, false);
  assert.equal(outcome.requirements.find(item => item.name === "Node.js >=22")?.met, false);
  assert.equal(outcome.requirements.find(item => item.name === "an update to Claude Desktop")?.met, true);
});

test("local MCP status and log actions expose the actual server state and captured output", async (t) => {
  const { registerExtensions } =
    await import("../../electron/official-ui/native/extensions");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-mcp-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opened: string[] = [];
  (globalThis as any).__extensionLeaseElectron.shell.openPath = async (
    file: string,
  ) => {
    opened.push(file);
    return "";
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  let serverState = "stopped";
  const settings: {
    mcpServers: Record<string, { command: string; enabled?: boolean }>;
  } = {
    mcpServers: {
      demo: { command: "node" },
      off: { command: "node", enabled: false },
    },
  };
  let saved: any;
  const configFile = path.join(root, "mcp-config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({ mcpServers: settings.mcpServers }),
  );
  const host = {
    ctx: {
      settings: () => settings,
      stateDirectory: () => root,
      localCall: async (name: string, input: unknown) => {
        assert.equal(name, "removeConnector");
        assert.equal(input, "demo");
        delete settings.mcpServers.demo;
        fs.writeFileSync(
          configFile,
          JSON.stringify({ mcpServers: settings.mcpServers }),
        );
      },
      call: async (name: string, input: unknown) => {
        if (name === "mcpServers")
          return { servers: [{ name: "demo", state: serverState }] };
        if (name === "readMcpLogs")
          return {
            name: "demo",
            lines: ["connection stopped"],
            serverOutput: {
              availability: "available",
              lines: ["stderr redacted"],
            },
          };
        if (name === "saveSettings") {
          saved = input;
          return;
        }
        throw Error("Unexpected call");
      },
    },
    answer() {
      return this;
    },
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
      return this;
    },
    emit() {},
  };
  registerExtensions(host as never);
  const state = await handlers.get("MCP.getMcpServersConfigWithStatus")!();
  assert.equal(state.demo.status, "initializing");
  assert.equal(state.demo.error, undefined);
  assert.equal(state.off, undefined);
  await handlers.get("MCP.setMcpServerConfigs")!({ demo: { command: "node" } });
  assert.deepEqual(saved.mcpServers.off, settings.mcpServers.off);
  serverState = "disabled";
  assert.equal(
    (await handlers.get("MCP.getMcpServersConfigWithStatus")!()).demo.status,
    "initializing",
  );
  await handlers.get("MCP.revealServerLog")!("demo");
  assert.equal(
    fs.readFileSync(opened[0], "utf8"),
    "connection stopped\nstderr redacted\n",
  );
  await handlers.get("MCP.revealLogs")!();
  assert.equal(opened[1], path.dirname(opened[0]));
  await handlers.get("MCP.setMcpServerConfigs")!({});
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")).mcpServers, {
    off: { command: "node", enabled: false },
  });
});

test("installing an updated archive waits for MCP shutdown and retains the owned package", async (t) => {
  const f = fixture(t);
  const { installUnpackedExtension } = await import("../../electron/connectors/desktop-extension");
  const folder = path.join(f.root, "original");
  fs.mkdirSync(folder);
  const manifest = {
    name: "upgrade-test",
    version: "1.0.0",
    server: { mcp_config: { command: "node", args: ["${__dirname}/server.js"] } },
  };
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(folder, "server.js"), "version one");
  const ctx = f.ctx as any;
  installUnpackedExtension({
    source: folder, root: f.root, allowed: () => true, current: {},
    update: (servers) => { ctx.store.settings.mcpServers = servers; },
  });
  const original = ctx.store.settings.mcpServers["upgrade-test"].claudex_extension;
  manifest.version = "2.0.0";
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("server.js", "version two");
  const archive = path.join(f.root, "upgrade.mcpb");
  fs.writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer" }));
  let busy = false;
  let stoppedWhileBusy = false;
  f.setMaintenance(async () => {
    if (busy) throw Error("Wait for the current task to finish");
    stoppedWhileBusy = true;
    return () => {};
  });
  open = async () => ({ canceled: false, filePaths: [archive] });
  confirm = async () => { busy = true; return { response: 0 }; };
  await assert.rejects(f.run("installExtension"));
  assert.equal(stoppedWhileBusy, false);
  assert.equal(ctx.store.settings.mcpServers["upgrade-test"].claudex_extension, original);
  busy = false;
  let release!: () => void;
  let entered = false;
  const stopping = new Promise<void>(resolve => { release = resolve; });
  f.setMaintenance(async () => { entered = true; await stopping; return () => {}; });
  ctx.mcpConfig.update = (servers: unknown) => { ctx.store.settings.mcpServers = servers; };
  open = async () => ({ canceled: false, filePaths: [archive] });
  confirm = async () => ({ response: 0 });
  const operation = f.run("installExtension");
  for (let n = 0; n < 50 && !entered; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(entered, true);
  assert.equal(fs.readFileSync(path.join(original, "server.js"), "utf8"), "version one");
  release();
  assert.equal(await operation, "upgrade-test");
  assert.notEqual(ctx.store.settings.mcpServers["upgrade-test"].claudex_extension, original);
  assert.equal(fs.readFileSync(path.join(original, "server.js"), "utf8"), "version one");
  assert.equal(fs.readFileSync(path.join(ctx.store.settings.mcpServers["upgrade-test"].claudex_extension, "server.js"), "utf8"), "version two");
});

test("a same-named extension from another author does not stop running MCP services", async (t) => {
  const f = fixture(t);
  const { installUnpackedExtension } = await import("../../electron/connectors/desktop-extension");
  const folder = path.join(f.root, "first-author");
  fs.mkdirSync(folder);
  const manifest = { name: "shared-name", version: "1", author: { name: "First" }, server: { mcp_config: { command: "node" } } };
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest));
  const ctx = f.ctx as any;
  installUnpackedExtension({ source: folder, root: f.root, allowed: () => true, current: {}, update: servers => { ctx.store.settings.mcpServers = servers; } });
  manifest.author.name = "Second";
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  const archive = path.join(f.root, "second.mcpb");
  fs.writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer" }));
  f.setMaintenance(async () => { throw Error("a new extension must not stop services"); });
  ctx.mcpConfig.update = (servers: unknown) => { ctx.store.settings.mcpServers = servers; };
  open = async () => ({ canceled: false, filePaths: [archive] });
  confirm = async () => ({ response: 0 });
  assert.equal(await f.run("installExtension"), "shared-name_2");
  assert.equal(Object.keys(ctx.store.settings.mcpServers).length, 2);
});

test("extension runtime settings show the detected Node and Python versions", async () => {
  const { registerExtensions } = await import("../../electron/official-ui/native/extensions");
  const handlers = new Map<string, (...args: any[]) => any>();
  const detected = [
    { name: "Node.js", versions: ["v22.0.0"], builtInVersion: "20.0.0" },
    { name: "Python", versions: ["Python 3.12.0"], builtInVersion: null },
  ];
  const calls: string[] = [];
  const host = {
    ctx: { call: async (method: string) => { calls.push(method); return detected; } },
    answer(value: unknown, ...names: string[]) {
      for (const name of names) handlers.set(name, () => value);
      return this;
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
      return this;
    },
  };
  registerExtensions(host as never);
  assert.deepEqual(await handlers.get("Extensions.getAvailableExtensionRuntimes")!(), [
    { name: "Node.js", versions: ["22.0.0"], builtInVersion: "20.0.0" },
    { name: "Python", versions: ["3.12.0"], builtInVersion: null },
  ]);
  assert.deepEqual(calls, ["extensionTools"]);
});

test("original extension settings submit multiple selected paths to the native lifecycle", async () => {
  const { registerExtensions } = await import("../../electron/official-ui/native/extensions");
  const handlers = new Map<string, (...args: any[]) => any>();
  const saved: unknown[] = [];
  const host = {
    ctx: {
      account: () => ({ id: "owner" }),
      sessionIdentity: () => "owner",
      settings: () => ({ mcpServers: { fixture: { command: "node" } } }),
      call: async (method: string, value: unknown) => {
        if (method === "desktopExtension") return { revision: "revision", values: {} };
        if (method === "saveDesktopExtension") {
          saved.push(value);
          return { id: "fixture", name: "Fixture", enabled: true, values: {} };
        }
        throw Error("unexpected call");
      },
    },
    answer(value: unknown, ...names: string[]) {
      for (const name of names) handlers.set(name, () => value);
      return this;
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
      return this;
    },
    emit() {},
  };
  registerExtensions(host as never);
  await handlers.get("Extensions.setExtensionSettings")!("fixture", {
    isEnabled: true,
    userConfig: { directories: ["/first", "/second"] },
  });
  assert.deepEqual(saved, [{
    id: "fixture", revision: "revision", enabled: true,
    values: { directories: ["/first", "/second"] },
  }]);
});

test("extension controls follow the current local installation policy", async () => {
  const { registerExtensions } = await import("../../electron/official-ui/native/extensions");
  const handlers = new Map<string, (...args: any[]) => any>();
  let current = { ...openPolicy };
  const host = {
    ctx: { call: async (method: string) => {
      assert.equal(method, "clientPolicy");
      return current;
    } },
    answer(value: unknown, ...names: string[]) {
      for (const name of names) handlers.set(name, () => value);
      return this;
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
      return this;
    },
  };
  registerExtensions(host as never);
  assert.equal(await handlers.get("Extensions.isExtensionsEnabled")!(), true);
  assert.equal(await handlers.get("Extensions.isLocalExtensionInstallAllowed")!(), true);
  assert.equal(handlers.get("Extensions.isDirectoryEnabled")!(), false);
  for (const operation of ["getDirectoryUrl", "getExtension", "getExtensionVersions", "installDxtFromDirectory"]) {
    assert.throws(() => handlers.get(`Extensions.${operation}`)!(), /extension directory has been disabled/);
  }
  current = { ...current, localMcpEditing: false };
  assert.equal(await handlers.get("Extensions.isLocalExtensionInstallAllowed")!(), false);
  current = { ...current, desktopExtensionsEnabled: false };
  assert.equal(await handlers.get("Extensions.isExtensionsEnabled")!(), false);
});

test("original extension settings and delete use the mapped installed server", async () => {
  const { registerExtensions } = await import("../../electron/official-ui/native/extensions");
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: unknown[][] = [];
  const calls: unknown[][] = [];
  const identity = {};
  const host = {
    ctx: {
      account: () => ({ id: "owner" }),
      sessionIdentity: () => identity,
      settings: () => ({ mcpServers: { internal: { claudex_extension_id: "local.mcpb.author.name" } } }),
      call: async (...args: unknown[]) => {
        calls.push(args);
        if (args[0] === "desktopExtension") return { revision: "revision", values: {} };
        if (args[0] === "saveDesktopExtension") {
          return {
            id: "internal", name: "Fixture", enabled: true,
            values: { folder: "/tmp" }, savedSecrets: ["token"],
          };
        }
      },
    },
    answer(value: unknown, ...names: string[]) {
      for (const name of names) handlers.set(name, () => value);
      return this;
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
      return this;
    },
    emit: (...args: unknown[]) => { events.push(args); },
  };
  registerExtensions(host as never);
  await handlers.get("Extensions.setExtensionSettings")!("local.mcpb.author.name", { isEnabled: true, userConfig: { folder: "/tmp", token: "test-only" } });
  await handlers.get("Extensions.deleteExtension")!("local.mcpb.author.name");
  assert.deepEqual(calls, [
    ["desktopExtension", "internal"],
    ["saveDesktopExtension", { id: "internal", revision: "revision", enabled: true, values: { folder: "/tmp", token: "test-only" } }],
    ["desktopExtension", "internal"],
    ["uninstallDesktopExtension", { id: "internal", revision: "revision" }],
  ]);
  assert.deepEqual(events[0], ["Extensions", "extensionSettingsChanged", "local.mcpb.author.name",
    { isEnabled: true, userConfig: { folder: "/tmp" }, savedSecrets: ["token"] }]);
});

test("archive installation uses the native extension publisher rather than the settings shortcut path", async (t) => {
  let published: Record<string, unknown> | undefined;
  const f = fixture(t, servers => { published = servers; });
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    name: "publisher-test", version: "1.0.0",
    server: { type: "node", mcp_config: { command: "node" } },
  }));
  const archive = path.join(f.root, "publish.mcpb");
  fs.writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer" }));
  open = async () => ({ canceled: false, filePaths: [archive] });
  confirm = async () => ({ response: 0 });
  assert.equal(await f.run("installExtension"), "publisher-test");
  assert.equal(f.writes, 0);
  assert.equal(typeof (published?.["publisher-test"] as { claudex_extension?: unknown })?.claudex_extension, "string");
});

test("original extension actions preview the selected archive and install its official identity", async (t) => {
  const { registerExtensions } = await import("../../electron/official-ui/native/extensions");
  const f = fixture(t);
  const zip = new JSZip();
  const manifest = {
    name: "sample", version: "1.0.0", author: { name: "Example" },
    server: { type: "node", mcp_config: { command: "node" } },
  };
  zip.file("manifest.json", JSON.stringify(manifest));
  const archive = path.join(f.root, "sample.mcpb");
  fs.writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer" }));
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: unknown[][] = [];
  const identity = {};
  const host = {
    caller: f.window,
    ctx: {
      account: () => ({ id: "owner" }), sessionIdentity: () => identity,
      settings: () => ({ locale: "en-US", mcpServers: {} }),
      call: async (method: string) => {
        assert.equal(method, "clientPolicy");
        return openPolicy;
      },
      withCallerWindow: (_window: object, action: () => unknown) => action(),
      localCall: async (method: string) => { assert.equal(method, "installExtension"); return "sample"; },
    },
    answer(value: unknown, ...names: string[]) { for (const name of names) handlers.set(name, () => value); return this; },
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); return this; },
    emit: (...args: unknown[]) => { events.push(args); },
    emitTo: (...args: unknown[]) => { events.push(args); },
  };
  open = async () => ({ canceled: false, filePaths: [archive] });
  registerExtensions(host as never);
  await handlers.get("Extensions.showInstallDxtDialog")!();
  assert.deepEqual(events[0], [f.window, "Extensions", "previewExtensionInstallation", manifest, archive, "local.mcpb.example.sample", null]);
  assert.equal(await handlers.get("Extensions.installExtensionFromPreview")!("local.mcpb.example.sample", archive), "local.mcpb.example.sample");
  assert.deepEqual(events[1], ["Extensions", "extensionsChanged"]);
});

test("a failed preview installation shows the original native error dialog", async (t) => {
  const { registerExtensions } = await import("../../electron/official-ui/native/extensions");
  const f = fixture(t);
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    name: "sample", version: "1.0.0", author: { name: "Example" },
    server: { type: "node", mcp_config: { command: "node" } },
  }));
  const archive = path.join(f.root, "sample.mcpb");
  fs.writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer" }));
  const handlers = new Map<string, (...args: any[]) => any>();
  const identity = {};
  let shown: any;
  const host = {
    caller: f.window,
    ctx: {
      account: () => ({ id: "owner" }), sessionIdentity: () => identity,
      settings: () => ({ locale: "en-US", mcpServers: {} }),
      call: async () => openPolicy,
      withCallerWindow: (_window: object, action: () => unknown) => action(),
      localCall: async () => { throw Error("fixture failure"); },
    },
    answer(value: unknown, ...names: string[]) { for (const name of names) handlers.set(name, () => value); return this; },
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); return this; },
    emit() {}, emitTo() {},
  };
  open = async () => ({ canceled: false, filePaths: [archive] });
  confirm = async (_window, options) => { shown = options; return { response: 0 }; };
  registerExtensions(host as never);
  await handlers.get("Extensions.showInstallDxtDialog")!();
  assert.equal(await handlers.get("Extensions.installExtensionFromPreview")!("local.mcpb.example.sample", archive), null);
  assert.equal(shown.title, "Extension installation failed");
  assert.equal(shown.message, "Couldn't install extension");
  assert.match(shown.detail, /fixture failure/);
});
