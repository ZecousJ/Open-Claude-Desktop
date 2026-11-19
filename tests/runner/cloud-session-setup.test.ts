/**
 * A cloud Code session opens before its repository is cloned, and its first
 * turn shows the start's steps (shared/session-setup.ts): the engine runs
 * the runner's fetch in the turn, a failed clone ends in the transcript
 * instead of a toast, Stop ends the clone, and the transcript's words follow
 * the live claude.ai bundle (2026-10-12). The Codex process is faked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { registerConversationHandlers } from "../../electron/ipc/conversations";
import { openPolicy } from "../../shared/client-policy";
import {
  SetupError,
  failSetup,
  isSetupHook,
  newSessionSetup,
  settledSteps,
  type SessionSetupHook,
} from "../../shared/session-setup";
import {
  cloneFailure,
  gitHubFetcher,
  stagedGitHubClone,
} from "../../runner/src/github-workspace";
import {
  setupHeadline,
  setupStepLabel,
} from "../../src/code-tools/SessionSetupSteps";
import { setupFailure } from "../../src/transcript/CodeTurnError";
import { codeStatus } from "../../src/transcript/CodeTurnStatus";
import type { AppEvent, Conversation, Turn } from "../../shared/types";

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-setup-"));
  const store = new Store(root);
  store.settings.providers = [
    {
      id: "p",
      name: "Local",
      protocol: "responses",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      models: ["m"],
    },
  ];
  store.settings.activeProviderId = "p";
  const events: Conversation[] = [];
  const calls: string[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    (event: AppEvent) => {
      if (event.type === "conversation")
        events.push(structuredClone(event.conversation));
    },
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {
    calls.push("ensure");
  };
  engine.rpc = {
    call: async (method: string) => {
      calls.push(method);
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    },
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  const cwd = path.join(root, "session");
  fs.mkdirSync(cwd);
  const send = (setup?: SessionSetupHook, conversationId?: string) =>
    engine.send({
      ...(conversationId ? { conversationId } : {}),
      text: "fix the tests",
      mode: "code",
      cwd,
      attachments: [],
      providerId: "p",
      model: "m",
      ...(setup ? { setup } : {}),
      ...((engine as any).options.environment?.kind === "space"
        ? { environment: (engine as any).options.environment }
        : {}),
    });
  return {
    store,
    engine,
    events,
    calls,
    send,
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const repository = { url: "https://github.com/octo/hello", ref: "main" };

test("a cloud workspace without a repository runs its setup script before the first turn", async () => {
  const env = harness();
  // Setup scripts run only in a runner sandbox (a "space" engine).
  (env.engine as any).options.environment = { kind: "space", spaceId: "s" };
  try {
    const original = env.engine.rpc!.call.bind(env.engine.rpc);
    env.engine.rpc!.call = (async (method: string, params: any) => {
      if (method === "command/exec") {
        env.calls.push(method);
        assert.deepEqual(params.command, ["/bin/bash", "-c", "npm ci"]);
        assert.equal(params.sandboxPolicy.type, "dangerFullAccess");
        return { exitCode: 0 };
      }
      return original(method, params);
    }) as any;
    const conversation = await env.send({
      repositories: [],
      fetch: async () => {},
      setupScript: "npm ci",
    });
    assert.ok(
      env.calls.indexOf("command/exec") < env.calls.indexOf("turn/start"),
    );
    assert.equal(conversation.pendingSetupScript, undefined);
    assert.equal(conversation.repository, undefined);
    assert.equal(
      conversation.turns[0].setup?.steps.find(
        (step) => step.id === "setup_script",
      )?.status,
      "completed",
    );
    assert.equal(
      setupStepLabel({ id: "setup_script", status: "completed" }),
      "Ran setup script",
    );
  } finally {
    env.close();
  }
});

test("a failed environment setup ends in the transcript and remains pending for a later retry", async () => {
  const env = harness();
  // Setup scripts run only in a runner sandbox (a "space" engine).
  (env.engine as any).options.environment = { kind: "space", spaceId: "s" };
  try {
    const original = env.engine.rpc!.call.bind(env.engine.rpc);
    env.engine.rpc!.call = (async (method: string, params: any) =>
      method === "command/exec"
        ? { exitCode: 1, stderr: "Install failed" }
        : original(method, params)) as any;
    const conversation = await env.send({
      repositories: [repository],
      fetch: async () => {},
      setupScript: "npm ci",
    });
    assert.equal(conversation.turns[0].status, "failed");
    assert.equal(conversation.turns[0].error, "Install failed");
    assert.equal(conversation.pendingSetupScript, "npm ci");
    assert.equal(
      conversation.turns[0].setup?.steps.find(
        (step) => step.id === "setup_script",
      )?.status,
      "failed",
    );
    assert.ok(!env.calls.includes("turn/start"));
  } finally {
    env.close();
  }
});

test("the session shows while its repository is fetched, then its start goes on", async () => {
  const env = harness();
  try {
    let during: Conversation | undefined;
    const sent = await env.send({
      repositories: [repository],
      fetch: async () => {
        during = structuredClone(env.events.at(-1)!);
        assert.deepEqual(env.calls, [], "nothing starts before the clone");
      },
    });
    // The window had the session, its prompt and the clone running.
    const turn = during!.turns.at(-1)!;
    assert.equal(turn.prompt, "fix the tests");
    assert.equal(turn.status, "inProgress");
    assert.deepEqual(
      turn.setup!.steps.map((s) => [s.id, s.status]),
      [
        ["clone", "running"],
        ["provision", "pending"],
        ["start", "pending"],
      ],
    );
    assert.deepEqual(during!.pendingSetup, [repository]);
    // Afterwards every step is done and the repository is in place.
    const last = sent.turns.at(-1)!;
    assert.equal(last.id, "turn-1");
    assert.deepEqual(
      last.setup!.steps.map((s) => s.status),
      ["completed", "completed", "completed"],
    );
    assert.equal(sent.pendingSetup, undefined);
    assert.deepEqual(env.calls, ["ensure", "thread/start", "turn/start"]);
  } finally {
    env.close();
  }
});

test("a failed clone ends the turn in the transcript; the send itself succeeds", async () => {
  const env = harness();
  try {
    const sent = await env.send({
      repositories: [repository],
      fetch: async () => {
        throw new SetupError(
          "Couldn't clone octo/hello: fatal: unable to access: Could not resolve host: github.com",
          "upstream",
        );
      },
    });
    const turn = sent.turns.at(-1)!;
    assert.equal(turn.status, "failed");
    assert.equal(turn.setup!.failure, "upstream");
    assert.deepEqual(
      turn.setup!.steps.map((s) => s.status),
      ["failed", "skipped", "skipped"],
    );
    assert.match(turn.setup!.steps[0].error!, /Could not resolve host/);
    // Its next message fetches the repository again.
    assert.deepEqual(sent.pendingSetup, [repository]);
    assert.deepEqual(env.calls, [], "Codex never started");
    // The engine takes the next message (nothing is left pending).
    let fetched = 0;
    const again = await env.send(
      {
        repositories: [repository],
        fetch: async () => {
          fetched++;
        },
      },
      sent.id,
    );
    assert.equal(fetched, 1);
    assert.equal(again.pendingSetup, undefined);
    assert.equal(again.turns.at(-1)!.status, "inProgress");
  } finally {
    env.close();
  }
});

test("Stop during the clone ends it: the turn is stopped and nothing failed", async () => {
  const env = harness();
  try {
    let aborted = false;
    const sending = env.send({
      repositories: [repository],
      fetch: (signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("stopped"));
          });
        }),
    });
    // Wait for the clone to start, then stop the session.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const id = env.events.at(-1)!.id;
    await env.engine.interrupt(id);
    const sent = await sending;
    assert.equal(aborted, true);
    const turn = sent.turns.at(-1)!;
    assert.equal(turn.status, "interrupted");
    assert.equal(turn.setup!.failure, undefined);
    assert.deepEqual(
      turn.setup!.steps.map((s) => s.status),
      ["skipped", "skipped", "skipped"],
    );
    assert.deepEqual(sent.pendingSetup, [repository]);
  } finally {
    env.close();
  }
});

test("a container that fails to start after the clone fails in the transcript too", async () => {
  const env = harness();
  try {
    env.engine.ensure = async () => {
      throw new Error("codex exited");
    };
    const sent = await env.send({
      repositories: [repository],
      fetch: async () => {},
    });
    const turn = sent.turns.at(-1)!;
    assert.equal(turn.status, "failed");
    assert.equal(turn.setup!.failure, "failed");
    assert.deepEqual(
      turn.setup!.steps.map((s) => s.status),
      ["completed", "failed", "skipped"],
    );
    // The repository is in the folder: no second fetch.
    assert.equal(sent.pendingSetup, undefined);
  } finally {
    env.close();
  }
});

test("a session with several repositories keeps them all, and fetches them all again", async () => {
  const env = harness();
  try {
    const other = { url: "https://github.com/octo/tool" };
    const sent = await env.send({
      repositories: [repository, other],
      fetch: async () => {
        throw new SetupError("Couldn't clone octo/tool: fatal", "failed");
      },
    });
    // The runner's GitHub tools find the others by this list.
    assert.deepEqual(sent.sessionRepositories, [repository, other]);
    // The lists show and search the main repository.
    assert.deepEqual(sent.repository, {
      fullName: "octo/hello",
      url: "https://github.com/octo/hello",
    });
    // Its next message fetches every repository again, not only the main one.
    assert.deepEqual(sent.pendingSetup, [repository, other]);
    let fetched = false;
    const again = await env.send(
      {
        repositories: sent.pendingSetup!,
        fetch: async () => {
          fetched = true;
        },
      },
      sent.id,
    );
    assert.equal(fetched, true);
    assert.equal(again.pendingSetup, undefined);
    assert.deepEqual(again.sessionRepositories, [repository, other]);
  } finally {
    env.close();
  }
});

test("the send handler takes a setup only as the runner's second argument", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: any[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-setup-ipc-"));
  try {
    registerConversationHandlers((name, fn) => handlers.set(name, fn), {
      store: { root, projects: [], conversation: () => undefined } as any,
      engine: { send: async (input: any) => (sent.push(input), input) } as any,
      activeAccount: { id: "fixture" } as any,
      accountActivationIdentity: {},
      accountRetiring: false,
      replyFeedback: {} as any,
      selectedAttachments: new Map(),
      allowedFolder: () => {},
      noActive: () => {},
    });
    const send = handlers.get("send")!;
    const input = {
      text: "hi",
      mode: "code",
      attachments: [],
      providerId: "p",
      model: "m",
    };
    const fetch = async () => {};
    await send(input, { setup: { repositories: [repository], fetch } });
    assert.equal(sent.at(-1).setup.fetch, fetch);
    // Cloned data (a window's, the browser's) has no function in it.
    await send(input, { setup: { repositories: [repository], fetch: "x" } });
    assert.equal(sent.at(-1).setup, undefined);
    await send(
      { ...input, mode: "chat" },
      {
        setup: { repositories: [repository], fetch },
      },
    );
    assert.equal(sent.at(-1).setup, undefined, "only Code sessions");
    assert.equal(isSetupHook({ repositories: [], fetch }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("git's words decide which failure the transcript names", () => {
  for (const said of [
    "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com",
    "fatal: unable to access 'https://github.com/o/r/': Failed to connect to github.com port 443",
    "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 502",
    "error: RPC failed; curl 56 GnuTLS recv error; fatal: early EOF",
    "The clone took too long.",
  ])
    assert.equal(cloneFailure(said), "upstream", said);
  for (const said of [
    "remote: Repository not found. fatal: repository 'https://github.com/o/r/' not found",
    "fatal: Remote branch nope not found in upstream origin",
    "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403",
    "fatal: Authentication failed for 'https://github.com/o/r/'",
  ])
    assert.equal(cloneFailure(said), "failed", said);
});

const grant = {
  url: "https://github.com/octo/hello.git",
  username: "x-access-token",
  token: "gho_SECRET",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  repository: "octo/hello",
  defaultBranch: "main",
  canPush: false,
};

test("a staged session gets its folder at once and clones only when asked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-staged-"));
  try {
    const requests: string[] = [];
    let runs = 0;
    const staged = stagedGitHubClone({
      transport: {
        request: async (op) => (requests.push(op), grant),
      },
      base: async (session: { userId: number }) => {
        const cwd = path.join(root, String(session.userId));
        fs.mkdirSync(cwd, { recursive: true });
        return { cwd };
      },
      runGit: async () => {
        runs++;
        return { code: 0, stderr: "" };
      },
    });
    const { cwd, fetch } = await staged({ userId: 3 }, repository);
    assert.ok(fs.statSync(cwd).isDirectory());
    assert.deepEqual(requests, []);
    await fetch!();
    assert.deepEqual(requests, ["github.clone"]);
    assert.equal(runs, 1);
    assert.equal((await staged({ userId: 4 })).fetch, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a fetch again empties the folder first and leaves it empty when it fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-refetch-"));
  try {
    fs.writeFileSync(path.join(root, "partial"), "half a clone");
    let seenBefore: string[] = [];
    const fetchInto = gitHubFetcher({
      transport: { request: async () => grant },
      runGit: async () => {
        seenBefore = fs.readdirSync(root);
        fs.writeFileSync(path.join(root, "README"), "x");
        return {
          code: 128,
          stderr: "fatal: unable to access: Could not resolve host: github.com",
        };
      },
    });
    await assert.rejects(fetchInto(1, [repository], root), (error: Error) => {
      assert.ok(error instanceof SetupError);
      assert.equal(error.failure, "upstream");
      assert.ok(!error.message.includes(grant.token));
      return true;
    });
    assert.deepEqual(seenBefore, []);
    assert.deepEqual(fs.readdirSync(root), []);
    // A stop reaches git as an aborted signal.
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(fetchInto(1, [repository], root, stop.signal));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the steps read as the original's checklist", () => {
  const setup = newSessionSetup(1);
  assert.equal(setupHeadline(setup.steps, 1, true), "Initializing session");
  setup.steps[0].status = "running";
  assert.equal(setupHeadline(setup.steps, 1, true), "Cloning repository");
  setup.steps[0].status = "completed";
  assert.equal(setupHeadline(setup.steps, 1, true), "Cloned repository");
  setup.steps[1].status = "running";
  assert.equal(
    setupHeadline(setup.steps, 1, true),
    "Setting up a cloud container",
  );
  setup.steps[1].status = "completed";
  setup.steps[2].status = "completed";
  assert.equal(setupHeadline(setup.steps, 1, false), "Initialized session");
  assert.equal(
    setupStepLabel({ id: "start", status: "running" }),
    "Starting Claudex Code",
  );
  assert.equal(
    setupStepLabel({ id: "clone", status: "running" }, 3),
    "Cloning 3 repositories",
  );
  // A failure: the failed step, never in the past tense.
  const failed = newSessionSetup(1);
  failed.steps[0].status = "running";
  failSetup(failed, "upstream", "no route");
  assert.equal(setupHeadline(failed.steps, 1, false), "Clone repository");
  assert.equal(
    setupFailure("upstream").headline,
    "Unable to connect to repository",
  );
  assert.equal(setupFailure("failed").headline, "Session couldn’t start");
  // A turn that ended mid-start (the app restarted) shows the rest skipped.
  const cut = newSessionSetup(1);
  cut.steps[0].status = "running";
  assert.deepEqual(
    settledSteps(cut, false).map((s) => s.status),
    ["skipped", "skipped", "skipped"],
  );
  // …and never says the session was initialized.
  assert.equal(
    setupHeadline(settledSteps(cut, false), 1, false),
    "Clone repository",
  );
});

test("the status line says Starting session… while the session starts", () => {
  const turn: Turn = {
    id: "t",
    prompt: "hi",
    attachments: [],
    items: [],
    status: "inProgress",
    createdAt: Date.now(),
    setup: newSessionSetup(1),
  };
  turn.setup!.steps[0].status = "running";
  assert.equal(codeStatus(turn, Date.now()).label, "Waiting for Claudex…");
  for (const step of turn.setup!.steps) step.status = "completed";
  // Once started it is the model the turn waits for (the same words).
  assert.equal(codeStatus(turn, Date.now()).label, "Waiting for Claudex…");
});

test("an engine on this computer never runs a setup script", async () => {
  const env = harness();
  try {
    // The send fails (the transcript says so); the script never reaches Codex.
    await env
      .send({
        repositories: [repository],
        fetch: async () => {},
        setupScript: "rm -rf ~",
      })
      .catch(() => undefined);
    assert.equal(env.calls.includes("command/exec"), false);
  } finally {
    env.close();
  }
});

test("expected provisional stop aborts its owned repository fetch and preserves interruption", async () => {
  const { interruptExpectedTurn } = await import("../../electron/conversations/interrupt-target");
  const env = harness();
  let signal!: AbortSignal, entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve);
  const gate = new Promise<void>(resolve => release = resolve);
  try {
    const send = env.send({ repositories: [repository], fetch: async s => { signal = s; entered(); await gate; throw Error("late fetch failure"); } });
    await ready;
    const c = env.store.conversations[0], turn = c.turns.at(-1)!;
    const result = await interruptExpectedTurn({ store: env.store, engine: env.engine, accountGeneration: () => 1 }, c.id,
      { kind: "starting", turnId: turn.id, turnCreatedAt: turn.createdAt, conversationCreatedAt: c.createdAt });
    assert.deepEqual(result, { status: "accepted" });
    assert.equal(signal.aborted, true);
    assert.equal(turn.status, "interrupted");
    release(); await send;
    assert.equal(turn.status, "interrupted");
    assert.equal(turn.error, undefined);
    assert.ok(turn.setup!.steps.every(step => step.status === "skipped"));
    assert.equal(env.calls.includes("turn/start"), false);
  } finally { release?.(); env.close(); }
});

for (const fail of [false, true]) test(`provisional stop preserves interruption after setup script ${fail ? "failure" : "completion"}`, async () => {
  const { interruptExpectedTurn } = await import("../../electron/conversations/interrupt-target");
  const env = harness(); (env.engine as any).options.environment = { kind: "space", spaceId: "s" };
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const original = env.engine.rpc!.call.bind(env.engine.rpc);
  env.engine.rpc!.call = (async (method: string, params: any) => {
    if (method !== "command/exec") return original(method, params);
    env.calls.push(method); entered(); await gate;
    if (fail) throw Error("late script failure");
    return { exitCode: 0 };
  }) as any;
  try {
    const send = env.send({ repositories: [repository], fetch: async () => {}, setupScript: "npm ci" });
    await ready; const c = env.store.conversations[0], turn = c.turns.at(-1)!;
    const result = await interruptExpectedTurn({ store: env.store, engine: env.engine, accountGeneration: () => 1 }, c.id,
      { kind: "starting", turnId: turn.id, turnCreatedAt: turn.createdAt, conversationCreatedAt: c.createdAt });
    assert.deepEqual(result, { status: "accepted" }); release(); await send;
    assert.equal(turn.status, "interrupted"); assert.equal(turn.error, undefined);
    assert.equal(env.calls.includes("turn/start"), false);
    assert.equal(turn.setup!.steps.find(step => step.id === "setup_script")!.status, "skipped");
  } finally { release?.(); env.close(); }
});

test("setup Stop waits for exact process termination and coalesces duplicates", async () => {
  const { interruptExpectedTurn } = await import("../../electron/conversations/interrupt-target");
  const env = harness(); (env.engine as any).options.environment = { kind: "space", spaceId: "s" };
  let entered!: () => void, releaseScript!: () => void, releaseStop!: () => void, processId = "", stops = 0;
  const ready = new Promise<void>(resolve => entered = resolve), scriptGate = new Promise<void>(resolve => releaseScript = resolve), stopGate = new Promise<void>(resolve => releaseStop = resolve);
  const original = env.engine.rpc!.call.bind(env.engine.rpc);
  env.engine.rpc!.call = (async (method: string, params: any) => {
    if (method === "command/exec") { processId = params.processId; entered(); await scriptGate; return { exitCode: 0 }; }
    if (method === "command/exec/terminate") { stops++; assert.equal(params.processId, processId); await stopGate; return {}; }
    return original(method, params);
  }) as any;
  try {
    const send = env.send({ repositories: [repository], fetch: async () => {}, setupScript: "npm ci" }); await ready;
    const c = env.store.conversations[0], turn = c.turns.at(-1)!, ctx = { store: env.store, engine: env.engine, accountGeneration: () => 1 };
    const target = { kind: "starting", turnId: turn.id, turnCreatedAt: turn.createdAt, conversationCreatedAt: c.createdAt };
    const a = interruptExpectedTurn(ctx, c.id, target), b = interruptExpectedTurn(ctx, c.id, target);
    assert.ok(processId); assert.equal(stops, 1); assert.equal(turn.status, "inProgress");
    releaseStop(); assert.deepEqual(await a, { status: "accepted" }); assert.deepEqual(await b, { status: "accepted" });
    assert.equal(turn.status, "interrupted"); releaseScript(); await send; assert.equal(stops, 1); assert.equal(env.calls.includes("turn/start"), false);
  } finally { releaseStop?.(); releaseScript?.(); env.close(); }
});

test("setup Stop accepts authoritative exit while termination remains pending", async () => {
  const { interruptExpectedTurn } = await import("../../electron/conversations/interrupt-target");
  const env = harness(); (env.engine as any).options.environment = { kind: "space", spaceId: "s" };
  let entered!: () => void, releaseScript!: () => void, releaseStop!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve), scriptGate = new Promise<void>(resolve => releaseScript = resolve), stopGate = new Promise<void>(resolve => releaseStop = resolve);
  const original = env.engine.rpc!.call.bind(env.engine.rpc);
  env.engine.rpc!.call = (async (method: string, params: any) => {
    if (method === "command/exec") { entered(); await scriptGate; return { exitCode: 0 }; }
    if (method === "command/exec/terminate") { await stopGate; return {}; }
    return original(method, params);
  }) as any;
  try {
    const send = env.send({ repositories: [repository], fetch: async () => {}, setupScript: "npm ci" }); await ready;
    const c = env.store.conversations[0], turn = c.turns.at(-1)!, ctx = { store: env.store, engine: env.engine, accountGeneration: () => 1 };
    const stop = interruptExpectedTurn(ctx, c.id, { kind: "starting", turnId: turn.id, turnCreatedAt: turn.createdAt, conversationCreatedAt: c.createdAt });
    releaseScript(); assert.deepEqual(await stop, { status: "accepted" }); await send;
    assert.equal(turn.status, "interrupted"); assert.equal(env.calls.includes("turn/start"), false);
  } finally { releaseStop?.(); releaseScript?.(); env.close(); }
});

test("late setup termination cannot mutate a successor turn", async () => {
  const { interruptExpectedTurn } = await import("../../electron/conversations/interrupt-target");
  const env = harness(); (env.engine as any).options.environment = { kind: "space", spaceId: "s" };
  let entered!: () => void, releaseScript!: () => void, releaseStop!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve), scriptGate = new Promise<void>(resolve => releaseScript = resolve), stopGate = new Promise<void>(resolve => releaseStop = resolve);
  const original = env.engine.rpc!.call.bind(env.engine.rpc);
  env.engine.rpc!.call = (async (method: string, params: any) => {
    if (method === "command/exec") { entered(); await scriptGate; return { exitCode: 0 }; }
    if (method === "command/exec/terminate") { await stopGate; return {}; }
    return original(method, params);
  }) as any;
  try {
    const send = env.send({ repositories: [repository], fetch: async () => {}, setupScript: "npm ci" }); await ready;
    const c = env.store.conversations[0], turn = c.turns.at(-1)!, ctx = { store: env.store, engine: env.engine, accountGeneration: () => 1 };
    const stop = interruptExpectedTurn(ctx, c.id, { kind: "starting", turnId: turn.id, turnCreatedAt: turn.createdAt, conversationCreatedAt: c.createdAt });
    const successor: Turn = { id: "new", prompt: "next", attachments: [], items: [], status: "inProgress", createdAt: 9 }; c.turns.push(successor);
    releaseStop(); await assert.rejects(stop, /turn changed/i); releaseScript(); await send.catch(() => {});
    assert.equal(successor.status, "inProgress"); assert.equal(successor.userStopped, undefined); assert.equal(env.calls.includes("turn/start"), false);
  } finally { releaseStop?.(); releaseScript?.(); env.close(); }
});

test("failed setup termination is not acknowledged before the command exits", async () => {
  const { interruptExpectedTurn } = await import("../../electron/conversations/interrupt-target");
  const env = harness(); (env.engine as any).options.environment = { kind: "space", spaceId: "s" };
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const original = env.engine.rpc!.call.bind(env.engine.rpc);
  env.engine.rpc!.call = (async (method: string, params: any) => {
    if (method === "command/exec") { entered(); await gate; return { exitCode: 0 }; }
    if (method === "command/exec/terminate") throw Error("termination unavailable");
    return original(method, params);
  }) as any;
  try {
    const send = env.send({ repositories: [repository], fetch: async () => {}, setupScript: "npm ci" }); await ready;
    const c = env.store.conversations[0], turn = c.turns.at(-1)!, ctx = { store: env.store, engine: env.engine, accountGeneration: () => 1 };
    await assert.rejects(interruptExpectedTurn(ctx, c.id, { kind: "starting", turnId: turn.id, turnCreatedAt: turn.createdAt, conversationCreatedAt: c.createdAt }), /termination unavailable/);
    assert.equal(turn.status, "inProgress"); release(); await send;
    assert.equal(turn.status, "interrupted"); assert.equal(env.calls.includes("turn/start"), false);
  } finally { release?.(); env.close(); }
});
