/** Actual client/parser/legacy usage source with fake fetch only; no network/account operations. */
import test from "node:test";
import assert from "node:assert/strict";
import { parseProgress, Sub2ApiClient } from "../../electron/sub2api/client";
import { parseUsageWindowRead } from "../../electron/sub2api/usage-window-read";
import { SubscriptionUsage } from "../../electron/sub2api/usage-source";
const window = {
  limit_usd: 5,
  used_usd: 0,
  percentage: 0,
  resets_at: "2026-12-01T00:00:00Z",
};
const wrapped = (weekly: unknown) => [
  {
    subscription: { id: 1, group_id: 2, group: { name: "Plan" } },
    progress: { id: 1, weekly },
  },
];
test("explicit zero/precision and both documented progress shapes survive, optional windows stay unknown", () => {
  assert.deepEqual(parseProgress([]), []);
  for (const input of [[{ id: 1, weekly: window }], wrapped(window)]) {
    const result = parseProgress(input);
    assert.equal(result[0].weekly?.usedUsd, 0);
    assert.equal(result[0].weekly?.percentage, 0);
    assert.equal(result[0].daily, undefined);
  }
  assert.equal(parseUsageWindowRead(null), undefined);
  assert.equal(parseUsageWindowRead(undefined), undefined);
  assert.equal(
    parseUsageWindowRead({ ...window, used_usd: 0.000001 })?.usedUsd,
    0.000001,
  );
  assert.equal(parseUsageWindowRead({ ...window, limit_usd: 0 })?.limitUsd, 0);
  assert.equal(
    parseUsageWindowRead({ ...window, percentage: 120 })?.percentage,
    100,
  );
});
test("invalid windows and collection rows never become empty progress or disabled quotas", () => {
  for (const bad of [
    {},
    [],
    "0",
    { ...window, used_usd: undefined },
    { ...window, limit_usd: undefined },
    { ...window, percentage: undefined },
    { ...window, used_usd: "0" },
    { ...window, used_usd: NaN },
    { ...window, limit_usd: Infinity },
    { ...window, percentage: -1 },
    { ...window, limit_usd: -1 },
    { ...window, resets_at: null },
    { ...window, resets_at: "2026-02-30T00:00:00Z" },
  ])
    assert.throws(() => parseProgress(wrapped(bad)), /unexpected response/);
  for (const bad of [
    null,
    {},
    "[]",
    [null],
    [[]],
    [{}],
    [{ id: 0 }],
    [{ id: -1 }],
    [{ id: Number.MAX_SAFE_INTEGER + 1 }],
    [{ id: "1" }],
    [{ id: 1 }, { id: 1 }],
    [{ progress: null, subscription: { id: 1 } }],
    [{ progress: { id: 1 } }],
    [{ subscription: { id: 2 }, progress: { id: 1 } }],
  ])
    assert.throws(() => parseProgress(bad), /unexpected response/);
});
test("actual GET client and legacy PlanUsage propagate malformed progress, not empty financial facts", async () => {
  let calls = 0;
  const client = new Sub2ApiClient(
    "https://fixture.invalid",
    async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        "https://fixture.invalid/api/v1/subscriptions/progress",
      );
      assert.ok(!init?.method || init.method === "GET");
      return new Response(
        JSON.stringify({
          code: 0,
          data: wrapped({ ...window, used_usd: undefined }),
        }),
        { status: 200 },
      );
    },
  );
  await assert.rejects(
    client.subscriptionProgress("fixture-token"),
    /unexpected response/,
  );
  const context: any = {
    client,
    session: {
      authorized: (read: (token: string) => unknown) => read("fixture-token"),
    },
    plan: () => ({ groupId: 2, name: "Plan", expiresAt: null }),
    publicSettings: async () => {
      throw Error("Must not read after invalid progress");
    },
  };
  const usage = new SubscriptionUsage(context);
  await assert.rejects(usage.planUsage(80, true), /unexpected response/);
  assert.equal(calls, 2);
});
