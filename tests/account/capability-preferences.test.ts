import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { accountOf } from "../../electron/official-ui/api/bootstrap";
import { connectorsRoute } from "../../electron/official-ui/api/connectors";
import {
  inAdapterScope,
  newAdapterScope,
} from "../../electron/official-ui/api/scope";

async function patch(ctx: any, body: unknown) {
  const req: any = Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    { method: "PATCH" },
  );
  let status = 0,
    text = "";
  const res: any = {
    writeHead: (s: number) => {
      status = s;
    },
    end: (s = "") => {
      text += s;
    },
  };
  await inAdapterScope(
    newAdapterScope(ctx.account().id, ctx.root, ctx.sessionIdentity()),
    () => connectorsRoute(req, res, "/api/account/settings", ctx),
  );
  return { status, body: JSON.parse(text) };
}

test("capability PATCH updates the existing preferences and bootstrap projection", async () => {
  let settings: any = { providers: [] },
    saves = 0;
  const identity = {};
  const ctx: any = {
    root: "build/official-ui",
    account: () => ({ id: "owner" }),
    settings: () => settings,
    sessionIdentity: () => identity,
    isCurrent: () => true,
    localCall: async (name: string, next: any) => {
      assert.equal(name, "saveSettings");
      saves++;
      settings = next;
    },
    call: async () => {
      throw Error("unexpected call");
    },
  };
  assert.equal(accountOf(ctx)!.settings.tool_search_mode, "on");
  assert.equal(accountOf(ctx)!.settings.enabled_connector_suggestions, true);
  assert.equal(accountOf(ctx)!.settings.enabled_web_search, true);
  for (const [body, key, value] of [
    [{ tool_search_mode: "off" }, "toolAccessMode", "loaded"],
    [{ enabled_connector_suggestions: false }, "connectorSearch", false],
    [{ enabled_web_search: false }, "chatWebSearch", false],
    [{ tool_search_mode: "on" }, "toolAccessMode", "needed"],
    [{ enabled_connector_suggestions: true }, "connectorSearch", true],
    [{ enabled_web_search: true }, "chatWebSearch", true],
  ] as const) {
    const result = await patch(ctx, body);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, body);
    assert.equal(settings[key], value);
    const projected = accountOf(ctx)!.settings;
    if ("tool_search_mode" in body)
      assert.equal(projected.tool_search_mode, body.tool_search_mode);
    else if ("enabled_connector_suggestions" in body)
      assert.equal(
        projected.enabled_connector_suggestions,
        body.enabled_connector_suggestions,
      );
    else assert.equal(projected.enabled_web_search, body.enabled_web_search);
  }
  assert.equal(saves, 6);
  assert.equal((await patch(ctx, { tool_search_mode: "on" })).status, 200);
  assert.equal(saves, 6);
  for (const body of [
    { tool_search_mode: "auto" },
    { enabled_connector_suggestions: "false" },
    { enabled_web_search: "false" },
    { tool_search_mode: "off", enabled_connector_suggestions: false },
    { tool_search_mode: "off", other: true },
  ])
    assert.equal((await patch(ctx, body)).status, 400);
  assert.equal(saves, 6);
  ctx.readOnly = true;
  assert.equal((await patch(ctx, { tool_search_mode: "off" })).status, 403);
  assert.equal(saves, 6);
});

test("account activation changes do not acknowledge a stale preference save", async () => {
  let settings: any = { providers: [] },
    identity: object = {};
  const ctx: any = {
    root: "build/official-ui",
    account: () => ({ id: "owner" }),
    settings: () => settings,
    sessionIdentity: () => identity,
    isCurrent: () => true,
    localCall: async (_name: string, next: any) => {
      settings = next;
      identity = {};
    },
    call: async () => {
      throw Error("unexpected call");
    },
  };
  assert.equal(
    (await patch(ctx, { enabled_connector_suggestions: false })).status,
    409,
  );
});

test("Code switch accepts only an unchanged tool access companion", async () => {
  let settings: any = {
    providers: [],
    modelAutoFallback: true,
    toolAccessMode: "loaded",
  };
  let saves = 0;
  const identity = {};
  const ctx: any = {
    root: "build/official-ui",
    account: () => ({ id: "owner" }),
    settings: () => settings,
    sessionIdentity: () => identity,
    isCurrent: () => true,
    localCall: async (_name: string, next: any) => {
      saves++;
      settings = next;
    },
    call: async () => {
      throw Error("unexpected call");
    },
  };
  const body = {
    ccr_switch_models_on_flag: false,
    enabled_model_auto_fallback: true,
    tool_search_mode: "off",
  };
  assert.equal((await patch(ctx, body)).status, 200);
  assert.equal(settings.switchModelsOnFlag, false);
  assert.equal(settings.toolAccessMode, "loaded");
  assert.equal(
    (
      await patch(ctx, {
        ...body,
        ccr_switch_models_on_flag: true,
        tool_search_mode: "on",
      })
    ).status,
    409,
  );
  assert.equal(settings.switchModelsOnFlag, false);
  assert.equal(saves, 1);
});

test("network, AI artifacts and location wire preferences save and project exactly", async () => {
  let settings: any = {
    providers: [],
    networkEgress: false,
    egressAllowlist: "none",
    egressDomains: ["old.example.com"],
  };
  let saves = 0;
  const identity = {};
  const ctx: any = {
    root: "build/official-ui",
    account: () => ({ id: "owner" }),
    settings: () => settings,
    sessionIdentity: () => identity,
    isCurrent: () => true,
    localCall: async (_name: string, next: any) => {
      saves++;
      settings = next;
    },
  };
  const enable = {
    enabled_wiggle_egress: true,
    wiggle_egress_hosts_template: "package_managers",
    wiggle_egress_allowed_hosts: [],
  };
  assert.deepEqual(await patch(ctx, enable), { status: 200, body: enable });
  assert.equal(saves, 1);
  assert.deepEqual(
    [settings.networkEgress, settings.egressAllowlist, settings.egressDomains],
    [true, "packages", []],
  );
  assert.equal((await patch(ctx, enable)).status, 200);
  assert.equal(saves, 1);
  for (const body of [
    { wiggle_egress_hosts_template: "custom" },
    { wiggle_egress_allowed_hosts: ["api.example.com", "*.example.org"] },
    { enabled_wiggle_egress: false },
    { enabled_turmeric: true },
    { enabled_geolocation: false },
  ])
    assert.deepEqual(await patch(ctx, body), { status: 200, body });
  const projected = accountOf(ctx)!.settings;
  assert.equal(projected.wiggle_egress_hosts_template, "custom");
  assert.deepEqual(projected.wiggle_egress_allowed_hosts, [
    "api.example.com",
    "*.example.org",
  ]);
  assert.equal(projected.enabled_wiggle_egress, false);
  assert.equal(projected.enabled_turmeric, true);
  assert.equal(settings.aiArtifacts, true);
  assert.equal(projected.enabled_geolocation, false);
  assert.equal(settings.locationMetadata, false);
  for (const body of [
    { wiggle_egress_allowed_hosts: ["*"] },
    { wiggle_egress_allowed_hosts: ["*.com"] },
    { ...enable, wiggle_egress_hosts_template: "full_egress" },
    { enabled_turmeric: true, enabled_wiggle_egress: true },
  ])
    assert.equal((await patch(ctx, body)).status, 400);
});
