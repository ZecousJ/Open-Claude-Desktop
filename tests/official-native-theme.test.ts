import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { Store } from "../electron/store/store";

const handlers = new Map<string, (...args: any[]) => any>();
const nativeTheme = { themeSource: "dark" };
const state: any = { activeAccount: { id: "a" }, accountRetirement: { accountRetiring: false } };
let notifications = 0;
const noop = () => {};
const source = fs.readFileSync(new URL("../electron/app/ipc-register.ts", import.meta.url), "utf8");
const mocks: Record<string, Record<string, any>> = {};
for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
  const [, names, specifier] = match;
  if (specifier === "zod" || specifier.startsWith("node:")) continue;
  mocks[specifier] = Object.fromEntries(names.split(",").map((name) => name.trim()).filter((name) => name && !name.startsWith("type ")).map((name) => [name, noop]));
}
Object.assign(mocks.electron, { nativeTheme });
Object.assign(mocks["./main-state"], { mainState: state });
Object.assign(mocks["./ipc-handle"], { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) });
Object.assign(mocks["../main"], { nativeExtensions: { register: noop }, sendSettings: () => notifications++ });
(globalThis as any).__themeMocks = mocks;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/electron/app/ipc-register.ts") && mocks[specifier]) {
      const exports = Object.keys(mocks[specifier]).map((name) => `export const ${name}=m.${name};`).join("");
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(`const m=globalThis.__themeMocks[${JSON.stringify(specifier)}];${exports}`) };
    }
    return next(specifier, context);
  },
});
const { register } = await import("../electron/app/ipc-register");
register();
const save = handlers.get("saveOfficialThemeMode")!;

test("official theme saves only the current account and restores native appearance", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-theme-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  state.store = store;
  state.activeAccount = { id: "a" };
  state.accountRetirement.accountRetiring = false;
  notifications = 0;
  for (const mode of ["system", "light", "dark"] as const) {
    save(mode);
    assert.equal(store.settings.theme, mode);
    assert.equal(new Store(root).settings.theme, mode);
    assert.equal(nativeTheme.themeSource, mode);
  }
  assert.equal(notifications, 3);
  const write = t.mock.method(store, "write");
  nativeTheme.themeSource = "system";
  save("dark");
  assert.equal(nativeTheme.themeSource, "dark");
  assert.equal(write.mock.callCount(), 0);
  assert.equal(notifications, 3);
  assert.throws(() => save("invalid"));
  state.accountRetirement.accountRetiring = true;
  assert.throws(() => save("light"), /retired/);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(store.settings.theme, "dark");
  assert.equal(nativeTheme.themeSource, "dark");
  state.accountRetirement.accountRetiring = false;
  write.mock.mockImplementation(() => { throw Error("disk failure"); });
  assert.throws(() => save("system"), /disk failure/);
  assert.equal(store.settings.theme, "dark");
  assert.equal(new Store(root).settings.theme, "dark");
  assert.equal(nativeTheme.themeSource, "dark");
  assert.equal(notifications, 3);
});
