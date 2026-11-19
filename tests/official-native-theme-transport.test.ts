import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";

const handlers = new Map<string, Function>();
const owners = new Map<object, any>();
const noop = () => {};
const electron = {
  BrowserWindow: { fromWebContents: (contents: object) => owners.get(contents) },
  ipcMain: { handle: (key: string, fn: Function) => handlers.set(key, fn), removeHandler: (key: string) => handlers.delete(key), on: noop, removeListener: noop },
  app: { getPath: os.homedir }, dialog: {}, Menu: {}, MessageChannelMain: class {},
  nativeTheme: {}, powerMonitor: {}, screen: {}, shell: {}, systemPreferences: {},
};
const source = fs.readFileSync(new URL("../electron/official-ui/native/index.ts", import.meta.url), "utf8");
const mocks: Record<string, Record<string, any>> = {};
for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
  const [, names, specifier] = match;
  if (["electron", "./host", "../../app/caption-overlay", "../../app/official-startup-shell"].includes(specifier)) continue;
  mocks[specifier] = Object.fromEntries(names.split(",").map((name) => name.trim()).filter((name) => name && !name.startsWith("type ")).map((name) => [name, () => noop]));
}
mocks["./preferences"].registerPreferences = () => ({ dispose: noop });
mocks["./support-bundle"].registerSupportBundle = () => ({ dispose: noop });
(globalThis as any).__themeTransportMocks = mocks;
(globalThis as any).__themeTransportElectron = electron;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(`const e=globalThis.__themeTransportElectron;${Object.keys(electron).map((name) => `export const ${name}=e.${name};`).join("")}`) };
    if (context.parentURL?.endsWith("/electron/official-ui/native/index.ts") && mocks[specifier]) {
      const exports = Object.keys(mocks[specifier]).map((name) => `export const ${name}=m.${name};`).join("");
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(`const m=globalThis.__themeTransportMocks[${JSON.stringify(specifier)}];${exports}`) };
    }
    return next(specifier, context);
  },
});
const { createNativeHost } = await import("../electron/official-ui/native/index");

test("Windows captions expose the page behind each window's themed symbols", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caption-ipc-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw Error("Missing process platform");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "data"));
  const origin = "http://fixture.invalid";
  const channel = "prefix_$_claude.web_$_WindowControl_$_reportBootPlaceholderColors";
  fs.writeFileSync(path.join(root, "data/native-ipc-contract.json"), JSON.stringify({ invokes: [{ channel }], sync: [] }));
  const ctx: any = { root, account: () => ({ id: "a" }), sessionIdentity: () => "a1",
    settings: () => ({ mcpServers: {} }), onEvent: () => noop, log: noop };
  const native = createNativeHost(origin, ctx, {});
  t.after(() => native.dispose());
  const attach = (id: number) => {
    const overlays: unknown[] = [];
    const mainFrame = { url: origin + "/epitaxy" };
    const contents = Object.assign(new EventEmitter(), { id, mainFrame, send: noop, isDestroyed: () => false });
    const window: any = Object.assign(new EventEmitter(), {
      id, webContents: contents, isDestroyed: () => false, isFocused: () => false,
      setTitleBarOverlay: (overlay: unknown) => overlays.push(overlay),
    });
    owners.set(contents, window);
    t.after(() => { owners.delete(contents); });
    native.host.attach(window);
    return { overlays, event: { sender: contents, senderFrame: mainFrame } };
  };
  const primary = attach(1);
  const extra = attach(2);
  const report = handlers.get(channel)!;
  await report(primary.event, { dark: false, page: { red: 250, green: 249, blue: 245, alpha: 1 } });
  await report(extra.event, { dark: true, page: { red: 27, green: 27, blue: 28, alpha: 1 } });
  await report(primary.event, { dark: true, page: { red: 20, green: 21, blue: 22, alpha: 1 } });
  assert.deepEqual(primary.overlays, [
    { color: "#00000000", symbolColor: "#141413", height: 36 },
    { color: "#00000000", symbolColor: "#f0efec", height: 36 },
  ]);
  assert.deepEqual(extra.overlays, [{ color: "#00000000", symbolColor: "#f0efec", height: 36 }]);
});

test("official WindowControl IPC forwards the exact theme mode and rejects a retired window", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "theme-ipc-"));
  fs.mkdirSync(path.join(root, "data"));
  const channel = "prefix_$_claude.web_$_WindowControl_$_setThemeMode";
  fs.writeFileSync(path.join(root, "data/native-ipc-contract.json"), JSON.stringify({ invokes: [{ channel }], sync: [] }));
  const calls: unknown[][] = [];
  const ctx: any = { root, account: () => ({ id: "a" }), sessionIdentity: () => "a1", isCurrent: () => true,
    settings: () => ({ mcpServers: {} }), onEvent: () => noop, log: noop,
    localCall: async (...args: unknown[]) => { calls.push(args); } };
  const native = createNativeHost("http://fixture.invalid", ctx, {});
  t.after(() => { native.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const window: any = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => false });
  window.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: "http://fixture.invalid/new" }, send: noop, isDestroyed: () => false });
  owners.set(window.webContents, window);
  let current = true;
  native.host.attach(window, { origin: "http://fixture.invalid", current: () => current });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  for (const mode of ["system", "light", "dark"]) await handlers.get(channel)!(event, mode);
  assert.deepEqual(calls, [["saveOfficialThemeMode", "system"], ["saveOfficialThemeMode", "light"], ["saveOfficialThemeMode", "dark"]]);
  current = false;
  assert.throws(() => handlers.get(channel)!(event, "system"), /Untrusted IPC sender/);
  assert.equal(calls.length, 3);
});
