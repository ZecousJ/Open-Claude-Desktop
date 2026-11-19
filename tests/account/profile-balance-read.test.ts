/** Explicit fake fetch responses only; no real account login/profile writes/network. */
import test from "node:test";
import assert from "node:assert/strict";
import { profileBalance } from "../../electron/sub2api/profile-balance";
import { Sub2ApiClient } from "../../electron/sub2api/client";
const user = { id: 1, email: "fixture@example.invalid", username: "Fixture" };
test("monetary parser preserves finite zero, precision and debt; absent values are unknown", () => {
  for (const value of [0, -0, -5.25, 0.000001, 12.3456])
    assert.equal(profileBalance(value), value);
  for (const value of [
    undefined,
    null,
    "0",
    false,
    {},
    NaN,
    Infinity,
    -Infinity,
  ])
    assert.equal(profileBalance(value), undefined);
});
test("actual client profile rejects absent/malformed balance rather than fabricating zero", async () => {
  for (const body of [
    user,
    { ...user, balance: null },
    { ...user, balance: "0" },
    { ...user, balance: {} },
  ]) {
    let calls = 0;
    const client = new Sub2ApiClient(
      "https://fixture.invalid",
      async (url, init) => {
        calls++;
        assert.equal(
          String(url),
          "https://fixture.invalid/api/v1/user/profile",
        );
        assert.ok(!init?.method || init.method === "GET");
        return new Response(JSON.stringify({ code: 0, data: body }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    await assert.rejects(client.profile("fixture-token"));
    assert.equal(calls, 1);
  }
});
test("actual client preserves real balance while auth me remains independent of billing", async () => {
  for (const balance of [0, -2.25, 0.000001]) {
    const client = new Sub2ApiClient(
      "https://fixture.invalid",
      async (url, init) => {
        assert.ok(!init?.method || init.method === "GET");
        const data = String(url).endsWith("/auth/me")
          ? user
          : { ...user, balance };
        return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
      },
    );
    assert.equal((await client.profile("fixture-token")).balance, balance);
    assert.equal((await client.me("fixture-token")).id, user.id);
  }
});

test("identity-only profile keeps the same GET endpoint without requiring financial data", async () => {
  const calls: string[] = [];
  const client = new Sub2ApiClient(
    "https://fixture.invalid",
    async (url, init) => {
      calls.push(String(url));
      assert.ok(!init?.method || init.method === "GET");
      return new Response(JSON.stringify({ code: 0, data: user }), {
        status: 200,
      });
    },
  );
  assert.equal(
    (await client.readProfileIdentity("fixture-token")).username,
    user.username,
  );
  assert.deepEqual(calls, ["https://fixture.invalid/api/v1/user/profile"]);
  await assert.rejects(client.profile("fixture-token"));
});
test("username mutation response consumes identity only, no invented balance or duplicate request", async () => {
  let calls = 0;
  const client = new Sub2ApiClient(
    "https://fixture.invalid",
    async (url, init) => {
      calls++;
      assert.equal(String(url), "https://fixture.invalid/api/v1/user");
      assert.equal(init?.method, "PUT");
      assert.equal(init?.body, JSON.stringify({ username: "Updated fixture" }));
      return new Response(
        JSON.stringify({
          code: 0,
          data: { ...user, username: "Updated fixture" },
        }),
        { status: 200 },
      );
    },
  );
  const answer = await client.updateUsername(
    "fixture-token",
    "Updated fixture",
  );
  assert.equal(answer.username, "Updated fixture");
  assert.equal(Object.hasOwn(answer, "balance"), false);
  assert.equal(calls, 1);
});
