import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { z } from "zod";
import { registerResources } from "../electron/official-ui/native/resources";
import { applySshSettingsPolicy, readSshSettings } from "../electron/ssh/settings";
import { openPolicy } from "../shared/client-policy";

const original = fs.readFileSync(
  ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1/shared-m-8-CVxtIISM.js", "utf8",
);
function section(start: string, end: string) {
  const from = original.indexOf(start), to = original.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return original.slice(from, to);
}

test("original SSH settings query consumes the model and settles with current permission policy", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let policy = openPolicy;
  const remoteSettings = await readSshSettings(async () => Buffer.from(
    JSON.stringify({
      permissions: { defaultMode: "plan" },
      model: "gpt-5.2-codex",
      availableModels: ["foreign-model"],
      fastMode: true,
    }),
  ), "/remote");
  const calls: unknown[][] = [];
  registerResources({
    ctx: {
      account: () => ({ id: "account" }),
      localCall: async (name: string, ...args: unknown[]) => {
        calls.push([name, ...args]);
        if (name === "officialSshTarget") return { kind: "ssh", hostId: "selected-host" };
        assert.equal(name, "officialResolveSshSettings");
        return applySshSettingsPolicy(remoteSettings, policy);
      },
    },
    on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  } as never);
  let query: any, data: any;
  const context: any = {
    JN: z.union, it: z.object, fTC: z.string, FP: z.lazy, Ws: z.array, zI: z.boolean, NE: z.record,
    $tk: z.enum(["low", "medium", "high", "xhigh"]),
    dq: { warn: () => assert.fail("settings failed the original renderer schema") }, Sp: { LOCAL_SESSION: "test" },
    OC: {}, pi: { resolveSSHSettings: handlers.get("LocalSessions.resolveSSHSettings") },
    J9: () => [], yK: () => false, IPA: () => true, Bb: () => true, Qg: () => false,
    TQ6: (current: unknown) => ({ current }), rI: () => false, dB1: () => true,
    Es: (options: unknown) => { query = options; return { data, isError: false, refetch: async () => {} }; },
  };
  for (let index = 0; index <= 5; index++) {
    context[`J${index}`] = () => true;
    context[`K${index}`] = (...args: unknown[]) => args.at(-1);
  }
  vm.createContext(context);
  vm.runInContext(section("function sx(e)", "function _L()"), context);
  const config = { workspacePath: "/remote/work", sshConfig: { sshHost: "user@host", sshPort: 2222, sshIdentityFile: "/keys/selected" } };
  assert.equal(context.kh0(config).configSettled, false);
  const client = { getQueryData: () => undefined, getQueryState: () => undefined };
  data = await query.queryFn({ client, queryKey: query.queryKey });
  let state = context.kh0(config);
  assert.equal(state.configSettled, true);
  assert.equal(state.desktopResolvesDisableModes, true);
  assert.equal(state.config.defaultPermissionMode.value, "plan");
  assert.equal(state.config.disableAutoMode, undefined);
  assert.deepEqual(structuredClone(state.config.model), {
    value: "gpt-5.2-codex", source: "user", path: "/remote/.claude/settings.json",
  });
  assert.equal(state.config.availableModels, undefined);
  assert.equal(state.config.fastMode, undefined);
  assert.deepEqual(structuredClone(calls[0]), ["officialSshTarget", config.sshConfig]);
  assert.deepEqual(structuredClone(calls[1]), ["officialResolveSshSettings", "selected-host", "/remote/work", { boundedManagedSettingsWait: true }]);
  policy = { ...openPolicy, permissionModes: ["manual"] };
  data = await query.queryFn({ client, queryKey: query.queryKey });
  state = context.kh0(config);
  assert.equal(state.configSettled, true);
  assert.equal(state.config.defaultPermissionMode, undefined);
  assert.equal(state.config.disableAutoMode.value, "disable");
  assert.equal(state.config.disableBypassPermissionsMode, undefined);
});

test("SSH trust waits for the connection before returning the saved workspace grant", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  let connected!: () => void;
  const connection = new Promise<void>(resolve => { connected = resolve; });
  let checking!: () => void;
  const started = new Promise<void>(resolve => { checking = resolve; });
  registerResources({
    ctx: {
      account: () => ({ id: "account" }),
      localCall: async (name: string, ...args: unknown[]) => {
        calls.push([name, ...args]);
        if (name === "officialSshTarget") return { kind: "ssh", hostId: "selected-host" };
        if (name === "sshStatus") return { state: "connecting" };
        if (name === "checkWorkspaceTrust") {
          checking();
          await connection;
          return { trusted: true, folder: "/work", root: "/work", sources: [] };
        }
        assert.equal(name, "sshChooseFolder");
      },
    },
    on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  } as never);
  let settled = false;
  const trust = Promise.resolve(handlers.get("LocalSessions.checkRemoteTrust")!({ sshHost: "user@host" }, "/work"))
    .then(result => { settled = true; return result; });
  await Promise.race([started, trust.then(() => assert.fail("trust settled before the connection"))]);
  assert.equal(settled, false);
  connected();
  assert.deepEqual(await trust, { trusted: true, folder: "/work", root: "/work", sources: [] });
  assert.deepEqual(calls.slice(1), [
    ["checkWorkspaceTrust", "/work", { kind: "ssh", hostId: "selected-host" }, false],
    ["sshChooseFolder", "selected-host", "/work"],
  ]);
});
