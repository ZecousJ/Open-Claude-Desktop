import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { CloudStore } from "../../runner/src/cloud-store";
import { memoryWebstore } from "./runner-core-support.test";
import { defaultGuardOptions } from "../../runner/src/method-guard";
import { encodeWireValue } from "../../shared/web-wire";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  isOfficialUiModelPreference,
  officialUiCapabilitiesPath,
  officialUiRequestLimit,
} from "../../shared/official-ui-web";
import { openPolicy } from "../../shared/client-policy";

const catalog = {
  defaultModel: "alpha",
  items: [
    {
      id: "alpha",
      displayName: "Alpha",
      sort: 0,
      hidden: false,
      isDefault: true,
      description: "",
      badges: [],
      usageHint: "",
      efforts: ["low", "high"],
      defaultEffort: "high",
    },
    {
      id: "beta",
      displayName: "Beta",
      sort: 1,
      hidden: true,
      isDefault: false,
      description: "",
      badges: [],
      usageHint: "",
      efforts: [],
    },
  ],
};
async function fixture(t: any, web = memoryWebstore(), userId = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-model-preference-"));
  let identity: unknown = {};
  const store = await CloudStore.open({
    root,
    userId,
    transport: web,
    log() {},
  });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ctx: any = {
    userId,
    activeAccount: { id: `owner-${userId}` },
    store,
    officialSessionIdentity: () => identity,
    setAccessToken() {},
    onEvent: () => () => {},
    log() {},
    appVersion: "test",
    policy: () => openPolicy,
    settingsListeners: { emit() {} },
  };
  const dispatcher: any = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: true,
    },
    guard: defaultGuardOptions,
    context: () => ctx,
    contextFor: async () => ctx,
    now: () => 1,
    run: async (frame: any) => {
      if (frame.method === "modelCatalog") return catalog;
      if (frame.method === "snapshot")
        return { settings: store.settings, projects: [], conversations: [] };
      throw Error(`Unexpected method ${frame.method}`);
    },
  };
  const run = (
    request: any,
    method = request.method === "GET" ? "officialUiRead" : "officialUiAction",
  ) =>
    officialUiRead(dispatcher, {
      t: "call",
      id: "test",
      user: { id: userId, accessToken: "synthetic" },
      method,
      args: encodeWireValue([request]),
    } as any) as Promise<any>;
  const decode = (answer: any) =>
    JSON.parse(Buffer.from(answer.body).toString());
  const cap = async () =>
    decode(await run({ method: "GET", path: officialUiCapabilitiesPath }));
  const route = (surface = "chat", owner = `owner-${userId}`) =>
    `/api/organizations/${organizationUuid(owner)}/model_selector_state/${surface}`;
  const save = async (
    body: unknown,
    surface = "chat",
    lease?: string,
    owner?: string,
  ) =>
    run({
      method: "PATCH",
      path: route(surface, owner),
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(body)),
      capabilityLease: lease ?? (await cap()).activationLease,
    });
  return {
    ctx,
    dispatcher,
    store,
    web,
    run,
    decode,
    route,
    save,
    cap,
    retire() {
      identity = {};
    },
  };
}
test("original model and thinking writes reach account webstore and survive a new runner store", async (t) => {
  const f = await fixture(t);
  const before = f.store.settings.instructions;
  assert.equal(
    (
      await f.save({
        model: "alpha",
        thinking: { type: "effort_and_mode", effort: "low", mode: "auto" },
      })
    ).status,
    200,
  );
  assert.equal((await f.save({ model: "beta" }, "code")).status, 200);
  assert.equal(f.store.settings.instructions, before);
  const reopened = await fixture(t, f.web);
  assert.deepEqual(reopened.store.settings.officialModelPreferences, {
    chat: {
      model: "alpha",
      thinking: { type: "effort_and_mode", effort: "low", mode: "auto" },
    },
    code: { model: "beta" },
  });
  const changed = await reopened.save({ model: "beta" });
  assert.equal(changed.status, 200);
  assert.equal(f.decode(changed).model, "beta");
  const reset = await reopened.save({ model: null, thinking: null });
  assert.equal(f.decode(reset).model, "alpha");
  const bob = await fixture(t, f.web, 2);
  assert.equal(bob.store.settings.officialModelPreferences, undefined);
});
test("catalog, surface, organization, request method and current lease constrain preference writes", async (t) => {
  const f = await fixture(t);
  for (const body of [
    { model: "unknown" },
    { model: "beta", thinking: { type: "effort", effort: "high" } },
    { model: "alpha", instructions: "forbidden" },
    {},
  ])
    assert.equal((await f.save(body)).status, 400);
  assert.equal((await f.save({ model: "beta" }, "nonexistent")).status, 400);
  assert.equal(
    (await f.save({ model: "beta" }, "chat", undefined, "other")).status,
    404,
  );
  const lease = (await f.cap()).activationLease;
  f.retire();
  assert.equal((await f.save({ model: "beta" }, "chat", lease)).status, 409);
  assert.equal(f.store.settings.officialModelPreferences, undefined);
  assert.equal(isOfficialUiModelPreference("POST", f.route()), false);
  assert.equal(isOfficialUiModelPreference("PATCH", f.route() + "?x=1"), false);
  assert.equal(officialUiRequestLimit("PATCH", f.route()), 4096);
});
test("save failures are visible and do not dispatch a second mutation; disabled actions remain read only", async (t) => {
  const f = await fixture(t);
  let saves = 0;
  const previous = f.store.settings;
  f.store.persistModelPreference = async () => {
    saves++;
    throw Error("Synthetic persistence failure");
  };
  assert.equal((await f.save({ model: "beta" })).status, 503);
  assert.equal(saves, 1);
  assert.equal(f.store.settings, previous);
  f.dispatcher.options.officialUiActions = false;
  await assert.rejects(f.save({ model: "beta" }));
  assert.equal(saves, 1);
});
