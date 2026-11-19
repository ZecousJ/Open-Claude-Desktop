import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { memoryRoute } from "../../electron/official-ui/api/memory";
import {
  usageRoute,
  usageOf,
  spendLimitOf,
} from "../../electron/official-ui/api/usage";
import { organizationUuid } from "../../electron/official-ui/api/context";
function fixture(readOnly = true) {
  let owner = "a",
    session = 1;
  const calls: { name: string; args: unknown[] }[] = [];
  const values: Record<string, any> = {
    memoryStatus: {
      available: true,
      allowed: { generate: true, searchChats: true },
      prefs: { generate: false, searchChats: true },
    },
    memoryControlsState: { doc: null, version: "v1:0:0:0" },
    planUsage: null,
    spendLimit: {
      limitUsd: 25,
      usedUsd: 1.23,
      resetsAt: "2026-12-01T00:00:00.000Z",
    },
    billingInfo: { balance: 12.34 },
    setSpendLimit: {
      limitUsd: 25,
      usedUsd: 1.23,
      resetsAt: "2026-12-01T00:00:00.000Z",
    },
  };
  let hook: (() => void) | undefined;
  const ctx: any = {
    readOnly,
    account: () => (owner ? { id: owner } : undefined),
    sessionIdentity: () => session,
    snapshot: async () => ({ projects: [{ id: "project-a" }] }),
    call: async (name: string, ...args: unknown[]) => {
      calls.push({ name, args });
      hook?.();
      if (values[name] instanceof Error) throw values[name];
      if (name === "setSpendLimit") return { ...values[name], limitUsd: args[0] };
      return values[name];
    },
    log() {},
  };
  async function run(
    suffix: string,
    method = "GET",
    body?: unknown,
    org = organizationUuid("a"),
  ) {
    const p = "/api/organizations/" + org + "/" + suffix;
    const url = new URL("http://localhost" + p);
    const req: any = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    );
    req.method = method;
    req.url = p;
    let status = 200,
      data: any;
    const res: any = {
      writeHead(s: number) {
        status = s;
      },
      end(value?: string) {
        data = value ? JSON.parse(value) : undefined;
      },
    };
    const handled = suffix.startsWith("memory")
      ? await memoryRoute(req, res, url.pathname, url, ctx)
      : await usageRoute(req, res, url.pathname, ctx);
    return { status, data, handled };
  }
  return {
    ctx,
    values,
    calls,
    run,
    change: (kind = "session") => {
      if (kind === "owner") owner = "b";
      else if (kind === "logout") owner = "";
      else session++;
    },
    hook: (f: () => void) => {
      hook = f;
    },
  };
}
test("billing dollars convert to cents, real zero distinct from absent service", async () => {
  const f = fixture();
  assert.equal((await f.run("prepaid/credits")).data.amount, 1234);
  f.values.billingInfo.balance = 0;
  assert.equal((await f.run("prepaid/credits")).data.amount, 0);
  f.values.billingInfo = null;
  assert.equal((await f.run("prepaid/credits")).status, 501);
  f.values.spendLimit = null;
  assert.equal((await f.run("overage_spend_limit")).status, 501);
  assert.equal(usageOf(null, null).extra_usage, null);
  assert.deepEqual(usageOf(null, null).limits, []);
  assert.equal(
    spendLimitOf({
      limitUsd: null,
      usedUsd: 2.5,
      resetsAt: "2026-12-01T00:00:00Z",
    })?.monthly_credit_limit,
    null,
  );
});
test("billing failures and malformed amounts never become fake zero or unlimited", async () => {
  for (const path of ["usage", "prepaid/credits", "overage_spend_limit"]) {
    const f = fixture();
    const name = path === "prepaid/credits" ? "billingInfo" : "spendLimit";
    f.values[name] = Error("/private/source failure");
    const r = await f.run(path);
    assert.equal(r.status, 503);
    assert.doesNotMatch(JSON.stringify(r.data), /private/);
  }
  for (const balance of [NaN, Infinity, -1, "12", Number.MAX_VALUE]) {
    const f = fixture();
    f.values.billingInfo = { balance };
    assert.equal((await f.run("prepaid/credits")).status, 503);
  }
  const f = fixture();
  f.values.spendLimit.usedUsd = NaN;
  assert.equal((await f.run("usage")).status, 503);
});
test("billing wrong organization, signout and wrong method make no source calls", async () => {
  const f = fixture();
  assert.equal((await f.run("usage", "GET", undefined, "other")).status, 404);
  assert.equal((await f.run("usage", "POST")).status, 405);
  assert.equal(f.calls.length, 0);
  f.change("logout");
  assert.equal((await f.run("usage")).status, 401);
  assert.equal(f.calls.length, 0);
});
test("billing activation changes suppress delayed source results", async () => {
  for (const path of ["usage", "prepaid/credits", "overage_spend_limit"]) {
    const f = fixture();
    f.hook(() => f.change());
    assert.equal((await f.run(path)).status, 409);
  }
});
test("Web spend changes require a scoped write capability", async () => {
  const f = fixture();
  assert.equal(
    (await f.run("overage_spend_limit", "PUT", { monthly_credit_limit: 500 }))
      .status,
    501,
  );
  assert.equal(f.calls.length, 0);
});
test("native spend changes validate method, integer cents and supported semantics", async () => {
  const f = fixture(false);
  for (const body of [
    {},
    null,
    [],
    { monthly_credit_limit: "500" },
    { monthly_credit_limit: -1 },
    { monthly_credit_limit: 1.5 },
    { monthly_credit_limit: 500, unknown: true },
  ])
    assert.equal((await f.run("overage_spend_limit", "PUT", body)).status, 400);
  assert.equal(
    (
      await f.run("overage_spend_limit", "DELETE", {
        monthly_credit_limit: 500,
      })
    ).status,
    405,
  );
  assert.equal(
    (
      await f.run("overage_spend_limit", "PUT", {
        monthly_credit_limit: 500,
        is_enabled: false,
      })
    ).status,
    501,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.run("overage_spend_limit", "PUT", { monthly_credit_limit: 2500 }))
      .status,
    200,
  );
  assert.deepEqual(f.calls[0], { name: "setSpendLimit", args: [25] });
  assert.equal(
    (await f.run("overage_spend_limit", "POST", { monthly_credit_limit: null }))
      .status,
    200,
  );
  assert.equal(f.calls[1].args[0], null);
});
test("Web memory reads actual empty/global/project state without mutations", async () => {
  const f = fixture();
  let r = await f.run("memory");
  assert.equal(r.status, 200);
  assert.equal(r.data.memory, "");
  assert.equal(r.data.controls_version, "v1:0:0:0");
  f.values.memoryControlsState = {
    doc: {
      content: "Real fixture note",
      updatedAt: 0,
      edits: [{ text: "Explicit note" }],
    },
    version: "revision-2",
  };
  r = await f.run("memory?project_uuid=project-a");
  assert.equal(r.status, 200);
  assert.equal(r.data.memory, "Real fixture note");
  assert.deepEqual(f.calls.at(-1)?.args, [
    { kind: "project", projectId: "project-a" },
    { fresh: true },
  ]);
  assert.equal((await f.run("memory?project_uuid=other")).status, 404);
  assert.equal(
    (await f.run("memory?project_uuid=project-a&project_uuid=other")).status,
    400,
  );
  assert.equal((await f.run("memory/settings")).data.enabled_saffron, false);
  assert.ok(
    f.calls.every((c) =>
      ["memoryControlsState", "memoryStatus"].includes(c.name),
    ),
  );
});
test("memory reset/settings/controls/synthesis are not exposed by readonly mode", async () => {
  const f = fixture();
  for (const [path, method] of [
    ["memory/reset", "POST"],
    ["memory/settings", "POST"],
    ["memory/controls", "PUT"],
    ["memory/synthesize", "POST"],
  ])
    assert.equal((await f.run(path, method, {})).status, 501);
  assert.equal(f.calls.length, 0);
});
test("memory wrong-org/signout and stale activation do not disclose documents", async () => {
  const f = fixture();
  assert.equal((await f.run("memory", "GET", undefined, "other")).status, 404);
  assert.equal(f.calls.length, 0);
  f.hook(() => f.change("owner"));
  assert.equal((await f.run("memory")).status, 409);
  const g = fixture();
  g.change("logout");
  assert.equal((await g.run("memory")).status, 401);
});
test("memory source errors and malformed documents are not empty-success", async () => {
  const f = fixture();
  f.values.memoryControlsState = Error("/private/path");
  let r = await f.run("memory");
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r.data), /private/);
  f.values.memoryControlsState = {
    doc: { content: "x", updatedAt: NaN, edits: [] },
    version: null,
  };
  assert.equal((await f.run("memory")).status, 503);
  f.values.memoryStatus = {};
  assert.equal((await f.run("memory/settings")).status, 503);
});

test("actual runner memory GET global/project, foreign-org and activation guards; memory writes require their own authority", async (t) => {
  const { createRunnerOfficialAdapter } =
    await import("../../runner/src/official-ui-adapter");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-memory-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let session = 1,
    retire = false;
  const calls: { name: string; args: unknown[] }[] = [];
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({ id: "runner-memory", name: "Fixture" }),
      settings: () => ({}),
      sessionIdentity: () => session,
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (name, args) => {
      calls.push({ name, args });
      if (name === "snapshot")
        return { projects: [{ id: "project-a" }], conversations: [] };
      if (name === "memoryControlsState") {
        if (retire) session++;
        return {
          doc: { content: "Runner memory fixture", updatedAt: 0, edits: [] },
          version: "v1:1:1:0",
        };
      }
      throw Error("Unexpected internal call " + name);
    },
    root,
    { modes: ["chat"] },
    { allowTextActions: true },
  );
  const base =
    "/api/organizations/" + organizationUuid("runner-memory") + "/memory";
  let r = await run({ method: "GET", path: base });
  assert.equal(r.status, 200);
  assert.equal(
    JSON.parse(Buffer.from(r.body).toString()).memory,
    "Runner memory fixture",
  );
  r = await run({ method: "GET", path: base + "?project_uuid=project-a" });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.filter((call) => call.name === "memoryControlsState").at(-1)?.args, [
    { kind: "project", projectId: "project-a" },
    { fresh: true },
  ]);
  const before = calls.length;
  assert.equal(
    (
      await run({
        method: "GET",
        path: base.replace(
          organizationUuid("runner-memory"),
          organizationUuid("other"),
        ),
      })
    ).status,
    404,
  );
  assert.equal(calls.length, before);
  for (const [method, suffix] of [
    ["POST", "/reset"],
    ["POST", "/settings"],
    ["PUT", "/controls"],
    ["POST", "/synthesize"],
  ] as const)
    assert.equal(
      (
        await run({
          method,
          path: base + suffix,
          body: Buffer.from("{}"),
          contentType: "application/json",
        })
      ).status,
      501,
    );
  assert.equal(calls.length, before);
  retire = true;
  r = await run({ method: "GET", path: base });
  assert.ok(r.status >= 400);
  assert.doesNotMatch(Buffer.from(r.body).toString(), /Runner memory fixture/);
});

test("skip_spend avoids spend read; grant/channel/invalid query semantics are never ignored", async () => {
  const f = fixture();
  f.values.spendLimit = Error("Must not call");
  let r = await f.run("usage?skip_spend=1");
  assert.equal(r.status, 200);
  assert.equal(r.data.extra_usage, null);
  assert.deepEqual(
    f.calls.map((x) => x.name),
    ["planUsage"],
  );
  for (const suffix of [
    "usage?cedar_ember=1&skip_spend=1",
    "usage?at_wall=1",
    "usage?skip_spend=0",
    "usage?skip_spend=1&skip_spend=1",
    "prepaid/credits?skip_spend=1",
    "overage_spend_limit?channel_id=other",
    "overage_spend_limit?account_uuid=other",
  ])
    assert.equal((await f.run(suffix)).status, 501);
  assert.equal(f.calls.length, 1);
});

test("actual runner exposes only billing reads and never payment/spend writes even with text actions", async (t) => {
  const { createRunnerOfficialAdapter } =
    await import("../../runner/src/official-ui-adapter");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-billing-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let session = 1,
    retire = false;
  const calls: string[] = [];
  const f = fixture();
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({ id: "billing-test" }),
      settings: () => ({}),
      sessionIdentity: () => session,
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (name) => {
      calls.push(name);
      if (retire) session++;
      if (!(name in f.values)) throw Error("Unexpected call " + name);
      return f.values[name];
    },
    root,
    { modes: ["chat"] },
    { allowTextActions: true },
  );
  const base = "/api/organizations/" + organizationUuid("billing-test") + "/";
  for (const suffix of ["usage", "prepaid/credits", "overage_spend_limit"])
    assert.equal(
      (await run({ method: "GET", path: base + suffix })).status,
      200,
    );
  const before = calls.length;
  assert.equal(
    (
      await run({
        method: "PUT",
        path: base + "overage_spend_limit",
        body: Buffer.from('{"monthly_credit_limit":100}'),
        contentType: "application/json",
      })
    ).status,
    501,
  );
  assert.equal(calls.length, before);
  assert.equal(
    (
      await run({
        method: "GET",
        path:
          base.replace(
            organizationUuid("billing-test"),
            organizationUuid("other"),
          ) + "prepaid/credits",
      })
    ).status,
    404,
  );
  assert.equal(calls.length, before);
  retire = true;
  const r = await run({ method: "GET", path: base + "prepaid/credits" });
  assert.ok(r.status >= 400);
  assert.doesNotMatch(Buffer.from(r.body).toString(), /1234/);
});

test("memory policy, unsupported and offline errors remain distinct without exposing arbitrary source text", async () => {
  const f = fixture();
  for (const [message, status] of [
    ["Memory isn't available on this server yet.", 501],
    ["Memory is turned off by your administrator.", 403],
    ["You're offline. Changes will be available when you reconnect.", 503],
  ] as const) {
    f.values.memoryControlsState = Error(message);
    const r = await f.run("memory");
    assert.equal(r.status, status);
    assert.equal(r.data.error.message, message);
  }
  f.values.memoryControlsState = Error(
    "Memory changed on another device. secret-source-suffix",
  );
  const r = await f.run("memory");
  assert.equal(r.status, 409);
  assert.doesNotMatch(JSON.stringify(r.data), /secret-source/);
});
