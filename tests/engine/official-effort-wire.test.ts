/** Pure in-memory gateway boundary audit. No listeners, real keys or network. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { Gateway } from "../../electron/engine/gateway";
import { effortForMode } from "../../shared/code-effort";
import type { Provider } from "../../shared/types";
async function capture(
  t: any,
  protocol: "responses" | "chat",
  request: Record<string, unknown>,
  routeProtocol?: "responses" | "chat",
  contracts?: { model: string; efforts: string[] }[],
  expectedFetch = 1,
) {
  const provider: Provider = {
    id: "fixture",
    name: "Fixture",
    model: "fixture-model",
    models: ["fixture-model"],
    baseUrl: "https://never-called.invalid/v1",
    protocol,
    ...(routeProtocol
      ? {
          routes: [
            {
              models: ["fixture-model"],
              protocol: routeProtocol,
              keyId: "fixture-route",
              primary: true,
            },
          ],
        }
      : {}),
  } as Provider;
  const gateway = new Gateway(() => ({ provider, apiKey: "" }));
  gateway.setRequestOptions({
    describeTools: false,
    xSearchModels: [],
    ...(contracts ? { modelEfforts: contracts } : {}),
  });
  const captured: { url: string; body: any }[] = [];
  const mock = t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init: any) => {
      captured.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("inert capture complete", { status: 400 });
    },
  );
  const req: any = Readable.from([
    Buffer.from(
      JSON.stringify({
        model: "fixture-model",
        input: [],
        stream: true,
        ...request,
      }),
    ),
  ]);
  req.method = "POST";
  req.url = "/v1/responses";
  req.headers = { authorization: `Bearer ${gateway.token}` };
  const res: any = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = (status: number) => {
    res.statusCode = status;
    res.headersSent = true;
    return res;
  };
  res.end = () => {
    res.writableEnded = true;
    return res;
  };
  try {
    await (gateway as any).handle(req, res);
  } finally {
    mock.mock.restore();
  }
  assert.equal(
    captured.length,
    expectedFetch,
    "Only expected mocked fetch boundaries are reached",
  );
  assert.equal(
    res.statusCode,
    400,
    "The capture response is not model success",
  );
  return captured[0] ?? { url: "", body: undefined };
}
for (const protocol of ["responses", "chat"] as const) {
  test(`actual ${protocol} gateway preserves supplied effort when catalog contract is unknown`, async (t) => {
    const r = await capture(t, protocol, { reasoning: { effort: "high" } });
    assert.equal(
      protocol === "chat" ? r.body.reasoning_effort : r.body.reasoning.effort,
      "high",
    );
    assert.ok(
      r.url.endsWith(protocol === "chat" ? "/chat/completions" : "/responses"),
    );
  });
  test(`actual ${protocol} gateway itself does not invent absent effort`, async (t) => {
    const r = await capture(t, protocol, {});
    assert.equal(r.body.reasoning_effort, undefined);
    assert.equal(r.body.reasoning?.effort, undefined);
  });
}
test("model route chooses final Chat protocol and preserves incoming effort", async (t) => {
  const r = await capture(
    t,
    "responses",
    { reasoning: { effort: "max" } },
    "chat",
  );
  assert.ok(r.url.endsWith("/chat/completions"));
  assert.equal(r.body.reasoning_effort, "max");
});
test("actual engine preference helper resolves global effort without catalog knowledge", () => {
  const settings = { effort: "high", codeEffort: "ultra" } as const;
  assert.equal(effortForMode(settings, "chat"), "high");
  assert.equal(effortForMode(settings, "code"), "ultra");
  assert.deepEqual(settings, { effort: "high", codeEffort: "ultra" });
});
test("real engine send injects saved/global effort into mocked RPC despite omitted request effort", async (t) => {
  const [{ Engine }, { Store }, { openPolicy }, fs, os, path] =
    await Promise.all([
      import("../../electron/engine/engine"),
      import("../../electron/store/store"),
      import("../../shared/client-policy"),
      import("node:fs"),
      import("node:os"),
      import("node:path"),
    ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "effort-engine-"));
  const store = new Store(root);
  t.after(() => {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("No network permitted in effort engine test");
  });
  store.settings.effort = "high";
  store.settings.codeEffort = "ultra";
  store.settings.providers = [
    {
      id: "p",
      name: "Fixture",
      protocol: "responses",
      baseUrl: "https://never-called.invalid/v1",
      model: "m",
      models: ["m"],
    },
  ];
  store.settings.activeProviderId = "p";
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  const calls: { method: string; params: any }[] = [];
  engine.rpc = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start")
        return { thread: { id: "fixture-thread" } };
      if (method === "turn/start") return { turn: { id: "fixture-turn" } };
      return {};
    },
  } as any;
  const priorOptions = {
    describeTools: true,
    xSearchModels: [],
    modelEfforts: [{ model: "m", efforts: ["high"] }],
  };
  engine.sentRequestOptions = JSON.stringify(priorOptions);
  engine.modelEfforts = () => [];
  engine.gateway = {
    setRequestOptions: async () => {
      throw Error("inert update failure");
    },
  } as any;
  store.conversations.push({
    id: "blocked",
    title: "Fixture",
    mode: "chat",
    providerId: "p",
    model: "m",
    threadId: "blocked-thread",
    cwd: root,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  } as any);
  await assert.rejects(
    engine.send({
      conversationId: "blocked",
      text: "Inert blocked send",
      mode: "chat",
      providerId: "p",
      model: "m",
      attachments: [],
    }),
    /could not be synchronized/,
  );
  assert.equal(
    calls.length,
    0,
    "Failed effort update must precede all turn/thread RPC",
  );
  engine.gateway = undefined;
  for (const saved of [undefined, "low"] as const) {
    const id = saved ?? "global";
    const c: any = {
      id,
      title: "Fixture",
      mode: "chat",
      providerId: "p",
      model: "m",
      threadId: "fixture-thread",
      cwd: root,
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
      ...(saved ? { effort: saved } : {}),
    };
    store.conversations.push(c);
    (engine as any).loaded.add("fixture-thread");
    (engine as any).routes.set("fixture-thread", id);
    await engine.send({
      conversationId: id,
      text: "Local inert fixture",
      mode: "chat",
      providerId: "p",
      model: "m",
      attachments: [],
    });
    const turn = calls.filter((c) => c.method === "turn/start").at(-1);
    assert.ok(turn, "Mock RPC must receive turn/start");
    assert.equal(turn.params.effort, saved ?? "high");
    c.turns.at(-1).status = "completed";
  }
  assert.equal(
    store.settings.effort,
    "high",
    "No user-global setting is changed",
  );
});

for (const protocol of ["responses", "chat"] as const) {
  test(`${protocol} known no-effort strips fallback without changing other reasoning fields`, async (t) => {
    const request = { reasoning: { effort: "high", summary: "auto" } };
    const r = await capture(t, protocol, request, undefined, [
      { model: "fixture-model", efforts: [] },
    ]);
    assert.equal(r.body.reasoning_effort, undefined);
    assert.equal(r.body.reasoning?.effort, undefined);
    if (protocol === "responses")
      assert.equal(r.body.reasoning.summary, "auto");
    assert.deepEqual(request.reasoning, { effort: "high", summary: "auto" });
  });
  test(`${protocol} known supported effort is preserved and forbidden effort makes no outbound call`, async (t) => {
    const contracts = [{ model: "fixture-model", efforts: ["low", "high"] }];
    const r = await capture(
      t,
      protocol,
      { reasoning: { effort: "low" } },
      undefined,
      contracts,
    );
    assert.equal(
      protocol === "chat" ? r.body.reasoning_effort : r.body.reasoning.effort,
      "low",
    );
    await capture(
      t,
      protocol,
      { reasoning: { effort: "ultra" } },
      undefined,
      contracts,
      0,
    );
  });
  test(`${protocol} missing catalog item remains unknown rather than stripping`, async (t) => {
    const r = await capture(
      t,
      protocol,
      { reasoning: { effort: "high" } },
      undefined,
      [{ model: "other", efforts: [] }],
    );
    assert.equal(
      protocol === "chat" ? r.body.reasoning_effort : r.body.reasoning.effort,
      "high",
    );
  });
}
test("model alias and selected protocol route normalize before known effort filtering", async (t) => {
  const r = await capture(
    t,
    "responses",
    { model: "fixture-model~tools-loaded", reasoning: { effort: "high" } },
    "chat",
    [{ model: "fixture-model", efforts: [] }],
  );
  assert.equal(r.body.model, "fixture-model");
  assert.equal(r.body.reasoning_effort, undefined);
  assert.ok(r.url.endsWith("/chat/completions"));
});
test("peer requestOptions parser bounds metadata, rejects duplicates/invalid values, and copies arrays", async () => {
  const { parseRequestOptions } = await import("../../shared/gateway-signals");
  const input = {
    describeTools: false,
    xSearchModels: [],
    modelEfforts: [
      { model: "constructor", efforts: [] },
      { model: "fixture-model", efforts: ["low"] },
    ],
  };
  const parsed = parseRequestOptions(input);
  assert.ok(parsed);
  input.modelEfforts[1].efforts.push("high");
  assert.deepEqual(parsed.modelEfforts?.[1].efforts, ["low"]);
  for (const modelEfforts of [
    [{ model: "m", efforts: null }],
    [{ model: "m", efforts: ["bogus"] }],
    [
      { model: "m", efforts: [] },
      { model: "m", efforts: [] },
    ],
    Array.from({ length: 501 }, (_, i) => ({ model: String(i), efforts: [] })),
  ])
    assert.equal(parseRequestOptions({ ...input, modelEfforts }), undefined);
});
test("RemoteHost cached effort getter never invokes refresh-capable modelCatalog", async () => {
  const { RemoteHost } = await import("../../electron/remote/host");
  const backend: any = {
    provider: { id: "p" },
    catalog: { items: [{ id: "m" }] },
    serviceGroups: () => [],
  };
  const host = new RemoteHost({ store: { settings: {} } } as any, backend);
  host.ready = true;
  host.modelCatalog = () => {
    throw Error("refresh-capable method must not be called");
  };
  host.refreshModels = () => {
    throw Error("refresh must not be called");
  };
  assert.deepEqual(host.modelEfforts("p", "m"), []);
  assert.equal(host.modelEfforts("other", "m"), undefined);
  backend.catalog.items[0].efforts = ["low"];
  assert.deepEqual(host.modelEfforts("p", "m"), ["low"]);
  backend.catalog.items[0].efforts = null;
  assert.equal(host.modelEfforts("p", "m"), undefined);
  backend.catalog = null;
  assert.equal(host.modelEfforts("p", "m"), undefined);
});

test("effort IPC synchronization fails closed on changes/removal, records only acknowledged contracts", async () => {
  const { syncRequestOptions } =
    await import("../../electron/engine/engine-status");
  const base = {
    describeTools: false,
    xSearchModels: [],
    modelEfforts: [{ model: "m", efforts: ["low", "high"] }],
  };
  let next: any = { ...base, modelEfforts: [{ model: "m", efforts: [] }] };
  let fail = true,
    calls = 0;
  const host: any = {
    sentRequestOptions: JSON.stringify(base),
    requestOptions: () => next,
    gateway: {
      setRequestOptions: async () => {
        calls++;
        if (fail) throw Error("inert IPC failure");
      },
    },
  };
  await assert.rejects(
    syncRequestOptions.call(host, {} as any),
    /could not be synchronized/,
  );
  assert.equal(host.sentRequestOptions, JSON.stringify(base));
  fail = false;
  await syncRequestOptions.call(host, {} as any);
  assert.equal(host.sentRequestOptions, JSON.stringify(next));
  // Account/source transition to unknown must not silently retain old no-effort rules.
  fail = true;
  next = { describeTools: false, xSearchModels: [] };
  await assert.rejects(
    syncRequestOptions.call(host, {} as any),
    /could not be synchronized/,
  );
  // Semantically unchanged reordered lists preserve historical non-effort failure behavior.
  host.sentRequestOptions = JSON.stringify(base);
  next = {
    ...base,
    describeTools: true,
    modelEfforts: [{ model: "m", efforts: ["high", "low"] }],
  };
  await syncRequestOptions.call(host, {} as any);
  assert.equal(host.sentRequestOptions, JSON.stringify(base));
  assert.equal(calls, 4);
});

test("engine requestOptions forwards only valid cached contracts and never truncates excess known models", async () => {
  const { requestOptions } =
    await import("../../electron/engine/engine-status");
  const allowed = ["low"];
  const engine: any = {
    describeTools: false,
    xSearchAllowed: () => false,
    modelEfforts: (_p: string, m: string) =>
      m === "known" ? allowed : m === "none" ? [] : undefined,
  };
  const provider: any = {
    id: "p",
    model: "known",
    models: ["known", "none", "unknown"],
    protocol: "responses",
  };
  const options = requestOptions.call(engine, provider);
  assert.deepEqual(options.modelEfforts, [
    { model: "known", efforts: ["low"] },
    { model: "none", efforts: [] },
  ]);
  allowed.push("high");
  assert.deepEqual(options.modelEfforts?.[0].efforts, ["low"]);
  engine.modelEfforts = () => [];
  provider.models = Array.from({ length: 501 }, (_, i) => String(i));
  assert.throws(() => requestOptions.call(engine, provider), /exceeds/);
});
