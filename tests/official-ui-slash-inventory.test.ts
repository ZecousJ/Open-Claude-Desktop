import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerComposerHandlers } from "../electron/ipc/composer";
import { createNativeSlashInventory } from "../electron/official-ui/native/slash-commands";
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "strict-slash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompts = path.join(root, "codex-home", "prompts");
  fs.mkdirSync(prompts, { recursive: true });
  fs.writeFileSync(path.join(prompts, "review-pr.md"), "Review $1");
  let owner = "owner",
    identity = 1,
    current = true;
  let conversation: any = { id: "owned", mode: "code", cwd: root };
  let rpc = async (): Promise<any> => ({
    data: [{ skills: [{ name: "lint", description: "Lint" }] }],
  });
  const calls: any[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const host: any = {
    store: {
      root,
      conversation: (id: string) => {
        assert.equal(id, "owned");
        return conversation;
      },
    },
    engine: { rpc: { call: async () => rpc() } },
    engineFor(id: string) {
      assert.equal(id, "owned");
      return this.engine;
    },
    allowedFolder: (folder: string) => {
      if (folder !== root) throw Error("Folder not approved");
    },
    selectedAttachments: new Map(),
  };
  registerComposerHandlers((n, f) => handlers.set(n, f), host);
  const read = createNativeSlashInventory(
    {
      account: () => ({ id: owner }),
      sessionIdentity: () => identity,
      isCurrent: () => current,
      localLoadConversation: async (id: string) =>
        id === "owned" ? conversation : undefined,
      localCall: async (name: string, ...args: unknown[]) => {
        calls.push([name, ...args]);
        assert.equal(name, "listSlashCommands");
        return handlers.get(name)!(...args);
      },
    } as never,
    "code",
  );
  return {
    root,
    prompts,
    read,
    calls,
    legacy: () => handlers.get("listSlashCommands")!({}),
    setRpc: (fn: typeof rpc) => (rpc = fn),
    setConversation: (v: any) => (conversation = v),
    switch: () => (owner = "other"),
    activate: () => identity++,
    retire: () => (current = false),
  };
}
test("strict inventory uses actual composer handler and owned local session scope", async (t) => {
  const f = fixture(t);
  const list = await f.read({ sessionId: "local_owned" });
  assert.deepEqual(
    list.commands.map((c) => [c.name, c.source]),
    [
      ["review-pr", "prompt"],
      ["lint", "skill"],
    ],
  );
  assert.deepEqual(f.calls[0], [
    "listSlashCommands",
    { strictSources: true, conversationId: "owned" },
  ]);
  assert.equal((await f.read({ cwd: f.root })).commands.length, 2);
});
test("strict failures stay errors while legacy prompt-only fallback remains compatible", async (t) => {
  const f = fixture(t);
  f.setRpc(async () => {
    throw Error("runtime offline");
  });
  await assert.rejects(f.read(), /runtime offline/);
  assert.deepEqual(
    (await f.legacy()).commands.map((c: any) => c.name),
    ["review-pr"],
  );
  for (const value of [
    undefined,
    {},
    { data: [{}] },
    { data: [{ skills: [], errors: [{ message: "unreadable" }] }] },
  ]) {
    f.setRpc(async () => value);
    await assert.rejects(f.read(), /unavailable or malformed/);
  }
  f.setRpc(async () => ({ data: [] }));
  assert.equal((await f.read()).commands.length, 1);
});
test("renderer paths need real existing authorization and remote/wrong sessions cannot read commands", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.read({ cwd: "/unapproved" }), /not approved/);
  await assert.rejects(f.read({ sessionId: "local_other" }), /not found/);
  for (const change of [
    { cloudHosted: true },
    { mode: "cowork" },
    { environment: { kind: "ssh", hostId: "x" } },
    { sessionAuthors: { ownerAccountUuid: "a", viewerAccountUuid: "b" } },
  ]) {
    f.setConversation({ id: "owned", mode: "code", cwd: f.root, ...change });
    await assert.rejects(f.read({ sessionId: "local_owned" }), /not found/);
  }
  await assert.rejects(f.read({ sessionId: "owned" }));
  await assert.rejects(f.read({ sessionId: "local_owned", cwd: f.root }));
  await assert.rejects(f.read({ force: true }));
});
test("late strict-source results cannot cross account, activation, or retired host", async (t) => {
  for (const change of ["switch", "activate", "retire"] as const) {
    const f = fixture(t);
    f.setRpc(async () => {
      f[change]();
      return { data: [] };
    });
    await assert.rejects(
      f.read({ sessionId: "local_owned" }),
      /account changed/,
    );
  }
});
test("strict prompt catalog does not accept escaped symlink or pretend truncated catalog is complete", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 201; i++)
    fs.writeFileSync(path.join(f.prompts, `p${i}.md`), "Prompt");
  await assert.rejects(f.read(), /exceeds its limit/);
  assert.equal((await f.legacy()).commands.length, 201);
  fs.rmSync(f.prompts, { recursive: true });
  fs.symlinkSync(os.tmpdir(), f.prompts);
  await assert.rejects(f.read(), /outside the active profile/);
});

for (const extra of [
  { sessionAuthors: { ownerAccountUuid: "other", viewerAccountUuid: "other" } },
  { cloudEnvironmentId: "remote" },
  { incognito: true },
])
  test(
    "strict inventory refuses foreign or nonlocal command ownership " +
      JSON.stringify(extra),
    async (t) => {
      const f = fixture(t);
      f.setConversation({ id: "owned", mode: "code", cwd: f.root, ...extra });
      await assert.rejects(f.read({ sessionId: "local_owned" }), /not found/);
      assert.deepEqual(f.calls, []);
    },
  );
