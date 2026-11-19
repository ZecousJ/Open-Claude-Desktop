import assert from "node:assert/strict";
import { test } from "node:test";
import { startCodeHelperSsh } from "../../electron/engine/code-helper-ssh";

function fixture() {
  const host = {
    id: "host",
    label: "Saved host",
    destination: "user@example.test",
    defaultFolder: "/work",
  };
  const provider = { id: "provider", model: "model", models: [] };
  const parent = {
    id: "parent",
    cwd: "/local",
    providerId: provider.id,
    model: "model",
    turns: [],
  };
  const turn = { id: "turn", codePermissionMode: "manual" };
  const calls: string[] = [];
  const service = { allowed: () => true, hosts: { list: () => [host] } };
  const ctx = {
    store: {
      settings: { providers: [provider], codeEffort: "medium" },
      projects: [],
      conversations: [parent],
    },
    services: { ssh: service },
    allowedFolder: () => {},
    engine: { requestAppApproval: async () => ({ action: "cancel" }) },
    engines: {
      forEnvironment: () => {
        calls.push("engine");
        throw Error("unexpected");
      },
    },
  };
  const args = {
    initiation: "user_asked",
    target: "ssh",
    host: host.label,
    title: "Task",
    prompt: "Work",
    background:
      "This background explains the task and its constraints so the remote session can work independently.",
  };
  return { ctx, parent, turn, args, host, calls };
}

test("declining SSH placement never starts a child", async () => {
  const f = fixture();
  await assert.rejects(
    startCodeHelperSsh(
      f.ctx as never,
      f.parent as never,
      f.turn as never,
      f.args,
      { signal: new AbortController().signal } as never,
      () => true,
      new Set(),
    ),
    /not approved/,
  );
  assert.deepEqual(f.calls, []);
});

test("SSH starts cannot escalate the parent's permission mode", async () => {
  const f = fixture();
  await assert.rejects(
    startCodeHelperSsh(
      f.ctx as never,
      f.parent as never,
      f.turn as never,
      { ...f.args, permission_mode: "bypassPermissions" },
      { signal: new AbortController().signal } as never,
      () => true,
      new Set(),
    ),
    /higher permission mode/,
  );
  assert.deepEqual(f.calls, []);
});

test("changing the saved SSH host during approval prevents dispatch", async () => {
  const f = fixture();
  f.ctx.engine.requestAppApproval = async () => {
    f.host.destination = "other@example.test";
    return { action: "accept" };
  };
  await assert.rejects(
    startCodeHelperSsh(
      f.ctx as never,
      f.parent as never,
      f.turn as never,
      f.args,
      { signal: new AbortController().signal } as never,
      () => true,
      new Set(),
    ),
    /changed/,
  );
  assert.deepEqual(f.calls, []);
});

test("revoking SSH workspace trust before dispatch prevents a child", async () => {
  const f = fixture();
  f.ctx.engine.requestAppApproval = async () => ({ action: "accept" });
  const remote = {
    remoteWorkspaceTrust: async () => ({ trusted: true, root: "/work" }),
    sshTrust: { roots: () => [] },
    send: async () => {
      throw Error("unexpected dispatch");
    },
  };
  Object.assign(f.ctx.engines, {
    forEnvironment: () => remote,
    connectWorktreeHost: async () => {},
  });
  await assert.rejects(
    startCodeHelperSsh(
      f.ctx as never,
      f.parent as never,
      f.turn as never,
      f.args,
      { signal: new AbortController().signal } as never,
      () => true,
      new Set(),
    ),
    /not trusted/,
  );
});

test("a changed remote folder identity prevents the first turn", async () => {
  const f = fixture();
  f.ctx.engine.requestAppApproval = async () => ({ action: "accept" });
  let checks = 0;
  const remote = {
    remoteWorkspaceTrust: async () => ({
      trusted: true,
      root: "/work",
      folder: ++checks === 1 ? "/work" : "/elsewhere",
    }),
    sshTrust: { roots: () => ["/work"] },
    send: async (
      _input: unknown,
      _retry: unknown,
      _editing: unknown,
      options: { verifyCodeHelperPlacement: () => Promise<void> },
    ) => {
      await options.verifyCodeHelperPlacement();
      throw Error("unexpected dispatch");
    },
  };
  Object.assign(f.ctx.engines, {
    forEnvironment: () => remote,
    connectWorktreeHost: async () => {},
  });
  await assert.rejects(
    startCodeHelperSsh(
      f.ctx as never,
      f.parent as never,
      f.turn as never,
      f.args,
      { signal: new AbortController().signal } as never,
      () => true,
      new Set(),
    ),
    /trusted SSH folder changed/,
  );
});
