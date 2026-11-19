import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { useElectronShim } from "./runner-core-support.test";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { officialSpendLimitActivationHeader } from "../../shared/official-ui-web";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import { encodeWireValue } from "../../shared/web-wire";

useElectronShim();
const { officialUiRead } = await import("../../runner/src/official-ui-read");

test("official Web requests reject malformed fields before touching an account", async () => {
  const dispatcher = {
    options: { officialUiRoot: "/test" },
    contextFor() {
      throw Error("Must not access a context");
    },
  };
  for (const request of [
    { method: ["GET"], path: "/api/account" },
    { method: "GET", path: "/api/account", body: "unexpected" },
    { method: "GET", path: "/api/account", contentType: 42 },
    { method: "GET", path: "/api/account", contentType: "x".repeat(257) },
    { method: "GET", path: "/api/account", extra: true },
    { method: "GET", path: "/api/account", bootstrapCatalogRevision: "a".repeat(64) },
    { method: "POST", path: "/edge-api/bootstrap", bootstrapCatalogRevision: "a".repeat(64) },
    { method: "GET", path: "/edge-api/bootstrap", bootstrapCatalogRevision: "invalid" },
    { method: "GET", path: "/api/account", responseTransfer: false },
  ]) {
    const frame = { args: encodeWireValue([request]) };
    await assert.rejects(
      officialUiRead(dispatcher as never, frame as never),
      /Invalid official Web request/,
    );
  }
});

test("Cloud Code organization stays attached through the authenticated runner frame", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-code-frame-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = {};
  const user = { id: 9, accessToken: "fixture-token" };
  const account = {
    id: "fixture-owner",
    name: "Owner",
    email: "owner@example.invalid",
  };
  const ctx = {
    userId: user.id,
    activeAccount: account,
    closedFlag: false,
    signedOut: false,
    setAccessToken() {},
    officialSessionIdentity: () => identity,
    store: { root, settings: {} },
    onEvent: () => () => {},
    appVersion: "fixture",
    log() {},
  };
  let calls = 0;
  const dispatcher = {
    options: { officialUiRoot: "/fixture-assets" },
    guard: { modes: ["chat", "code"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
    async run(
      frame: { method: string },
      expected: { context: unknown; identity: unknown },
    ) {
      assert.equal(frame.method, "snapshot");
      assert.equal(expected.context, ctx);
      assert.equal(expected.identity, identity);
      calls++;
      return { conversations: [] };
    },
  };
  const read = async (codeOrganizationId: string) =>
    (await officialUiRead(
      dispatcher as never,
      {
        method: "officialUiRead",
        user,
        args: encodeWireValue([
          { method: "GET", path: "/v1/code/sessions", codeOrganizationId },
        ]),
      } as never,
    )) as OfficialUiReadResponse;
  await assert.rejects(read("x".repeat(37)), /Invalid official Web request/);
  assert.equal((await read(organizationUuid("other"))).status, 404);
  assert.equal(calls, 0);
  const response = await read(organizationUuid(account.id));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(response.body).toString()), {
    data: [],
    next_cursor: null,
  });
  assert.equal(calls, 1);
});

test("Web monthly spend writes stay with the session that read Usage", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-spend-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = {
    id: "billing-owner",
    name: "Owner",
    email: "owner@example.invalid",
  };
  const organization = organizationUuid(owner.id);
  const summary = `/api/organizations/${organization}/claudex_usage_summary?fresh=1`;
  const spend = `/api/organizations/${organization}/overage_spend_limit`;
  const resetsAt = "2026-12-01T00:00:00.000Z";
  let activation = {};
  let limitUsd: number | null = 25;
  let usedUsd = 0.00123;
  let nextReply: "ok" | "error" | "malformed" | "retire" = "ok";
  const writes: Array<{ token: string | null; limit: number | null }> = [];
  const ctx = {
    userId: 9,
    activeAccount: owner,
    accountRetiring: false,
    remote: {
      backend: { accounts: { baseUrl: "https://billing.example.invalid" } },
    },
    closedFlag: false,
    signedOut: false,
    setAccessToken() {},
    officialSessionIdentity: () => activation,
    store: { root, settings: {} },
    onEvent: () => () => {},
    appVersion: "fixture",
    log() {},
    runtime: {
      fetch: async (url: string, init: RequestInit) => {
        assert.equal(
          url,
          "https://billing.example.invalid/api/v1/claudex/spend-limit",
        );
        assert.equal(init.method, "PUT");
        const body = JSON.parse(String(init.body));
        assert.deepEqual(Object.keys(body), ["limit_usd"]);
        writes.push({
          token: new Headers(init.headers).get("Authorization"),
          limit: body.limit_usd,
        });
        if (nextReply === "error")
          return Response.json(
            { code: 503, message: "Private details" },
            { status: 503 },
          );
        if (nextReply === "malformed")
          return Response.json({
            code: 0,
            data: { limit_usd: null, currency: "USD" },
          });
        if (nextReply === "retire") activation = {};
        limitUsd = body.limit_usd;
        usedUsd += 0.00001;
        return Response.json({
          code: 0,
          data: {
            limit_usd: limitUsd,
            used_usd: usedUsd,
            resets_at: resetsAt,
            currency: "USD",
          },
        });
      },
    },
  };
  const dispatcher = {
    options: { officialUiRoot: "/fixture-assets", officialUiActions: true },
    guard: { modes: ["code"] as const },
    methods: ["setSpendLimit"],
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
    async run(frame: { method: string }) {
      switch (frame.method) {
        case "billingInfo":
          return { plan: null, planExpiresAt: null, balance: -0.000009 };
        case "planUsage":
          return null;
        case "spendLimit":
          return { limitUsd, usedUsd, resetsAt };
        default:
          throw Error(`Unexpected account call: ${frame.method}`);
      }
    },
  };
  const run = async (
    request: Record<string, unknown>,
    session = "session-a",
    action = request.method !== "GET",
  ) => {
    const result = (await officialUiRead(
      dispatcher as never,
      {
        method: action ? "officialUiAction" : "officialUiRead",
        user: {
          id: 9,
          accessToken: `token-${session}`,
          webSession: { id: session, issuedAt: 1 },
        },
        args: encodeWireValue([request]),
      } as never,
    )) as OfficialUiReadResponse;
    return {
      status: result.status,
      data: JSON.parse(Buffer.from(result.body).toString()),
    };
  };
  const read = (session?: string) =>
    run({ method: "GET", path: summary }, session);
  const put = (amount: number | null, capabilityLease?: string) => ({
    method: "PUT",
    path: spend,
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({
        monthly_credit_limit: amount,
        period: "monthly",
        currency: "USD",
      }),
    ),
    capabilityLease,
  });

  dispatcher.options.officialUiActions = false;
  assert.equal((await read()).data.spend_limit_write, undefined);
  await assert.rejects(run(put(0)), /Not available on the web/);
  dispatcher.options.officialUiActions = true;

  const opened = await read();
  assert.equal(opened.status, 200);
  assert.equal(opened.data.spend_limit_write, true);
  assert.equal(opened.data.spend_limit.data.usedUsd, 0.00123);
  assert.equal(opened.data.billing.data.balanceUsd, -0.000009);
  const lease = opened.data.spend_limit_activation_lease;
  assert.equal(typeof lease, "string");
  assert.notEqual(
    (await read("session-b")).data.spend_limit_activation_lease,
    lease,
  );
  assert.equal((await run(put(0, lease), "session-b")).status, 409);
  assert.equal((await run(put(0))).status, 409);
  assert.equal(
    (
      await run({
        ...put(0, lease),
        path: spend.replace(organization, organizationUuid("different")),
      })
    ).status,
    404,
  );
  assert.equal((await run(put(10_000_001, lease))).status, 400);
  assert.equal(
    (await run({ ...put(0, lease), contentType: "text/plain" })).status,
    400,
  );
  assert.equal(
    (
      await run({
        ...put(0, lease),
        body: Buffer.from('{"monthly_credit_limit":0,"channel_id":"x"}'),
      })
    ).status,
    400,
  );
  await assert.rejects(
    run({ ...put(0, lease), path: spend + "?channel_id=other" }),
    /Invalid official Web request/,
  );
  await assert.rejects(
    run({ ...put(0, lease), method: "POST" }),
    /Invalid official Web request/,
  );
  await assert.rejects(
    run({ ...put(0, lease), method: "POST", path: "/api/__claudex/checkout" }),
    /Invalid official Web request/,
  );
  await assert.rejects(
    run(put(0, lease), "session-a", false),
    /Invalid official Web request/,
  );
  assert.deepEqual(writes, []);

  const frameFetch = createOfficialReadFetch(
    "https://fixture.invalid",
    async () => {
      throw Error("Spend write sent as a read");
    },
    async () => {
      throw Error("Spend write escaped the official bridge");
    },
    undefined,
    async (request) => {
      const result = await run({ ...request });
      return {
        status: result.status,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(result.data)),
      };
    },
  );
  const result = await frameFetch(`https://fixture.invalid${spend}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      [officialSpendLimitActivationHeader]: lease,
    },
    body: JSON.stringify({ monthly_credit_limit: 0 }),
  });
  const zero = { status: result.status, data: await result.json() };
  assert.equal(zero.status, 200);
  assert.equal(zero.data.organization_uuid, organization);
  assert.equal(zero.data.monthly_credit_limit, 0);
  assert.equal(zero.data.spend_limit_reached, true);
  assert.equal(zero.data.used_usd, usedUsd);
  assert.equal((await read()).data.spend_limit.data.limitUsd, 0);
  const unlimited = await run(put(null, lease));
  assert.equal(unlimited.status, 200);
  assert.equal(unlimited.data.monthly_credit_limit, null);
  assert.equal(unlimited.data.spend_limit_reached, false);

  nextReply = "error";
  const failure = await run(put(2500, lease));
  assert.equal(failure.status, 503);
  assert.doesNotMatch(JSON.stringify(failure.data), /Private details/);
  assert.equal((await read()).data.spend_limit.data.limitUsd, null);
  nextReply = "malformed";
  assert.equal((await run(put(2500, lease))).status, 503);

  nextReply = "retire";
  assert.equal((await run(put(750, lease))).status, 409);
  const reopened = await read();
  assert.notEqual(reopened.data.spend_limit_activation_lease, lease);
  assert.equal(reopened.data.spend_limit.data.limitUsd, 7.5);
  assert.equal((await run(put(null, lease))).status, 409);
  assert.deepEqual(
    writes,
    [0, null, 25, 25, 7.5].map((limit) => ({
      token: "Bearer token-session-a",
      limit,
    })),
  );

  nextReply = "ok";
  const { run: runDispatcherSession } =
    await import("../../runner/src/dispatcher-sessions");
  const classic = (amount: unknown) =>
    runDispatcherSession.call(
      dispatcher as never,
      {
        method: "setSpendLimit",
        user: { id: 9, accessToken: "classic-frame-token" },
        args: encodeWireValue([amount]),
      } as never,
    );
  await assert.rejects(classic("50"));
  assert.deepEqual(await classic(50), { limitUsd: 50, usedUsd, resetsAt });
  assert.deepEqual(writes.at(-1), {
    token: "Bearer classic-frame-token",
    limit: 50,
  });
});
