import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { environmentChangeRefusal } from "../electron/official-ui/native/environment-preflight";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
const conversation = (): any => ({ id: "c", mode: "code", cwd: "/old", turns: [], createdAt: 1, updatedAt: 1 });
test("environment preflight rejects unsupported identity, context and invalid paths without filesystem access", () => {
  for (const patch of [{ mode: "cowork" }, { cloudHosted: true }, { cloudEnvironmentId: "remote" }, { incognito: true },
    { sessionAuthors: { ownerAccountUuid: "a", viewerAccountUuid: "b" } }])
    assert.equal(environmentChangeRefusal({ ...conversation(), ...patch }, "local_c", "/new")?.reason, "unsupported_session");
  assert.equal(environmentChangeRefusal({ ...conversation(), archived: true }, "local_c", "/new")?.reason, "not_active");
  assert.equal(environmentChangeRefusal({ ...conversation(), id: "wrong" }, "local_c", "/new")?.reason, "not_active");
  assert.equal(environmentChangeRefusal({ ...conversation(), worktree: {} }, "local_c", "/new")?.reason, "worktree_unsupported");
  assert.equal(environmentChangeRefusal({ ...conversation(), environment: { kind: "ssh" } }, "local_c", "/new")?.reason, "ssh_unsupported");
  assert.equal(environmentChangeRefusal({ ...conversation(), turns: [{ status: "inProgress" }] }, "local_c", "/new")?.reason, "busy");
  for (const cwd of ["relative", "\0", 42, "/bad\nname"])
    assert.equal(environmentChangeRefusal(conversation(), "local_c", cwd)?.reason, "invalid_directory");
  assert.equal(environmentChangeRefusal(conversation(), "local_c", "/new"), undefined);
});
test("native Environment refuses archived, worktree, remote and foreign sessions before invoking trust services", async () => {
  for (const patch of [{ archived: true }, { worktree: {} }, { incognito: true },
    { cloudHosted: true }, { environment: { kind: "ssh" } },
    { sessionAuthors: { ownerAccountUuid: "b", viewerAccountUuid: "b" } }]) {
    const c = { ...conversation(), ...patch }, methods = new Map<string, any>(), calls: string[] = [];
    registerExperimentalCodeSessions({ ctx: { account: () => ({ id: "a" }), sessionIdentity: () => 1,
      settings: () => ({}), localLoadConversation: async () => c, localCall: async (name: string) => { calls.push(name); throw Error("must not call"); },
      onEvent: () => () => {} }, on(name: string, fn: any) { methods.set(name, fn); return this; }, emit() {},
      store: (_a: string, _b: string, v: any) => ({ get: () => v, set() {} }) } as never);
    const result = await methods.get("LocalSessions.changeCwd")("local_c", "/new", true, "/new");
    assert.equal(result.status, "rejected"); assert.deepEqual(calls, []);
  }
});
test("native Environment rechecks busy/cwd/account after awaited trust read before any trust write", async () => {
  for (const scenario of ["busy", "cwd", "account"] as const) {
    const c = conversation(), methods = new Map<string, any>(), calls: string[] = []; let identity = 1;
    let done!: (value: any) => void;
    registerExperimentalCodeSessions({ ctx: { account: () => ({ id: "a" }), sessionIdentity: () => identity,
      settings: () => ({}), localLoadConversation: async () => c, localCall: async (name: string) => {
        calls.push(name); if (name === "checkWorkspaceTrust") return new Promise(r => done = r);
        throw Error("unexpected trust mutation"); }, onEvent: () => () => {} },
      on(name: string, fn: any) { methods.set(name, fn); return this; }, emit() {},
      store: (_a: string, _b: string, v: any) => ({ get: () => v, set() {} }) } as never);
    const directory = os.tmpdir();
    const pending = methods.get("LocalSessions.changeCwd")("local_c", directory, true, directory);
    while (!done) await new Promise(r => setImmediate(r));
    if (scenario === "busy") c.turns.push({ status: "inProgress", id: "t", items: [] });
    if (scenario === "cwd") c.cwd = "/different";
    if (scenario === "account") identity++;
    done({ trusted: false, sources: [] });
    assert.equal((await pending).status, "rejected"); assert.deepEqual(calls, ["checkWorkspaceTrust"]);
  }
});
