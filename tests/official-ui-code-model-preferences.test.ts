/** Real adapter + metadata save with isolated Store; no SDK or network. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import { Store } from "../electron/store/store";
import { CloudStore } from "../runner/src/cloud-store";
import { saveCodeModelPreference } from "../electron/ipc/code-model-preferences";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";

const tiers = ["low", "medium", "high", "xhigh", "max"];
const common = {
  displayName: "Fixture",
  description: "",
  badges: [],
  sort: 0,
  hidden: false,
  isDefault: false,
  usageHint: "",
};
const selection = (
  choice: object,
  expected: object = { providerId: "p", model: "all", effort: "high" },
) => ({ model: { version: 1, expected, choice } });

test("the existing Code session rejects a drawing model from an out-of-date picker", async (t) => {
  const f = fixture(t);
  const drawing = "gpt-image-2.5";
  f.catalog.items.push({ ...common, id: drawing });
  f.store.settings.providers[0].models.push(drawing);
  f.store.flush();

  await assert.rejects(
    async () => f.run("setModel", "local_one", drawing),
    /This account cannot use the selected model/,
  );
  assert.equal(new Store(f.root).conversation("one").model, "all");
  assert.equal(f.events.length, 0);
});

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f082-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.settings.providers = [
    {
      id: "p",
      name: "Fixture",
      protocol: "responses",
      baseUrl: "https://never-called.invalid",
      model: "all",
      models: ["all", "limited", "none", "missing"],
    },
  ];
  store.settings.codeEffort = "high";
  const c: any = {
    id: "one",
    mode: "code",
    title: "Fixture",
    providerId: "p",
    model: "all",
    effort: "high",
    cwd: root,
    turns: [],
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
  };
  store.conversations.push(c, { ...structuredClone(c), id: "other" });
  store.flush();
  let account = "owner",
    identity = {},
    generation = 0,
    readOnly = false,
    current = true;
  let gate: Promise<void> | undefined;
  let beforeWrite: (() => void) | undefined;
  const catalog: any = {
    defaultModel: "all",
    items: [
      { ...common, id: "all", efforts: tiers, defaultEffort: "medium" },
      {
        ...common,
        id: "limited",
        efforts: ["low", "max"],
        defaultEffort: "max",
      },
      { ...common, id: "none", efforts: [] },
      { ...common, id: "missing" },
    ],
  };
  const calls: any[] = [],
    events: any[] = [];
  const context: any = {
    store,
    accountGeneration: () => generation,
    engine: {
      modelEfforts: (_: string, model: string) =>
        catalog.items.find((row: any) => row.id === model)?.efforts ?? [],
      codeUltracodeAvailable: (_: string, model: string) => model === "all",
      codeUltracodeThreadAvailable: async () => true,
    },
    push: (event: any) => events.push(event),
  };
  const ipc = new Map<string, Function>();
  registerConversationManageHandlers({
    context,
    engineOf: () => context.engine,
    handle: ((name: string, fn: Function) => ipc.set(name, fn)) as never,
  });
  const handlers = new Map<string, Function>();
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: account }),
      sessionIdentity: () => identity,
      get readOnly() {
        return readOnly;
      },
      isCurrent: () => current,
      settings: () => store.settings,
      modelCatalog: async () => {
        await gate;
        return catalog;
      },
      localLoadConversation: async (id: string) =>
        structuredClone(store.conversations.find((row) => row.id === id)),
      localCall: async (name: string, id: string, patch: any) => {
        calls.push([name, id, patch]);
        assert.equal(name, "updateConversation");
        beforeWrite?.();
        return ipc.get(name)!(id, patch);
      },
      onEvent: () => () => {},
      log() {},
    },
    on: (name: string, fn: Function) => handlers.set(name, fn),
    emit() {},
  } as never);
  return {
    root,
    store,
    c,
    context,
    catalog,
    calls,
    events,
    ipc: (id: string, patch: unknown) =>
      ipc.get("updateConversation")!(id, patch),
    run: (name: string, ...args: any[]) =>
      handlers.get("LocalSessions." + name)!(...args),
    beforeWrite: (fn: () => void) => {
      beforeWrite = fn;
    },
    gate: (value: Promise<void>) => {
      gate = value;
    },
    retire: () => {
      identity = {};
      generation++;
    },
    switch: () => {
      account = "replacement";
      identity = {};
      generation++;
    },
    readOnly: () => {
      readOnly = true;
    },
    notCurrent: () => {
      current = false;
    },
  };
}
for (const tier of tiers)
  test(`original adapter saves ${tier}, retains history and survives Store reopen`, async (t) => {
    const f = fixture(t),
      before = structuredClone(f.c.turns);
    await f.run("applyFlagSettings", "local_one", {
      effortLevel: tier,
      ultracode: false,
    });
    assert.equal(f.c.effort, tier);
    assert.equal(new Store(f.root).conversation("one").effort, tier);
    assert.equal(new Store(f.root).conversation("other").effort, "high");
    assert.equal(f.store.settings.codeEffort, "high");
    assert.deepEqual(f.c.turns, before);
    assert.equal(f.events.length, 1);
  });
test("model switches select supported defaults, clear no-effort models, and persist repeated choices", async (t) => {
  const f = fixture(t);
  await f.run("setModel", "local_one", "limited");
  assert.equal(f.c.model, "limited");
  assert.equal(f.c.effort, "max");
  await f.run("setEffort", "local_one", "low");
  await f.run("setEffort", "local_one", null);
  assert.equal(f.c.effort, "max");
  await f.run("setModel", "local_one", "none");
  assert.equal(f.c.effort, undefined);
  await f.run("setModel", "local_one", "all");
  assert.equal(f.c.effort, "medium");
  await f.run("setModel", "local_one", "all");
  assert.equal(new Store(f.root).conversation("one").effort, "medium");
});
test("unsupported, absent, ambiguous and stale capabilities never write", async (t) => {
  const f = fixture(t);
  await f.run("setModel", "local_one", "limited");
  const before = f.calls.length;
  for (const effort of [
    "medium",
    "high",
    "xhigh",
    "ultra",
    "none",
    "minimal",
    "bogus",
    undefined,
    3,
    {},
    [],
  ])
    await assert.rejects(async () => f.run("setEffort", "local_one", effort));
  for (const model of ["unavailable", "", " ", 3, null, "a".repeat(201)])
    await assert.rejects(async () => f.run("setModel", "local_one", model));
  assert.equal(f.calls.length, before);
  for (const model of ["none", "missing"]) {
    await f.run("setModel", "local_one", model);
    await assert.rejects(
      async () => f.run("setEffort", "local_one", "low"),
      /not supported/,
    );
  }
  f.catalog.items.push({ ...f.catalog.items[0] });
  await assert.rejects(
    async () => f.run("setModel", "local_one", "all"),
    /unavailable/,
  );
});
test("local atomic write failure leaves memory and disk unchanged; explicit retry succeeds", async (t) => {
  const f = fixture(t),
    original = f.store.write;
  f.store.write = () => {
    throw Error("inert disk failure");
  };
  await assert.rejects(
    async () => f.run("setEffort", "local_one", "low"),
    /disk failure/,
  );
  assert.equal(f.c.effort, "high");
  assert.equal(new Store(f.root).conversation("one").effort, "high");
  assert.equal(f.events.length, 0);
  f.store.write = original;
  await f.run("setEffort", "local_one", "low");
  assert.equal(new Store(f.root).conversation("one").effort, "low");
});
test("late capability reads after retirement, account switch, or another model choice never overwrite", async (t) => {
  for (const change of ["retire", "switch", "model"] as const) {
    const f = fixture(t);
    let release!: () => void;
    f.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = f.run("setEffort", "local_one", "low");
    await new Promise((resolve) => setImmediate(resolve));
    if (change === "model") f.c.model = "limited";
    else f[change]();
    const rejected = assert.rejects(pending, /changed/);
    release();
    await rejected;
    assert.equal(f.calls.length, 0);
    assert.equal(f.c.effort, "high");
  }
});
test("ownership, local-session, current-host and read-only boundaries precede all writes", async (t) => {
  for (const change of [
    (f: any) => f.readOnly(),
    (f: any) => f.notCurrent(),
    (f: any) => {
      f.c.sessionAuthors = {
        ownerAccountUuid: "other",
        viewerAccountUuid: "owner",
      };
    },
    (f: any) => {
      f.c.mode = "chat";
    },
    (f: any) => {
      f.c.cloudHosted = true;
    },
    (f: any) => {
      f.c.environment = { kind: "ssh", hostId: "other" };
    },
  ]) {
    const f = fixture(t);
    change(f);
    await assert.rejects(async () => f.run("setModel", "local_one", "limited"));
    assert.equal(f.calls.length, 0);
  }
  for (const id of [null, 1, "one", "local_missing"]) {
    const f = fixture(t);
    await assert.rejects(async () => f.run("setEffort", id, "low"));
    assert.equal(f.calls.length, 0);
  }
});
test("saving the next-turn preference preserves a fabricated running history unchanged", async (t) => {
  const f = fixture(t);
  f.c.turns.push({
    id: "turn",
    status: "inProgress",
    model: "all",
    effort: "high",
    prompt: "Inert",
    items: [],
    attachments: [],
    createdAt: 1,
  });
  const before = structuredClone(f.c.turns);
  await f.run("setModel", "local_one", "limited");
  assert.deepEqual(f.c.turns, before);
  assert.equal(f.c.model, "limited");
});
test("known backend capability changes refuse a stale adapter choice before persistence", async (t) => {
  const f = fixture(t);
  f.context.engine.modelEfforts = () => ["high"];
  await assert.rejects(
    async () => f.run("setEffort", "local_one", "low"),
    /not supported/,
  );
  assert.equal(f.c.effort, "high");
  assert.equal(f.events.length, 0);
});

test("versioned IPC compares the exact prior choice and rejects unsupported envelopes without writing", async (t) => {
  const f = fixture(t);
  for (const patch of [
    selection(
      { effort: "low" },
      { providerId: "p", model: "limited", effort: "high" },
    ),
    selection(
      { effort: "low" },
      { providerId: "p", model: "all", effort: "low" },
    ),
    selection({ effort: "low", title: "Injected" }),
    { ...selection({ effort: "low" }), title: "Injected" },
    {
      model: {
        version: 2,
        expected: { providerId: "p", model: "all", effort: "high" },
        choice: { effort: "low" },
      },
    },
    selection({}),
  ])
    await assert.rejects(async () => f.ipc("one", patch));
  assert.equal(f.c.effort, "high");
  assert.equal(f.events.length, 0);
  assert.equal(new Store(f.root).conversation("one").effort, "high");
});

test("classic plain-string Code model and application ultra requests retain their original behavior", async (t) => {
  const f = fixture(t);
  await f.ipc("one", { providerId: "p", model: "limited" });
  await f.ipc("one", { effort: "ultra" });
  assert.equal(f.c.model, "limited");
  assert.equal(f.c.effort, "ultra");
});

test("model catalog failures and explicit Code schema gaps never publish a false save", async (t) => {
  const f = fixture(t);
  f.catalog.items[0].efforts = ["none", "minimal"];
  await assert.rejects(
    async () => f.run("setModel", "local_one", "all"),
    /not supported by Code yet/,
  );
  f.gate(Promise.reject(Error("inert catalog failure")));
  await assert.rejects(
    async () => f.run("setEffort", "local_one", "low"),
    /catalog failure/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 0);
});
test("cloud save failure is unconfirmed, never reported as a local rollback or success", async (t) => {
  const f = fixture(t);
  let fail = true;
  const cloud = new CloudStore({
    root: path.join(f.root, "cloud"),
    userId: 1,
    log() {},
    transport: {
      request: async (op) => {
        if (op === "store.conversations.put" && fail)
          throw Error("inert service failure");
        return {};
      },
    },
  });
  t.after(async () => {
    fail = false;
    await cloud.close();
  });
  cloud.settings = f.store.settings;
  cloud.conversations.push(structuredClone(f.c));
  f.context.store = cloud;
  await assert.rejects(
    saveCodeModelPreference(f.context, cloud.conversations[0], {
      effort: "low",
    }),
    /could not be confirmed/,
  );
  assert.equal(cloud.conversations[0].effort, "low");
  assert.equal(f.events.length, 0);
});

test("a newer choice between the native reread and IPC dispatch rejects the older request", async (t) => {
  const f = fixture(t);
  f.beforeWrite(() => {
    f.c.effort = "max";
    f.store.flush();
  });
  await assert.rejects(
    async () => f.run("setEffort", "local_one", "low"),
    /model changed/,
  );
  assert.equal(f.c.effort, "max");
  assert.equal(new Store(f.root).conversation("one").effort, "max");
  assert.equal(f.events.length, 0);
});

test("Ultracode is a session choice, and switching to a model without xhigh clears it", async (t) => {
  const f = fixture(t);
  const expected = (codeUltracode: boolean) => ({
    providerId: "p", model: "all", effort: "high", codeUltracode,
  });
  await f.ipc("one", selection({ codeUltracode: true }, expected(false)));
  assert.equal(new Store(f.root).conversation("one").codeUltracode, true);
  assert.equal(new Store(f.root).conversation("other").codeUltracode, undefined);
  assert.equal(f.c.effort, "high");
  assert.equal(f.store.settings.codeEffort, "high");
  await assert.rejects(async () =>
    f.ipc("one", selection({ codeUltracode: false }, expected(false))), /model changed/);
  await assert.rejects(async () =>
    f.ipc("one", selection({ model: "limited", codeUltracode: true }, expected(true))), /Ultracode is unavailable/);
  await f.ipc("one", selection({ model: "limited", effort: "max" }, expected(true)));
  assert.equal(f.events.length, 2);
  const reopened = new Store(f.root).conversation("one");
  assert.deepEqual([reopened.model, reopened.effort, reopened.codeUltracode], ["limited", "max", false]);
});

test("CloudStore confirms Ultracode and model in one row before publishing", async (t) => {
  const f = fixture(t);
  let startWrite: (body: unknown) => void;
  const writing = new Promise<unknown>(resolve => { startWrite = resolve; });
  let finishWrite: (() => void) | undefined;
  const cloud = new CloudStore({
    root: path.join(f.root, "cloud"),
    userId: 1,
    log() {},
    transport: {
      request: async (op, userId, body) => {
        assert.equal(userId, 1);
        if (op === "store.conversations.put" && !finishWrite) {
          await new Promise<void>(resolve => {
            finishWrite = resolve;
            startWrite(body);
          });
        }
        return {};
      },
    },
  });
  cloud.settings = f.store.settings;
  const conversation = structuredClone(f.c);
  cloud.conversations.push(conversation);
  f.context.store = cloud;
  try {
    const save = saveCodeModelPreference(f.context, conversation, { effort: "xhigh", codeUltracode: true });
    const saved = await Promise.race([writing, save.then(() => assert.fail("Published before writing"))]);
    assert.equal(conversation.codeUltracode, undefined);
    assert.equal(conversation.effort, "high");
    assert.equal(f.events.length, 0);
    const { doc } = saved as { doc: { conversation: { codeUltracode: boolean; effort: string } } };
    assert.equal(doc.conversation.codeUltracode, true);
    assert.equal(doc.conversation.effort, "xhigh");
    finishWrite?.();
    assert.equal((await save).codeUltracode, true);
    assert.equal(f.events.length, 1);
  } finally {
    finishWrite?.();
    await cloud.close();
  }
});
