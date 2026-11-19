/**
 * Isolated spaces on the cloud runner (docs/cloud-sync.md): each space gets
 * an engine of its own, started in the space's sandbox; at most three run
 * at once, the one unused longest that is idle giving way, and none starts
 * while every one is busy. A plain stand-in replaces the local engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EngineRegistry } from "../../electron/engine/engine-registry";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { sameEnvironment } from "../../electron/engine/engine-types";
import { CodexRPC } from "../../electron/engine/rpc";
import { registerWorkflowHandlers } from "../../electron/ipc/workflow";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import type { AppEvent, Approval, Conversation } from "../../shared/types";
import { tasksFromTurn } from "../../shared/workflow-model";

function setup(maxSpaces = 3) {
  const peers: any[] = [];
  const local: any = {
    store: { conversations: [] as any[] },
    peers: undefined,
    ownBusy: () => false,
    isBusy: () => false,
    createPeer(options: any) {
      const peer = {
        options,
        busy: false,
        stopped: false,
        ownBusy() {
          return this.busy;
        },
        stop: async function () {
          this.stopped = true;
        },
      };
      peers.push(peer);
      return peer;
    },
  };
  const started: string[] = [];
  const stopped: string[] = [];
  const registry = new EngineRegistry(() => local);
  registry.bind({
    ssh: () => undefined,
    dataRoot: "/tmp",
    onEvent: () => () => {},
    maxSpaces,
    space: (spaceId) => {
      started.push(spaceId);
      return {
        binary: `/sandbox/${spaceId}`,
        root: `/spaces/${spaceId}`,
        environmentVariables: { NODE_ENV: "test" },
      };
    },
    spaceStopped: (spaceId) => stopped.push(spaceId),
  });
  return { registry, local, peers, started, stopped };
}

const space = (spaceId: string) => ({ kind: "space" as const, spaceId });

test("a space's engine runs in the space's own sandbox, once", () => {
  const { registry, peers, started } = setup();
  const a = registry.forEnvironment(space("c-1")) as any;
  assert.equal(a.options.binary, "/sandbox/c-1");
  assert.equal(a.options.root, "/spaces/c-1");
  assert.deepEqual(a.options.environment, space("c-1"));
  assert.equal(
    registry.forEnvironment(space("c-1")),
    a,
    "the same space reuses its engine",
  );
  registry.forEnvironment(space("c-2"));
  assert.deepEqual(started, ["c-1", "c-2"]);
  assert.equal(peers.length, 2);
  assert.equal(registry.all().length, 3, "the local engine and two spaces");
});

test("at the limit the idle space unused longest gives way; all busy, none starts", async () => {
  const { registry, peers, stopped } = setup(2);
  const a = registry.forEnvironment(space("a")) as any;
  await new Promise((r) => setTimeout(r, 2));
  const b = registry.forEnvironment(space("b")) as any;
  registry.forEnvironment(space("c"));
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(a.stopped, true, "the oldest idle space stopped");
  assert.deepEqual(stopped, ["a"], "its sandbox's resources are released");
  assert.equal(b.stopped, false);
  // Every running space busy: a fourth waits.
  for (const peer of peers) peer.busy = true;
  assert.throws(
    () => registry.forEnvironment(space("d")),
    /Wait for one to finish/,
  );
});

test("a cloud-profile peer receives its variables and still releases its sandbox", async () => {
  const { registry, stopped } = setup();
  const peer = registry.forEnvironment(space("profile")) as any;
  assert.deepEqual(peer.options.environmentVariables, { NODE_ENV: "test" });
  await peer.options.releaseEnvironment();
  assert.equal(peer.stopped, true);
  assert.deepEqual(stopped, ["profile"]);
  assert.equal(registry.all().length, 1);
});

test("spaces compare by id", () => {
  assert.equal(sameEnvironment(space("a"), space("a")), true);
  assert.equal(sameEnvironment(space("a"), space("b")), false);
  assert.equal(sameEnvironment(space("a"), undefined), false);
  assert.equal(sameEnvironment(undefined, { kind: "local" }), true);
});

function spaceEngine(environment?: { kind: "space"; spaceId: string }, emit: (event: AppEvent) => void = () => {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-space-engine-")),
  );
  const store = new Store(path.join(root, "profile"));
  const engine = new Engine(
    store,
    "unused",
    () => "",
    emit,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    environment ? { environment, root: path.join(root, "space") } : {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  let threads = 0;
  engine.rpc = {
    async call(method: string) {
      if (method === "thread/start")
        return { thread: { id: `t-${++threads}` } };
      if (method === "turn/start") return { turn: { id: `turn-${threads}` } };
      return {};
    },
    respond() {},
    reject() {},
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  return { engine, store };
}

const chat = {
  text: "hi",
  mode: "chat" as const,
  attachments: [],
  providerId: "default",
  model: "m",
};

test("a conversation started in a space remembers it, so its next calls reach the space", async () => {
  const { engine } = spaceEngine(space("c-9"));
  const c = await engine.send({ ...chat, environment: space("c-9") });
  assert.deepEqual(c.environment, space("c-9"));
  const local = spaceEngine();
  const plain = await local.engine.send(chat);
  assert.equal(plain.environment, undefined);
});

test("a space's approval ids carry the space, so engines' requests never collide", () => {
  const { engine } = spaceEngine(space("c-9"));
  const id = (engine as any).approvalId(0);
  assert.equal(id, "space:c-9:number:0");
  assert.equal((engine as any).requestIdOf(id), 0);
  assert.equal((spaceEngine().engine as any).approvalId(0), 0);
});

test("an approved hosted Workflow starts in its space and settles when the space stops", { timeout: 5000 }, async (t) => {
  let request!: (approval: Approval) => void;
  const requested = new Promise<Approval>((resolve) => { request = resolve; });
  const { engine, store } = spaceEngine(undefined, (event) => {
    if (event.type === "approval") request(event.approval);
  });
  const root = path.dirname(store.root);
  const spaceRoot = path.join(root, "space");
  const registry = new EngineRegistry(() => engine);
  const unbind = registry.bind({
    ssh: () => undefined,
    dataRoot: root,
    onEvent: () => () => {},
    space: () => ({ binary: "unused", root: spaceRoot }),
  });
  t.after(async () => {
    await registry.stopRemote();
    unbind();
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.settings.workflows = { enabled: true };
  registerWorkflowHandlers(() => {}, { store, engine });
  const environment = space("code");
  const peer = registry.forEnvironment(environment);
  const cwd = peer.defaultWorkspace;
  fs.mkdirSync(cwd, { recursive: true });
  const conversation: Conversation = {
    id: "hosted-code",
    threadId: "hosted-parent",
    title: "Hosted Code",
    mode: "code",
    providerId: "default",
    model: "m",
    environment,
    cwd,
    archived: false,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [{ id: "hosted-turn", prompt: "review", status: "inProgress", attachments: [], items: [], createdAt: 1 }],
  };
  store.conversations.push(conversation);
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => { childStarted = resolve; });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  peer.ensure = async () => {};
  const rpc = new CodexRPC();
  peer.rpc = rpc;
  let toolResult: unknown;
  rpc.respond = (_id, result) => { toolResult = result; };
  rpc.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "space-child" } };
    if (method === "turn/start") {
      setImmediate(childStarted);
      return { turn: { id: "child-turn" } };
    }
    throw Error(`Unexpected request: ${method}`);
  };
  const turn = conversation.turns[0];
  const running = peer.answerDynamicTool({
    id: 1,
    params: {
      threadId: conversation.threadId,
      turnId: turn.id,
      callId: "workflow-call",
      tool: "Workflow",
      arguments: {
        script: "export const meta = { name: 'peer-review', description: 'Review in the hosted session' }; return await agent('Review the project');",
      },
    },
  }, conversation.id);
  const approval = await Promise.race([requested, running.then(() => assert.fail(JSON.stringify(toolResult)))]);
  assert.equal(engine.ownApprovals.length, 0);
  assert.equal(engine.approvals[0], approval);
  assert.equal(peer.ownApprovals[0], approval);
  engine.approve(approval.id, { action: "accept", content: { decision: "once" } });
  await Promise.race([started, running.then(() => assert.fail(JSON.stringify(toolResult)))]);
  assert.deepEqual(calls.map(({ method }) => method), ["thread/start", "turn/start"]);
  assert.equal(calls[0].params.cwd, cwd);
  assert.equal(calls[0].params.approvalPolicy, "never");
  const [task] = tasksFromTurn(turn, conversation);
  assert.equal(task.status, "running");
  assert.equal(task.agents[0].id, "space-child");
  assert.ok(task.runId);
  await registry.stopRemote();
  await running;
  assert.equal(turn.status, "interrupted");
  const [stopped] = tasksFromTurn(turn, conversation);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.agents[0].status, "interrupted");
  const result = JSON.parse(fs.readFileSync(path.join(store.root, "workflow-runs", task.runId, "result.json"), "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "The workflow was stopped.");
});
