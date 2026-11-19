import test from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityDocumentReader,
  resolveCapabilityDocument,
  type CapabilityInputs,
  type CapabilitySource,
} from "../../electron/official-ui/api/capability-document";
const ready = <T>(value: T): CapabilitySource<T> => ({ state: "ready", value });
const subject = {
  accountId: "account-a",
  activationId: "opaque-fixture-activation",
};
function input(): CapabilityInputs {
  return {
    host: ready({
      kind: "desktop",
      capabilities: { localCode: true, cloudCode: false, cloudCowork: false },
    } as never),
    policy: ready({ webSearch: true } as never),
    memory: ready({
      available: true,
      allowed: { generate: true, searchChats: true },
      prefs: { generate: false, searchChats: true },
      synthesizing: false,
    }),
    searchModel: ready({
      modelId: "fixture-model",
      protocol: "responses",
      webSearch: "native",
    }),
    adapter: ready({
      execution: "enabled",
      modes: ["chat", "code.native", "cowork.native"],
      memoryRead: true,
      memoryWrite: true,
      nativeCowork: true,
    }),
  };
}
const resolve = (i = input()) => resolveCapabilityDocument(subject, i);
test("versioned real facts preserve separate preferences and native/cloud availability", () => {
  const r = resolve();
  assert.equal(r.version, 1);
  assert.deepEqual(r.subject, subject);
  assert.equal(r.capabilities["chat.web_search"].state, "allowed");
  assert.equal(r.capabilities["code.native"].state, "allowed");
  assert.equal(r.capabilities["code.cloud"].state, "unavailable");
  assert.equal(r.capabilities["cowork.native"].state, "allowed");
  assert.equal(r.capabilities["memory.generation_control"].state, "allowed");
  assert.equal(r.capabilities["memory.generation_control"].enabled, false);
});
test("absence and source error remain distinct, without desktop/paid/UI defaults", () => {
  const i = input();
  i.host = { state: "absent" };
  i.policy = { state: "error" };
  i.memory = { state: "absent" };
  const r = resolve(i);
  assert.equal(r.capabilities["code.native"].state, "unknown");
  assert.equal(r.capabilities["code.native"].reason, "host_absent");
  assert.equal(r.capabilities["chat.web_search"].state, "unavailable");
  assert.equal(r.capabilities["chat.web_search"].reason, "policy_error");
  assert.equal(r.capabilities["memory.read"].state, "unknown");
  assert.equal(r.sources.policy, "error");
});
test("policy denial is not user preference off and is not unavailable model support", () => {
  const i = input();
  i.policy = ready({ webSearch: false } as never);
  assert.equal(resolve(i).capabilities["chat.web_search"].state, "denied");
  i.policy = ready({ webSearch: true } as never);
  i.searchModel = ready({
    modelId: "fixture",
    protocol: "chat",
    webSearch: "native",
  });
  assert.equal(resolve(i).capabilities["chat.web_search"].state, "unavailable");
  i.searchModel = { state: "absent" };
  assert.equal(resolve(i).capabilities["chat.web_search"].state, "unknown");
});
test("read-only and mode absence do not infer actions from chat availability", () => {
  const i = input();
  i.adapter = ready({
    execution: "read_only",
    modes: ["chat", "code.native"],
    memoryRead: true,
    memoryWrite: false,
    nativeCowork: true,
  });
  const r = resolve(i);
  assert.equal(r.capabilities["code.native"].state, "read_only");
  assert.equal(r.capabilities["chat.web_search"].state, "read_only");
  assert.equal(r.capabilities["cowork.native"].state, "unavailable");
  assert.equal(r.capabilities["memory.read"].state, "allowed");
  assert.equal(r.capabilities["memory.generation_control"].state, "read_only");
});
test("cloud host does not acquire native execution and missing native cowork fact is unknown", () => {
  const i = input();
  i.host = ready({
    kind: "web",
    capabilities: { localCode: true, cloudCode: true, cloudCowork: true },
  } as never);
  if (i.adapter.state === "ready")
    i.adapter.value.modes = ["chat", "code.cloud", "cowork.cloud"];
  const r = resolve(i);
  assert.equal(r.capabilities["code.native"].state, "unavailable");
  assert.equal(r.capabilities["code.cloud"].state, "allowed");
  assert.equal(r.capabilities["cowork.cloud"].state, "allowed");
  const j = input();
  if (j.adapter.state === "ready") delete j.adapter.value.nativeCowork;
  assert.equal(resolve(j).capabilities["cowork.native"].state, "unknown");
  j.adapter = { state: "error" };
  assert.equal(
    resolve(j).capabilities["cowork.native"].reason,
    "adapter_error",
  );
});
test("memory policy/offline/unsupported/read-only source distinctions are preserved", () => {
  for (const [reason, state] of [
    ["policy", "denied"],
    ["offline", "unavailable"],
    ["unsupported", "unavailable"],
  ] as const) {
    const i = input();
    if (i.memory.state === "ready") {
      i.memory.value.available = false;
      i.memory.value.reason = reason;
    }
    assert.equal(
      resolve(i).capabilities["memory.generation_control"].state,
      state,
    );
  }
  const i = input();
  if (i.memory.state === "ready") i.memory.value.allowed.searchChats = false;
  assert.equal(
    resolve(i).capabilities["memory.chat_search_control"].state,
    "denied",
  );
});
test("resolver never mutates source or copies raw extra fields into document", () => {
  const i = input();
  const before = JSON.stringify(i);
  const raw: any = i;
  raw.host.value.privateToken = "not-a-real-secret-fixture";
  const r = resolve(i);
  assert.doesNotMatch(
    JSON.stringify(r),
    /privateToken|not-a-real-secret-fixture/,
  );
  delete raw.host.value.privateToken;
  assert.equal(JSON.stringify(i), before);
  const bad = input();
  bad.policy = ready({ webSearch: "yes" } as never);
  assert.equal(resolve(bad).capabilities["chat.web_search"].state, "unknown");
});
test("reader binds owner and activation, rejects late source data, retires permanently", async () => {
  let owner = "a",
    activation: any = { raw: "never-serialize-fixture" };
  let change = false;
  let reads = 0;
  const original = activation;
  const read = createCapabilityDocumentReader(
    { accountId: () => owner, sessionIdentity: () => activation },
    async () => {
      reads++;
      if (change) activation = {};
      return input();
    },
  );
  const first = await read();
  assert.equal(first.status, 200);
  if (first.status === 200) {
    assert.equal(first.document.subject.accountId, "a");
    assert.doesNotMatch(JSON.stringify(first), /never-serialize/);
    assert.notEqual(first.document.subject.activationId, String(original));
  }
  change = true;
  assert.deepEqual(await read(), { status: 409, error: "activation_changed" });
  activation = original;
  assert.deepEqual(await read(), { status: 409, error: "activation_changed" });
  assert.equal(reads, 2);
  const switched = createCapabilityDocumentReader(
    { accountId: () => owner, sessionIdentity: () => 1 },
    async () => {
      owner = "b";
      return input();
    },
  );
  assert.equal((await switched()).status, 409);
});
test("signed-out/retired reader never loads facts and loader errors are sanitized", async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    return input();
  };
  assert.equal(
    (
      await createCapabilityDocumentReader(
        { accountId: () => undefined, sessionIdentity: () => 1 },
        load,
      )()
    ).status,
    401,
  );
  assert.equal(
    (
      await createCapabilityDocumentReader(
        {
          accountId: () => "a",
          sessionIdentity: () => 1,
          isCurrent: () => false,
        },
        load,
      )()
    ).status,
    409,
  );
  assert.equal(calls, 0);
  const result = await createCapabilityDocumentReader(
    { accountId: () => "a", sessionIdentity: () => 1 },
    async () => {
      throw Error("/private/source failed");
    },
  )();
  assert.deepEqual(result, { status: 503, error: "facts_unavailable" });
});

test("memory generation policy is not proof stored documents cannot be read; missing search metadata remains unknown", () => {
  const i = input();
  if (i.memory.state === "ready") {
    i.memory.value.available = false;
    i.memory.value.reason = "policy";
  }
  assert.equal(resolve(i).capabilities["memory.read"].state, "unknown");
  assert.equal(
    resolve(i).capabilities["memory.generation_control"].state,
    "denied",
  );
  i.searchModel = ready({ modelId: "fixture", protocol: "responses" });
  assert.equal(
    resolve(i).capabilities["chat.web_search"].reason,
    "search_model_metadata_absent",
  );
});

test("host cloud support cannot promote native-only adapter wiring into cloud execution", () => {
  const i = input();
  if (i.host.state === "ready") {
    i.host.value.capabilities.cloudCode = true;
    i.host.value.capabilities.cloudCowork = true;
  }
  const r = resolve(i);
  assert.equal(r.capabilities["code.native"].state, "allowed");
  assert.equal(r.capabilities["code.cloud"].state, "unavailable");
  assert.equal(r.capabilities["cowork.cloud"].state, "unavailable");
});
