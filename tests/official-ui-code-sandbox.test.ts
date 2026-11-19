import test from "node:test";
import assert from "node:assert/strict";
import { registerCodeSandbox } from "../electron/official-ui/native/code-sandbox";
import type { NativeHost } from "../electron/official-ui/native/host";

test("Code sandbox settings follow the active account and report unavailable hosts", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let owner = "one";
  let identity = {};
  let settings: Record<string, unknown> = {};
  let runtime = { available: true, policyLocked: false, windowsInstalled: true };
  const events: string[] = [];
  let listener = (_event: { type: string }) => {};
  const host = {
    ctx: {
      account: () => ({ id: owner }), sessionIdentity: () => identity, isCurrent: () => true,
      settings: () => settings, codeLocalSandboxState: () => runtime,
      localCall: async (method: string, value: unknown) => {
        assert.equal(method, "saveSettings");
        settings = value as Record<string, unknown>;
        listener({ type: "settings" });
      },
      onEvent: (fn: typeof listener) => { listener = fn; return () => {}; },
    },
    on(name: string, fn: (...args: unknown[]) => unknown) { handlers.set(name, fn); return host; },
    emit(domain: string, event: string) { events.push(`${domain}.${event}`); },
  };
  registerCodeSandbox(host as unknown as NativeHost);
  const call = (name: string, ...args: unknown[]) => handlers.get(`ClaudeCode.${name}`)!(...args);
  assert.deepEqual(call("resolveLocalSettings"), {
    outputStyle: { value: "", source: "user" },
    sandboxEnabled: { value: true, source: "user" }, strictSandboxMode: { value: false, source: "user" },
  });
  assert.equal(await call("patchUserSettings", { outputStyle: "Explanatory" }), true);
  assert.equal(settings.codeOutputStyle, "Explanatory");
  assert.equal(await call("patchUserSettings", { outputStyle: "Custom" }), false);
  assert.equal(await call("patchUserSettings", { outputStyle: "Learning", other: true }), false);
  assert.equal(await call("patchUserSettings", {}), false);
  assert.equal(settings.codeOutputStyle, "Explanatory");
  assert.equal(await call("patchUserSettings", { outputStyle: undefined }), true);
  assert.equal(settings.codeOutputStyle, "");
  assert.deepEqual(await call("setStrictSandboxMode", true), { status: "ok" });
  assert.equal(settings.codeStrictSandbox, true);
  assert.deepEqual(events, Array(3).fill("ClaudeCode.resolvedSettingsChanged"));
  assert.equal((await call("setStrictSandboxMode", true, "session") as { status: string }).status, "unavailable");
  assert.deepEqual(await call("setLocalSandboxEnabled", false), { status: "ok" });
  assert.equal((await call("setStrictSandboxMode", true) as { status: string }).status, "unavailable");
  runtime = { ...runtime, policyLocked: true };
  assert.deepEqual(call("resolveLocalSettings"), { outputStyle: { value: "", source: "user" } });
  assert.equal((call("getLocalSandboxStatus") as { enabled: boolean }).enabled, false);
  assert.equal((await call("setLocalSandboxEnabled", true) as { status: string }).status, "unavailable");
  owner = "two"; identity = {}; settings = {};
  runtime = { ...runtime, policyLocked: false };
  assert.equal((call("getLocalSandboxStatus") as { enabled: boolean }).enabled, true);
});

test("Windows setup is checked again before saving, including after account change", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let identity = {};
  let ready = false;
  let finish!: (value: unknown) => void;
  let saves = 0;
  const host = {
    ctx: {
      account: () => ({ id: "one" }), sessionIdentity: () => identity, isCurrent: () => true,
      settings: () => ({}), codeLocalSandboxState: () => ({ available: true, policyLocked: false, windowsInstalled: ready }),
      localCall: async (method: string) => {
        if (method === "setupWindowsSandbox") return new Promise(resolve => { finish = resolve; });
        saves++; return undefined;
      },
      onEvent: () => () => {},
    },
    on(name: string, fn: (...args: unknown[]) => unknown) { handlers.set(name, fn); return host; },
    emit() {},
  };
  registerCodeSandbox(host as unknown as NativeHost);
  const write = handlers.get("ClaudeCode.setLocalSandboxEnabled")!;
  const pending = write(true) as Promise<unknown>;
  identity = {}; ready = true; finish({ ready: true, message: "ready" });
  await assert.rejects(pending, /account changed/);
  assert.equal(saves, 0);
});
