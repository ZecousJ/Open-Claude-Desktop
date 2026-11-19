import test from "node:test";
import assert from "node:assert/strict";
import {
  createAdapterCapabilityReader,
  type CapabilityAdapterSources,
} from "../../electron/official-ui/api/capability-adapter";
function fixture() {
  let session: any = { epoch: 1 };
  let account = "a";
  let selection: any = { providerId: "p", modelId: "model-a" };
  const calls: string[] = [];
  const data: any = {
    host: {
      kind: "web",
      capabilities: { cloudCode: true, cloudCowork: true, localCode: false },
    },
    policy: { webSearch: true },
    memory: {
      available: true,
      allowed: { generate: true, searchChats: true },
      prefs: { generate: false, searchChats: true },
      synthesizing: false,
    },
    catalog: { items: [{ id: "model-a", webSearch: "native", hidden: false }] },
    settings: {
      providers: [
        {
          id: "p",
          protocol: "chat",
          model: "model-a",
          models: ["model-a"],
          routes: [
            {
              protocol: "responses",
              models: ["model-a"],
              keyId: "do-not-copy-fixture",
            },
          ],
        },
      ],
    },
  };
  const value = async (name: string) => {
    calls.push(name);
    if (data[name] instanceof Error) throw data[name];
    return data[name];
  };
  const ctx: any = {
    account: () => (account ? { id: account } : undefined),
    sessionIdentity: () => session,
    settings: () => data.settings,
    snapshot: async () => ({ host: await value("host") }),
    modelCatalog: () => value("catalog"),
  };
  const sources: CapabilityAdapterSources = {
    readPolicy: () => value("policy"),
    readMemory: () => value("memory"),
    selectedModel: () => selection,
    wiring: {
      state: "ready",
      value: {
        execution: "enabled",
        modes: ["chat"],
        memoryRead: true,
        memoryWrite: false,
      },
    },
  };
  return {
    ctx,
    sources,
    data,
    calls,
    select: (v: any) => {
      selection = v;
    },
    rotate: () => {
      session = { epoch: 2 };
    },
    account: (v: string) => {
      account = v;
    },
  };
}
test("concrete adapter reads trusted sources, resolves provider group route and keeps Web chat-only", async () => {
  const f = fixture();
  const r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  assert.equal(r.status, 200);
  if (r.status !== 200) return;
  assert.equal(r.document.capabilities["chat.web_search"].state, "allowed");
  assert.equal(r.document.capabilities["code.cloud"].state, "unavailable");
  assert.equal(r.document.capabilities["cowork.cloud"].state, "unavailable");
  assert.equal(
    r.document.capabilities["memory.generation_control"].state,
    "read_only",
  );
  assert.deepEqual(f.calls.sort(), ["catalog", "host", "memory", "policy"]);
  assert.doesNotMatch(JSON.stringify(r), /keyId|do-not-copy/);
});
test("missing snapshot host stays unknown; explicit native source never masks snapshot errors", async () => {
  const f = fixture();
  f.data.host = undefined;
  let r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  assert.equal(r.status, 200);
  if (r.status === 200) assert.equal(r.document.sources.host, "absent");
  f.sources.nativeHost = () =>
    ({ kind: "desktop", capabilities: { localCode: true } }) as never;
  r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  if (r.status === 200) assert.equal(r.document.sources.host, "ready");
  f.ctx.snapshot = async () => {
    throw Error("host private details");
  };
  r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  assert.equal(r.status, 200);
  if (r.status === 200) assert.equal(r.document.sources.host, "error");
  assert.doesNotMatch(JSON.stringify(r), /private details/);
});
test("policy/memory/catalog absent and errors are captured separately without logging", async () => {
  const f = fixture();
  f.data.policy = null;
  f.data.memory = Error("private memory");
  f.data.catalog = Error("private model");
  const r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  assert.equal(r.status, 200);
  if (r.status === 200) {
    assert.equal(r.document.sources.policy, "absent");
    assert.equal(r.document.sources.memory, "error");
    assert.equal(r.document.sources.searchModel, "error");
  }
  assert.doesNotMatch(JSON.stringify(r), /private/);
});
test("selection must match real provider and catalog; no active/default model guessing", async () => {
  for (const selection of [
    null,
    { providerId: "missing", modelId: "model-a" },
    { providerId: "p", modelId: "missing" },
  ]) {
    const f = fixture();
    f.select(selection);
    const r = await createAdapterCapabilityReader(f.ctx, f.sources)();
    if (r.status === 200)
      assert.equal(r.document.sources.searchModel, "absent");
    else assert.fail();
  }
  const f = fixture();
  f.data.settings.providers[0].models = [];
  f.data.settings.providers[0].model = "other";
  f.data.settings.providers[0].routes = [];
  const r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  if (r.status === 200) assert.equal(r.document.sources.searchModel, "absent");
  else assert.fail();
});
test("selected model changing during reads is not presented as current model capability", async () => {
  const f = fixture();
  f.sources.readPolicy = async () => {
    f.select({ providerId: "p", modelId: "new-model" });
    return f.data.policy;
  };
  const r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  if (r.status === 200) assert.equal(r.document.sources.searchModel, "error");
  else assert.fail();
});
test("same account reactivation and account switch suppress all late facts", async () => {
  for (const change of ["rotate", "account"] as const) {
    const f = fixture();
    f.sources.readMemory = async () => {
      change === "rotate" ? f.rotate() : f.account("b");
      return f.data.memory;
    };
    const reader = createAdapterCapabilityReader(f.ctx, f.sources);
    assert.deepEqual(await reader(), {
      status: 409,
      error: "activation_changed",
    });
    const before = f.calls.length;
    assert.equal((await reader()).status, 409);
    assert.equal(f.calls.length, before);
  }
});
test("concurrent reads share stable opaque activation and do not mutate supplied wiring", async () => {
  const f = fixture();
  const reader = createAdapterCapabilityReader(f.ctx, f.sources);
  if (f.sources.wiring.state === "ready") {
    f.sources.wiring.value.modes = ["chat", "code.cloud"];
    f.sources.wiring.value.memoryWrite = true;
  }
  const results = await Promise.all([reader(), reader(), reader()]);
  const ids = new Set<string>();
  for (const r of results) {
    assert.equal(r.status, 200);
    if (r.status === 200) {
      ids.add(r.document.subject.activationId);
      assert.equal(r.document.capabilities["code.cloud"].state, "unavailable");
      assert.equal(
        r.document.capabilities["memory.generation_control"].state,
        "read_only",
      );
    }
  }
  assert.equal(ids.size, 1);
});
test("signed-out reader never touches source methods", async () => {
  const f = fixture();
  f.account("");
  assert.equal(
    (await createAdapterCapabilityReader(f.ctx, f.sources)()).status,
    401,
  );
  assert.equal(f.calls.length, 0);
});

test("actual pendingPolicy identity and explicit pending provenance remain unknown, never admin denial", async () => {
  const { pendingPolicy } = await import("../../shared/client-policy");
  const f = fixture();
  f.data.policy = pendingPolicy;
  let r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  assert.equal(r.status, 200);
  if (r.status === 200) {
    assert.equal(r.document.sources.policy, "pending");
    assert.equal(r.document.capabilities["chat.web_search"].state, "unknown");
    assert.equal(
      r.document.capabilities["chat.web_search"].reason,
      "policy_pending",
    );
  }
  f.sources.readPolicy = async () => {
    throw Error("Must not call raw policy when provenance supplied");
  };
  f.sources.readPolicySource = async () => ({ state: "pending" });
  r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  if (r.status === 200) assert.equal(r.document.sources.policy, "pending");
  else assert.fail();
});

test("More-model visibility does not erase a real selected model capability", async () => {
  const f = fixture();
  f.data.catalog.items[0].hidden = true;
  const r = await createAdapterCapabilityReader(f.ctx, f.sources)();
  assert.equal(r.status, 200);
  if (r.status === 200) {
    assert.equal(r.document.sources.searchModel, "ready");
    assert.equal(r.document.capabilities["chat.web_search"].state, "allowed");
  }
});
