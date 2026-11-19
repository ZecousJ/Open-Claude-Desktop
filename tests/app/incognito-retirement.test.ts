/** Real Store, attachment cleanup, scoped registry, and lifecycle bodies; inert engine/Electron only. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { Store } from "../../electron/store/store";
import { AccountRetirement } from "../../electron/account/account-retirement";
import { createIncognitoRetirement } from "../../electron/app/incognito-retirement";
import { runShutdown } from "../../electron/app/shutdown";
import {
  newAdapterScope,
  inAdapterScope,
} from "../../electron/official-ui/api/scope";
import { readState, writeState } from "../../electron/official-ui/api/state";
import {
  loadFileRegistry,
  knownFile,
} from "../../electron/official-ui/api/files";
import { coworkFolderGrants } from "../../electron/workspace/cowork-folders";
const noop = () => {};
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => (resolve = r)),
    resolve: () => resolve(),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
function fixture(t: any) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "incognito-retirement-inert-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root),
    selected = new Map<string, any>();
  const attachment = (id: string) => {
    const name = id + ".txt",
      file = path.join(root, "attachments", id, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "synthetic " + id);
    const row = {
      id,
      name,
      path: file,
      size: fs.statSync(file).size,
      kind: "file",
    };
    selected.set(id, row);
    return row;
  };
  const privateFile = attachment("11111111"),
    sharedFile = attachment("22222222");
  const turn = (id: string, attachments: any[]) => ({
    id,
    prompt: "synthetic",
    attachments,
    items: [],
    status: "completed",
    createdAt: 1,
  });
  const ordinary: any = {
    id: "ordinary",
    title: "ordinary",
    mode: "chat",
    turns: [turn("ordinary-turn", [sharedFile])],
    createdAt: 1,
    updatedAt: 1,
  };
  const temporary: any = {
    id: "temporary",
    title: "temporary",
    mode: "chat",
    incognito: true,
    turns: [turn("temporary-turn", [privateFile, sharedFile])],
    createdAt: 1,
    updatedAt: 1,
  };
  store.conversations = [ordinary, temporary];
  store.flush();
  const ordinaryBefore = JSON.stringify(ordinary);
  const scope = newAdapterScope("synthetic-owner", root, store);
  const registry = {
    files: [privateFile, sharedFile].map((a) => ({
      id: a.id,
      name: a.name,
      path: a.path,
      size: a.size,
      mediaType: "text/plain",
      kind: "blob",
      conversationId: temporary.id,
      createdAt: 1,
    })),
    aliases: [
      ["private-alias", privateFile.id],
      ["shared-alias", sharedFile.id],
    ],
  };
  inAdapterScope(scope, () => {
    writeState("files", () => registry);
    readState("files", {});
    loadFileRegistry();
  });
  coworkFolderGrants(root).memorySessions.set(temporary.id, { extra: [] });
  const deleted: string[] = [];
  const engine = {};
  const make = (extra: any = {}) =>
    createIncognitoRetirement({
      store,
      engine,
      selected,
      feedback: { deleteConversation: (id: string) => deleted.push(id) },
      current: (s, e) => s === store && e === engine,
      stop: noop,
      ...extra,
    });
  const intact = () => {
    assert.equal(fs.existsSync(privateFile.path), true);
    assert.equal(store.conversations.includes(temporary), true);
    assert.equal(
      inAdapterScope(scope, () => !!knownFile("private-alias")),
      true,
    );
  };
  const cleaned = () => {
    assert.equal(fs.existsSync(privateFile.path), false);
    assert.equal(
      fs.readFileSync(sharedFile.path, "utf8"),
      "synthetic 22222222",
    );
    assert.deepEqual(store.conversations, [ordinary]);
    assert.equal(JSON.stringify(ordinary), ordinaryBefore);
    assert.equal(selected.has(privateFile.id), false);
    assert.equal(
      inAdapterScope(scope, () => knownFile("private-alias")),
      undefined,
    );
    assert.equal(
      inAdapterScope(scope, () => knownFile("shared-alias")?.conversationId),
      ordinary.id,
    );
    assert.equal(
      coworkFolderGrants(root).memorySessions.has(temporary.id),
      false,
    );
    const disk: any = inAdapterScope(scope, () => readState("files", {}));
    assert.deepEqual(
      disk.files.map((x: any) => x.id),
      [sharedFile.id],
    );
    assert.deepEqual(disk.aliases, [["shared-alias", sharedFile.id]]);
  };
  return {
    root,
    store,
    selected,
    privateFile,
    sharedFile,
    ordinary,
    temporary,
    scope,
    make,
    intact,
    cleaned,
    deleted,
    engine,
  };
}
test("stop completes before actual file/registry cleanup; ordinary shared file and foreign scope survive", async (t) => {
  const f = fixture(t),
    wait = deferred();
  const foreign = newAdapterScope("foreign-owner", f.root, {});
  inAdapterScope(foreign, () => {
    writeState("files", () => ({ files: [{ id: "foreign" }] }));
    readState("files", {});
    loadFileRegistry();
  });
  const a = f.make({ stop: () => wait.promise });
  const p = inAdapterScope(foreign, () => a.run());
  f.intact();
  assert.equal(a.confirmed, false);
  wait.resolve();
  await p;
  f.cleaned();
  assert.equal(f.selected.has(f.sharedFile.id), true);
  assert.equal(a.confirmed, true);
  assert.deepEqual(f.deleted, ["temporary"]);
  assert.deepEqual(
    inAdapterScope(foreign, () => readState("files", {})),
    { files: [{ id: "foreign" }] },
  );
  f.store.flush();
  const reopened = new Store(f.root);
  assert.deepEqual(reopened.conversations, [f.ordinary]);
  assert.equal(fs.existsSync(f.privateFile.path), false);
});
test("engine rejection retains owner, registry, selected and bytes", async (t) => {
  const f = fixture(t),
    a = f.make({
      stop: async () => {
        throw Error("inert stop failed");
      },
    });
  await assert.rejects(a.run(), /stop failed/);
  f.intact();
  assert.equal(a.confirmed, false);
  assert.equal(f.selected.has(f.privateFile.id), true);
});
test("unsettled turn after stop is not cleaned", async (t) => {
  const f = fixture(t);
  f.temporary.turns[0].status = "inProgress";
  const a = f.make();
  await assert.rejects(a.run(), /still running/);
  f.intact();
  assert.equal(a.confirmed, false);
});
test("account or engine replacement during stop prevents deletion", async (t) => {
  const f = fixture(t),
    wait = deferred();
  let current = true;
  const a = f.make({ current: () => current, stop: () => wait.promise });
  const p = a.run();
  current = false;
  wait.resolve();
  await assert.rejects(p, /superseded/);
  f.intact();
});
test("real rm failure keeps owner and registry; explicit retry uses same known owner", async (t) => {
  const f = fixture(t),
    original = fs.rmSync;
  const mock = t.mock.method(fs, "rmSync", (file: any, options: any) => {
    if (file === path.dirname(f.privateFile.path))
      throw Error("inert rm denial");
    return original(file, options);
  });
  const a = f.make();
  await assert.rejects(a.run(), /rm denial/);
  f.intact();
  assert.equal(a.confirmed, false);
  mock.mock.restore();
  await f.make().run();
  f.cleaned();
});
test("registry flush failure retains owner for a safe retry after partial disk cleanup", async (t) => {
  const f = fixture(t),
    original = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from: any, to: any) => {
    if (String(to).endsWith("/files.json"))
      throw Error("inert registry denial");
    return original(from, to);
  });
  const a = f.make();
  await assert.rejects(a.run(), /state could not be saved/);
  assert.equal(a.confirmed, false);
  assert.equal(f.store.conversations.includes(f.temporary), true);
  mock.mock.restore();
  await f.make().run();
  f.cleaned();
});
test("step timeout cancels cleanup and late stop cannot delete", async (t) => {
  const f = fixture(t),
    wait = deferred(),
    a = f.make({ stop: () => wait.promise });
  const result = await runShutdown(
    [{ name: "engine", run: () => a.run(), cancel: () => a.cancel() }],
    { stepMs: 10, totalMs: 100 },
  );
  assert.deepEqual(result.timedOut, ["engine"]);
  wait.resolve();
  await tick();
  f.intact();
  assert.equal(a.confirmed, false);
});
test("overall timeout cancels active cleanup and never starts later shutdown steps", async (t) => {
  const f = fixture(t),
    wait = deferred(),
    a = f.make({ stop: () => wait.promise });
  let later = 0;
  const result = await runShutdown(
    [
      { name: "engine", run: () => a.run(), cancel: () => a.cancel() },
      {
        name: "later",
        run: () => {
          later++;
        },
      },
    ],
    { stepMs: 100, totalMs: 10 },
  );
  assert.deepEqual(result.timedOut, ["shutdown"]);
  wait.resolve();
  await tick();
  f.intact();
  assert.equal(later, 0);
  assert.equal(a.confirmed, false);
});
test("shutdown records sync and async failure, still runs remaining ordinary steps", async () => {
  let last = false;
  const result = await runShutdown([
    {
      name: "sync",
      run: () => {
        throw Error("inert");
      },
    },
    {
      name: "async",
      run: async () => {
        throw Error("inert");
      },
    },
    {
      name: "last",
      run: () => {
        last = true;
      },
    },
  ]);
  assert.deepEqual(result, { timedOut: [], failed: ["sync", "async"] });
  assert.equal(last, true);
});

/** Execute the actual original lifecycle bodies, with Electron/services inert. */
function source(file: string, start: string, end: string) {
  const text = fs.readFileSync(
    new URL("../../electron/app/" + file, import.meta.url),
    "utf8",
  );
  const from = text.indexOf(start),
    to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return text.slice(from, to);
}
function execute(text: string, bindings: Record<string, any>) {
  const js = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return vm.runInNewContext(js, {
    setTimeout,
    clearTimeout,
    Promise,
    console,
    ...bindings,
  });
}
function state(f: ReturnType<typeof fixture>, stop: () => any = noop) {
  const retirement = new AccountRetirement();
  const id = retirement.beginActivation();
  retirement.finishActivation(id);
  return {
    store: f.store,
    engine: { stop, isBusy: () => false },
    replyFeedback: { deleteConversation: noop },
    accountRetirement: retirement,
    activeAccount: { id: "synthetic" },
    artifactShares: { stop: noop },
  } as any;
}
function quitHarness(
  f: ReturnType<typeof fixture>,
  stop: () => any = noop,
  limits = { stepMs: 30, totalMs: 100 },
) {
  const mainState = state(f, stop),
    done = deferred(),
    errors: string[] = [],
    names: string[] = [];
  let handler: any,
    quit = 0;
  execute(
    source("start-app.ts", '  app.on("before-quit"', "  // The app stays"),
    {
      app: {
        on: (_name: string, fn: any) => (handler = fn),
        quit: () => {
          quit++;
          done.resolve();
        },
      },
      mainState,
      quitConfirmation: { interrupt: false },
      setUpdateQuitInProgress: noop,
      createIncognitoRetirement,
      runShutdown: (steps: any) => {
        names.push(...steps.map((x: any) => x.name));
        return runShutdown(steps, limits);
      },
      ctx: { selectedAttachments: f.selected, services: {} },
      integration: { stop: noop },
      prepareOfficialUiQuit: noop,
      console: { error: (message: string) => errors.push(message) },
    },
  );
  handler({ preventDefault: noop });
  return {
    mainState,
    done: done.promise,
    errors,
    names,
    get quit() {
      return quit;
    },
  };
}
test("actual before-quit stops engine then removes private disk and registry before normal restart", async (t) => {
  const f = fixture(t),
    wait = deferred(),
    h = quitHarness(f, () => wait.promise);
  await tick();
  f.intact();
  wait.resolve();
  await h.done;
  f.cleaned();
  assert.equal(h.quit, 1);
  assert.equal(h.mainState.shutdownComplete, true);
  assert.deepEqual(h.errors, []);
  assert.ok(
    h.names.indexOf("engine and temporary chats") < h.names.indexOf("store"),
  );
  assert.deepEqual(new Store(f.root).conversations, [f.ordinary]);
});
test("actual bounded Quit reports engine/cleanup failures, still quits without claiming cleanup", async (t) => {
  const f = fixture(t),
    h = quitHarness(f, async () => {
      throw Error("inert stop failure");
    });
  await h.done;
  f.intact();
  assert.equal(h.quit, 1);
  assert.deepEqual(h.errors, [
    "Quit went on without: engine and temporary chats",
  ]);
});
test("actual Quit overall timeout cancels late engine cleanup and reports incomplete shutdown", async (t) => {
  const f = fixture(t),
    wait = deferred(),
    h = quitHarness(f, () => wait.promise, { stepMs: 100, totalMs: 10 });
  await h.done;
  assert.deepEqual(h.errors, ["Quit went on without: shutdown"]);
  wait.resolve();
  await tick();
  f.intact();
  assert.equal(h.quit, 1);
});
function retireHarness(f: ReturnType<typeof fixture>, stop: () => any = noop) {
  const mainState = state(f, stop),
    phases: string[] = [],
    notified: string[] = [];
  const body = source(
    "account-lifecycle.ts",
    "const resourceStops =",
    "/** Opens an account",
  );
  const context: any = {
    mainState,
    createIncognitoRetirement,
    activationLocalError: (_code: string, message: string) => Error(message),
    noteActivationPhase: (_error: any, phase: string) => phases.push(phase),
    deactivatingListeners: { emitAsync: async () => {} },
    appWindows: { closeConversationWindows: noop },
    cloudSync: { stop: noop },
    deviceLink: { disconnect: noop },
    usageTurns: { clear: noop },
    artifactPopouts: { closeAll: noop },
    artifactPreviews: { clear: noop },
    selectedAttachments: f.selected,
    selectedFolders: new Map(),
    remoteFolders: new Map(),
    accountDevices: { current: noop },
    shapeMainWindow: noop,
    integration: { reset: noop, apply: noop },
    isShortcutRegistrationFailure: () => false,
    accountDeactivated: () => notified.push("deactivated"),
    exports: {},
  };
  execute(body + "\nglobalThis.capture(exports.deactivateAccount);", {
    ...context,
    capture: (fn: any) => (context.run = fn),
  });
  return { ...context, phases, notified };
}
test("actual deactivateAccount cleans private resources after stop, then clears retired account", async (t) => {
  const f = fixture(t),
    wait = deferred(),
    h = retireHarness(f, () => wait.promise);
  const p = h.run();
  await tick();
  f.intact();
  wait.resolve();
  await p;
  f.cleaned();
  assert.equal(h.mainState.store, undefined);
  assert.equal(h.mainState.engine, undefined);
  assert.deepEqual(h.notified, ["deactivated"]);
  assert.deepEqual(h.phases, []);
  assert.deepEqual(new Store(f.root).conversations, [f.ordinary]);
});
test("actual deactivateAccount preserves known owner on cleanup error and a later retirement retries", async (t) => {
  const f = fixture(t),
    h = retireHarness(f),
    original = fs.rmSync;
  const mock = t.mock.method(fs, "rmSync", (file: any, options: any) => {
    if (file === path.dirname(f.privateFile.path))
      throw Error("inert rm denial");
    return original(file, options);
  });
  await assert.rejects(h.run(), /rm denial/);
  f.intact();
  assert.equal(h.mainState.store, f.store);
  assert.equal(h.mainState.activeAccount.id, "synthetic");
  assert.deepEqual(h.phases, ["cleanup.incognito"]);
  assert.deepEqual(h.notified, []);
  mock.mock.restore();
  await h.run();
  f.cleaned();
  assert.equal(h.mainState.store, undefined);
});
test("hide close path remains separate and has no retirement cleanup wiring", () => {
  const root = new URL("../../electron/app/main-window.ts", import.meta.url);
  const text = fs.readFileSync(root, "utf8");
  assert.match(text, /\.hide\(\)/);
  assert.doesNotMatch(
    text,
    /createIncognitoRetirement|discardIncognitoAttachments/,
  );
});
test("actual Quit logs file cleanup failure, retains known owner, and respects existing bounded exit", async (t) => {
  const f = fixture(t),
    original = fs.rmSync;
  const mock = t.mock.method(fs, "rmSync", (file: any, options: any) => {
    if (file === path.dirname(f.privateFile.path))
      throw Error("inert rm denial");
    return original(file, options);
  });
  const h = quitHarness(f);
  await h.done;
  f.intact();
  assert.equal(h.quit, 1);
  assert.deepEqual(h.errors, [
    "Quit went on without: engine and temporary chats",
  ]);
  mock.mock.restore();
});
test("actual account retirement engine failure leaves the account owner and files intact", async (t) => {
  const f = fixture(t),
    h = retireHarness(f, async () => {
      throw Error("inert stop failure");
    });
  await assert.rejects(h.run(), /stop failure/);
  f.intact();
  assert.equal(h.mainState.store, f.store);
  assert.deepEqual(h.phases, ["cleanup.engine"]);
  assert.deepEqual(h.notified, []);
});
test("overall timeout before engine step prevents that step from ever starting", async (t) => {
  const f = fixture(t),
    first = deferred();
  let stops = 0;
  const a = f.make({
    stop: () => {
      stops++;
    },
  });
  const result = await runShutdown(
    [
      { name: "earlier service", run: () => first.promise },
      { name: "engine", run: () => a.run(), cancel: () => a.cancel() },
    ],
    { stepMs: 100, totalMs: 10 },
  );
  a.cancel();
  assert.deepEqual(result.timedOut, ["shutdown"]);
  first.resolve();
  await tick();
  assert.equal(stops, 0);
  f.intact();
});

// The actual engine stop body runs with only RPC/process and unrelated UI services inert.
import { finishTurn } from "../../shared/activity";
import { sameEnvironment } from "../../electron/engine/engine-types";
import { isOutboxTurn } from "../../electron/ssh/outbox";
function engineStop(f: ReturnType<typeof fixture>, wait: Promise<void>) {
  const text = fs.readFileSync(
    new URL("../../electron/engine/engine-lifecycle.ts", import.meta.url),
    "utf8",
  );
  const body = text.slice(
    text.indexOf("export async function stop("),
    text.indexOf("export async function setupWindowsSandbox("),
  );
  let stop: any;
  const order: string[] = [];
  execute(body + "\nglobalThis.capture(exports.stop);", {
    exports: {},
    capture: (fn: any) => (stop = fn),
    startupOwners: new WeakMap(),
    RetiredEngineStartup: Error,
    isOutboxTurn,
    finishTurn,
    pruneCodexCache: () => {
      throw Error("unexpected space cleanup");
    },
  });
  const engine: any = {
    store: f.store,
    environment: { kind: "local" },
    rpc: {
      stop: async () => {
        order.push("rpc");
        await wait;
      },
    },
    gateway: {
      close: async () => {
        order.push("gateway");
      },
    },
    capabilityTips: { stop: noop },
    titleOffers: { stop: noop },
    sessionAssistance: { stop: noop },
    safeguardModels: new Map(),
    windowsSandbox: { reset: noop },
    loaded: new Map(),
    threadLimits: new Map(),
    steers: new Map(),
    routes: new Map(),
    sides: { dropAll: noop },
    agentRoutes: new Map(),
    pendingAgentPrompts: new Map(),
    pendingPatches: new Map(),
    clearApprovals: noop,
    owns: (c: any) => sameEnvironment(c.environment, { kind: "local" }),
    changed: () => order.push("terminal"),
    notificationTimer: new Map(),
  };
  return { engine, order, stop: () => stop.call(engine) };
}
test("actual engine stop terminalizes a native temporary turn only after RPC closes, then retirement cleans", async (t) => {
  const f = fixture(t),
    wait = deferred();
  f.temporary.turns[0].status = "inProgress";
  const e = engineStop(f, wait.promise);
  const a = f.make({
    engine: e.engine,
    current: (s: any, engine: any) => s === f.store && engine === e.engine,
    stop: e.stop,
  });
  const p = a.run();
  await tick();
  f.intact();
  assert.equal(f.temporary.turns[0].status, "inProgress");
  assert.deepEqual(e.order, ["rpc"]);
  wait.resolve();
  await p;
  assert.equal(f.temporary.turns[0].status, "interrupted");
  assert.deepEqual(e.order, ["rpc", "gateway", "terminal"]);
  f.cleaned();
});
test("actual engine early-turn exclusion remains uncleaned rather than losing its known owner", async (t) => {
  const f = fixture(t);
  f.temporary.turns[0].status = "inProgress";
  const e = engineStop(f, Promise.resolve());
  e.engine.earlyTurn = f.temporary.turns[0];
  const a = f.make({ engine: e.engine, current: () => true, stop: e.stop });
  await assert.rejects(a.run(), /still running/);
  f.intact();
  assert.equal(a.confirmed, false);
});
