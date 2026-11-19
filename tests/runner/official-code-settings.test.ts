import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AdapterContext } from "../../electron/official-ui/api/context";
import { CloudClient } from "../../electron/cloud/cloud-client";
import { createCloudCodeSettings } from "../../electron/cloud/cloud-code-settings";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import { openPolicy } from "../../shared/client-policy";
import { officialCodeSettingsPath } from "../../shared/official-code-settings";
import { settingsSchema } from "../../electron/store/settings-schema";
import {
  officialUiCapabilitiesPath,
  type OfficialUiReadRequest,
} from "../../shared/official-ui-web";
import { encodeWireValue } from "../../shared/web-wire";
import { parseRpcRequest, webPaths } from "../../shared/web-protocol";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("original Web Code settings save through the authenticated Runner and reopen by account", async (t) => {
  useElectronShim();
  const [{ CloudStore }, { officialUiRead }, { Store }] = await Promise.all([
    import("../../runner/src/cloud-store"),
    import("../../runner/src/official-ui-read"),
    import("../../electron/store/store"),
  ]);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "official-code-settings-"),
  );
  const webstore = memoryWebstore();
  let pause = false;
  const writing = signal();
  const release = signal();
  const transport = {
    async request(op: string, userId: number, body?: unknown) {
      if (pause && op === "store.settings.put") {
        pause = false;
        writing.resolve();
        await release.promise;
      }
      return webstore.request(op, userId, body);
    },
  };
  const open = (name: string, userId = 1) =>
    CloudStore.open({ root: path.join(root, name), userId, transport });
  let identity = {};
  let events = 0;
  const ctx = {
    userId: 1,
    activeAccount: { id: "code-settings-owner" },
    store: await open("first"),
    officialSessionIdentity: () => identity,
    accountRetiring: false,
    policy: () => openPolicy,
    setAccessToken() {},
    settingsChanged() {
      events++;
    },
    handlers: new Map(),
    services: {},
    log() {},
  };
  t.after(async () => {
    release.resolve();
    await ctx.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  ctx.store.settings.instructions = "Keep the user's existing instructions.";
  const dispatcher = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: true,
    },
    guard: { modes: ["chat", "code"] },
    methods: [],
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
  } as unknown as Dispatcher;
  const call = (method: string, request: OfficialUiReadRequest) =>
    officialUiRead(dispatcher, {
      method,
      user: { id: ctx.userId, accessToken: "fixture" },
      args: encodeWireValue([request]),
    } as CallFrame);
  const read = (request: OfficialUiReadRequest) =>
    call("officialUiRead", request);
  const action = (request: OfficialUiReadRequest) =>
    call("officialUiAction", request);
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    read,
    async () => assert.fail("Code settings escaped the local bridge"),
    undefined,
    negotiatedOfficialAction({
      mode: "engine-chat",
      accountId: "1",
      isCurrent: () => true,
      read,
      action,
    }),
  );
  let desktop = new Store(path.join(root, "desktop"));
  desktop.settings.codeBranchPrefix = "device";
  desktop.settings.instructions = "Desktop instructions";
  let linked = true;
  const cloudReadStarted = signal();
  const releaseCloudRead = signal();
  let pauseCloudRead = false;
  const desktopSession = {
    currentToken: async () => "fixture-desktop-token",
    renewed: async () => assert.fail("Desktop token unexpectedly expired."),
  };
  const client = new CloudClient({
    baseUrl: "https://fixture.invalid",
    randomId: () => "desktop-fixture",
    session: () => desktopSession,
    async fetch(input, init) {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fixture-desktop-token",
      );
      const url = new URL(String(input));
      assert.equal(url.origin, "https://fixture.invalid");
      assert.ok(url.pathname.startsWith(webPaths.rpc));
      const method = url.pathname.slice(webPaths.rpc.length);
      const { args } = parseRpcRequest(JSON.parse(String(init?.body)));
      const request = args[0] as OfficialUiReadRequest;
      if (pauseCloudRead && request.path === officialCodeSettingsPath) {
        cloudReadStarted.resolve();
        await releaseCloudRead.promise;
      }
      const answer = await call(method, request);
      return Response.json({ ok: true, value: encodeWireValue(answer) });
    },
  });
  const desktopLease = {
    client,
    userId: 1,
    current: () => linked,
    apply: (
      patch: import("../../shared/official-code-settings").CodeSettingsPatch,
    ) => {
      desktop.settings = { ...desktop.settings, ...patch };
      desktop.flush();
    },
  };
  const sync = createCloudCodeSettings(() =>
    linked ? desktopLease : undefined,
  );
  await sync.refresh();
  assert.equal(desktop.settings.codeBranchPrefix, "device");
  assert.deepEqual(
    JSON.parse(
      Buffer.from(
        (await read({ method: "GET", path: officialCodeSettingsPath })).body,
      ).toString(),
    ),
    {},
  );
  const request = (body: unknown) => ({
    method: "PATCH" as const,
    path: "/api/account/settings",
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(body)),
  });
  const save = (body: unknown) =>
    fetch("/api/account/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const checkSettings = async (prefix: string, autoArchive: boolean) => {
    const response = await fetch("/api/account");
    assert.equal(response.status, 200);
    const { settings } = await response.json();
    assert.equal(settings.ccr_branch_prefix, prefix);
    assert.equal(settings.ccr_auto_archive_on_pr_close, autoArchive);
  };
  await checkSettings("claude", false);
  const mutation = {
    ccr_branch_prefix: "fixture.7",
    ccr_auto_archive_on_pr_close: true,
  };
  for (const invalid of [
    { ccr_branch_prefix: "main" },
    { ccr_branch_prefix: "release-next" },
    { ccr_branch_prefix: "foo..bar" },
    { ccr_branch_prefix: "foo.lock" },
    { ccr_branch_prefix: "a".repeat(41) },
    { ccr_auto_archive_on_pr_close: "true" },
    { ...mutation, chat_font: "sans" },
  ]) {
    assert.equal((await save(invalid)).status, 400);
  }
  assert.equal((await action(request(mutation))).status, 409);
  assert.equal(
    webstore.log.filter((entry) => entry.op === "store.settings.put").length,
    0,
  );

  pause = true;
  const saving = save(mutation);
  await writing.promise;
  await checkSettings("claude", false);
  assert.equal(events, 0);
  release.resolve();
  const answer = await saving;
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.deepEqual(await answer.json(), mutation);
  assert.equal(events, 1);
  assert.equal(
    ctx.store.settings.instructions,
    "Keep the user's existing instructions.",
  );
  await checkSettings("fixture.7", true);
  pauseCloudRead = true;
  const retiredRead = sync.refresh();
  await cloudReadStarted.promise;
  linked = false;
  releaseCloudRead.resolve();
  await retiredRead;
  assert.equal(desktop.settings.codeBranchPrefix, "device");
  linked = true;
  pauseCloudRead = false;
  await sync.refresh();
  desktop = new Store(desktop.root);
  assert.equal(desktop.settings.codeBranchPrefix, "fixture.7");
  assert.equal(desktop.settings.prAutoArchive, true);
  assert.equal(desktop.settings.instructions, "Desktop instructions");
  const bootstrap = await (await fetch("/api/bootstrap")).json();
  assert.equal(
    bootstrap.org_growthbook.features["4074912323"].defaultValue,
    true,
  );
  assert.equal(bootstrap.account.settings.ccr_branch_prefix, "fixture.7");
  assert.equal(bootstrap.account.settings.ccr_auto_archive_on_pr_close, true);

  const descriptor = JSON.parse(
    Buffer.from(
      (await read({ method: "GET", path: officialUiCapabilitiesPath })).body,
    ).toString(),
  );
  await ctx.store.close();
  ctx.store = await open("reopened");
  identity = {};
  await checkSettings("fixture.7", true);
  assert.equal(
    (
      await action({
        ...request({ ccr_branch_prefix: "stale" }),
        capabilityLease: descriptor.activationLease,
      })
    ).status,
    409,
  );
  const other = await open("other", 2);
  assert.equal(other.settings.codeBranchPrefix ?? "claude", "claude");
  assert.equal(other.settings.prAutoArchive ?? false, false);
  await other.close();

  assert.equal(await sync.save({ codeBranchPrefix: "from-desktop" }), true);
  await checkSettings("from-desktop", true);
  assert.equal(desktop.settings.codeBranchPrefix, "from-desktop");
  linked = false;
  assert.equal(await sync.save({ codeBranchPrefix: "device-only" }), false);
  await checkSettings("from-desktop", true);
  linked = true;
  assert.equal(
    (await save({ ccr_branch_prefix: "", ccr_auto_archive_on_pr_close: false }))
      .status,
    200,
  );
  await ctx.store.close();
  ctx.store = await open("reset");
  identity = {};
  await checkSettings("claude", false);
  sync.receive(desktopLease, ctx.store.settings);
  assert.equal(desktop.settings.codeBranchPrefix, "claude");
  assert.equal(desktop.settings.prAutoArchive, false);
  const toolSearch = { tool_search_mode: "off" };
  const connectorSuggestions = { enabled_connector_suggestions: false };
  assert.equal((await action(request(toolSearch))).status, 409);
  for (const invalid of [
    { tool_search_mode: "auto" },
    { enabled_connector_suggestions: "false" },
    { ...toolSearch, ...connectorSuggestions },
    { ...toolSearch, chat_font: "sans" },
  ]) assert.equal((await save(invalid)).status, 400);
  assert.deepEqual(await (await save(toolSearch)).json(), toolSearch);
  assert.deepEqual(await (await save(connectorSuggestions)).json(), connectorSuggestions);
  const account = await (await fetch("/api/account")).json();
  assert.equal(account.settings.tool_search_mode, "off");
  assert.equal(account.settings.enabled_connector_suggestions, false);
  const networkEnable = {
    enabled_wiggle_egress: true,
    wiggle_egress_hosts_template: "package_managers",
    wiggle_egress_allowed_hosts: [],
  };
  assert.equal((await action(request(networkEnable))).status, 409);
  assert.deepEqual(await (await save(networkEnable)).json(), networkEnable);
  for (const invalid of [
    { wiggle_egress_allowed_hosts: ["*"] },
    { wiggle_egress_allowed_hosts: ["*.com"] },
    { ...networkEnable, wiggle_egress_hosts_template: "full_egress" },
  ])
    assert.equal((await save(invalid)).status, 400);
  for (const body of [
    { wiggle_egress_hosts_template: "custom" },
    { wiggle_egress_allowed_hosts: ["api.example.com"] },
    { enabled_turmeric: true },
    { enabled_geolocation: false },
  ])
    assert.deepEqual(await (await save(body)).json(), body);
  const networkAccount = await (await fetch("/api/account")).json();
  assert.equal(networkAccount.settings.wiggle_egress_hosts_template, "custom");
  assert.deepEqual(networkAccount.settings.wiggle_egress_allowed_hosts, [
    "api.example.com",
  ]);
  assert.equal(networkAccount.settings.enabled_turmeric, true);
  assert.equal(networkAccount.settings.enabled_geolocation, false);
  const capabilityReopen = await open("capability-reopen", 1);
  assert.equal(capabilityReopen.settings.toolAccessMode, "loaded");
  assert.equal(capabilityReopen.settings.connectorSearch, false);
  assert.equal(capabilityReopen.settings.networkEgress, true);
  assert.equal(capabilityReopen.settings.egressAllowlist, "none");
  assert.deepEqual(capabilityReopen.settings.egressDomains, ["api.example.com"]);
  assert.equal(capabilityReopen.settings.aiArtifacts, true);
  assert.equal(capabilityReopen.settings.locationMetadata, false);
  await capabilityReopen.close();
  const capabilityOther = await open("capability-other", 2);
  assert.notEqual(capabilityOther.settings.toolAccessMode, "loaded");
  assert.notEqual(capabilityOther.settings.locationMetadata, false);
  await capabilityOther.close();
  const executionOff = { enabled_monkeys_in_a_barrel: false };
  const artifactsOff = { preview_feature_uses_artifacts: false };
  const executionOn = {
    enabled_monkeys_in_a_barrel: true,
    enabled_artifacts_attachments: false,
    preview_feature_uses_artifacts: true,
  };
  assert.equal((await action(request(executionOff))).status, 409);
  assert.equal((await save(artifactsOff)).status, 409);
  for (const invalid of [
    { enabled_monkeys_in_a_barrel: true },
    { ...executionOn, enabled_artifacts_attachments: true },
    { enabled_artifacts_attachments: false },
    { ...executionOff, enabled_connector_suggestions: true },
  ])
    assert.equal((await save(invalid)).status, 400);
  assert.deepEqual(await (await save(executionOff)).json(), executionOff);
  assert.deepEqual(await (await save(artifactsOff)).json(), artifactsOff);
  assert.equal(ctx.store.settings.chatExecution, false);
  assert.equal(ctx.store.settings.artifacts, false);
  assert.deepEqual(await (await save(executionOn)).json(), executionOn);
  assert.equal(ctx.store.settings.chatExecution, true);
  assert.equal(ctx.store.settings.artifacts, true);
  const capabilitiesAccount = await (await fetch("/api/account")).json();
  assert.equal(capabilitiesAccount.settings.enabled_monkeys_in_a_barrel, true);
  assert.equal(
    capabilitiesAccount.settings.preview_feature_uses_artifacts,
    true,
  );
  assert.equal(
    capabilitiesAccount.settings.enabled_artifacts_attachments,
    false,
  );
  const fallbackPatch = { enabled_model_auto_fallback: false };
  assert.equal((await action(request(fallbackPatch))).status, 409);
  assert.equal((await save(fallbackPatch)).status, 200);
  assert.equal(ctx.store.settings.modelAutoFallback, false);
  assert.equal((await (await fetch("/api/account")).json()).settings.enabled_model_auto_fallback, false);
  assert.equal((await save({ ...fallbackPatch, chat_font: "sans" })).status, 400);
  assert.equal((await save({ ccr_switch_models_on_flag: false, enabled_model_auto_fallback: true })).status, 409);
  assert.equal((await save({ ccr_switch_models_on_flag: false, ...fallbackPatch })).status, 200);
  assert.equal(ctx.store.settings.switchModelsOnFlag, false);
  assert.equal((await save({ ccr_switch_models_on_flag: true, ...fallbackPatch, tool_search_mode: "on" })).status, 409);
  assert.equal((await save({ ccr_switch_models_on_flag: true, ...fallbackPatch, tool_search_mode: "off" })).status, 200);
  assert.equal(ctx.store.settings.switchModelsOnFlag, true);
  assert.equal((await save({ ccr_switch_models_on_flag: false, ...fallbackPatch, tool_search_mode: "off" })).status, 200);
  const own = await open("fallback-reopen", 1);
  assert.equal(own.settings.modelAutoFallback, false);
  assert.equal(own.settings.switchModelsOnFlag, false);
  await own.close();
  const foreign = await open("fallback-other", 2);
  assert.notEqual(foreign.settings.modelAutoFallback, false);
  await foreign.close();
  const resetFallback = { enabled_model_auto_fallback: true, ccr_switch_models_on_flag: null };
  assert.deepEqual(await (await save(resetFallback)).json(), resetFallback);
  assert.equal(ctx.store.settings.modelAutoFallback, true);
  assert.equal(ctx.store.settings.switchModelsOnFlag, undefined);
  webstore.failNext("store.settings.put");
  assert.equal((await save(mutation)).status, 503);
  await checkSettings("claude", false);
  assert.equal(events, 18);
  dispatcher.options.officialUiActions = false;
  const readOnlyBootstrap = await (await fetch("/api/bootstrap")).json();
  assert.equal(
    readOnlyBootstrap.org_growthbook.features["4074912323"].defaultValue,
    false,
  );
});

test("the original desktop PATCH writes the settings read by its local store on reopen", async (t) => {
  useElectronShim();
  const [{ createApiAdapter }, { Store }] = await Promise.all([
    import("../../electron/official-ui/api/index"),
    import("../../electron/store/store"),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-settings-native-"));
  let store = new Store(root);
  let identity = {};
  const account = {
    id: "fixture-owner",
    email: "owner@example.invalid",
    name: "Owner",
    createdAt: 0,
  };
  const ctx = {
    root: path.resolve("build/official-ui"),
    account: () => account,
    sessionIdentity: () => identity,
    isCurrent: () => true,
    stateDirectory: () => root,
    settings: () => store.settings,
    modelCatalog: async () => {
      throw Error("No model catalog in this fixture.");
    },
    snapshot: async () => {
      throw Error("No snapshot in this fixture.");
    },
    call: async () => {
      throw Error("Use the local settings handler.");
    },
    localCall: async (method, settings) => {
      assert.equal(method, "saveSettings");
      store.settings = settingsSchema.parse(settings);
      store.flush();
    },
    appVersion: "fixture",
    log() {},
    listConversations: async () => [],
    loadConversation: async () => undefined,
    onEvent: () => () => {},
  } satisfies AdapterContext;
  const adapter = createApiAdapter(ctx, { scoped: true, migrateLegacy: false });
  const server = http.createServer((req, res) => {
    void adapter(req, res)
      .then((handled) => {
        if (!handled) res.writeHead(404).end();
      })
      .catch(() => {
        res.writeHead(500).end();
      });
  });
  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const saved = await fetch(origin + "/api/account/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ccr_branch_prefix: "native.1",
      ccr_auto_archive_on_pr_close: true,
    }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const patchCapability = (body: object) =>
    fetch(origin + "/api/account/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await patchCapability({ preview_feature_uses_artifacts: false })).status,
    409,
  );
  assert.equal(
    (await patchCapability({ enabled_monkeys_in_a_barrel: false })).status,
    200,
  );
  assert.equal(
    (await patchCapability({ preview_feature_uses_artifacts: false })).status,
    200,
  );
  assert.equal(
    (
      await patchCapability({
        enabled_monkeys_in_a_barrel: true,
        enabled_artifacts_attachments: false,
        preview_feature_uses_artifacts: true,
      })
    ).status,
    200,
  );
  store = new Store(root);
  assert.equal(store.settings.chatExecution, true);
  assert.equal(store.settings.artifacts, true);
  identity = {};
  const bootstrap = await (await fetch(origin + "/api/bootstrap")).json();
  assert.equal(
    bootstrap.org_growthbook.features["4074912323"].defaultValue,
    true,
  );
  assert.equal(bootstrap.account.settings.ccr_branch_prefix, "native.1");
  assert.equal(bootstrap.account.settings.ccr_auto_archive_on_pr_close, true);
});
