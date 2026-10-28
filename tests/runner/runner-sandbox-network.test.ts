/**
 * #22: in the web runner's gVisor sandbox a restricted command keeps the
 * sandbox's network (Codex otherwise gives it its own and fails at
 * "RTM_NEWADDR"); a computer's engine still turns the network off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import { turnSandboxPolicy } from "../../shared/sandbox-policy";

function setup(sandboxNetwork: boolean) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-sandbox-network-")),
  );
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  const store = new Store(profile);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.sandboxNetwork = sandboxNetwork;
  engine.ensure = async () => {};
  const turns: any[] = [];
  let threads = 0;
  engine.rpc = {
    async call(method: string, params: any) {
      if (method === "turn/start") turns.push(structuredClone(params));
      if (method === "thread/start" || method === "thread/fork")
        return { thread: { id: `thread-${++threads}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${turns.length}` } };
      return {};
    },
    respond() {},
    reject() {},
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  return {
    engine,
    store,
    work,
    turns,
    send: (extra: Record<string, unknown> = {}) =>
      engine.send({
        text: "Hello",
        mode: "code",
        cwd: work,
        attachments: [],
        providerId: "default",
        model: "m",
        ...extra,
      }),
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const originalPlatform = process.platform;
test.before(() =>
  Object.defineProperty(process, "platform", { value: "linux" }),
);
test.after(() =>
  Object.defineProperty(process, "platform", { value: originalPlatform }),
);

test("turnSandboxPolicy carries the network only when asked", () => {
  assert.equal(turnSandboxPolicy("read-only", "/w").networkAccess, false);
  assert.equal(
    turnSandboxPolicy("read-only", "/w", [], true).networkAccess,
    true,
  );
  const write = turnSandboxPolicy("workspace-write", "/w", [], true);
  assert.equal(write.type, "workspaceWrite");
  assert.equal((write as { networkAccess: boolean }).networkAccess, true);
  assert.deepEqual((write as { writableRoots: string[] }).writableRoots, [
    "/w",
  ]);
  assert.deepEqual(turnSandboxPolicy("danger-full-access", "/w", [], true), {
    type: "dangerFullAccess",
  });
  // Inside the runner's own sandbox, a folder turn is Codex's external one.
  assert.deepEqual(turnSandboxPolicy("workspace-write", "/w", [], true, true), {
    type: "externalSandbox",
    networkAccess: "enabled",
  });
  assert.equal(
    turnSandboxPolicy("read-only", "/w", [], true, true).type,
    "readOnly",
  );
});

test("the runner's restricted Code turns run in its own sandbox", async () => {
  const env = setup(true);
  try {
    env.store.settings = {
      ...env.store.settings,
      codeSandbox: "workspace-write",
      codePlanMode: false,
    };
    await env.send();
    const turn = env.turns.at(-1);
    // Codex's own sandbox can't start inside gVisor: the runner's is the
    // external one, with its network (a patched file is read without one).
    assert.deepEqual(turn.sandboxPolicy, {
      type: "externalSandbox",
      networkAccess: "enabled",
    });
    assert.equal(turn.approvalPolicy, "on-request");
    // Plan mode: read-only, with the same network.
    env.store.settings = { ...env.store.settings, codePlanMode: true };
    await env.send();
    assert.deepEqual(env.turns.at(-1).sandboxPolicy, {
      type: "readOnly",
      networkAccess: true,
    });
  } finally {
    env.close();
  }
});

test("a computer's engine sends no network with its Code turns", async () => {
  const env = setup(false);
  try {
    env.store.settings = {
      ...env.store.settings,
      codeSandbox: "workspace-write",
      codePlanMode: false,
    };
    await env.send();
    const policy = env.turns.at(-1).sandboxPolicy;
    assert.ok(policy === undefined || policy.networkAccess === false);
  } finally {
    env.close();
  }
});

test("a runner Chat turn runs with the sender's permission mode", async () => {
  const env = setup(true);
  const environment = { kind: "space", spaceId: "s" };
  (env.engine as any).options.environment = environment;
  try {
    await env.send({ mode: "chat", environment, taskPermission: "bypass" });
    let turn = env.turns.at(-1);
    assert.deepEqual(turn.sandboxPolicy, { type: "dangerFullAccess" });
    assert.equal(turn.approvalPolicy, "never");
    assert.equal(env.store.conversations[0].senderPermission, "bypass");
    // A prompt from the web carries none: the account's setting applies.
    await env.send({ mode: "chat", environment });
    turn = env.turns.at(-1);
    assert.equal(turn.sandboxPolicy.type, "externalSandbox");
    assert.equal(turn.approvalPolicy, "on-request");
  } finally {
    env.close();
  }
});
