/** Read parser + mocked async boundaries only; no remote service or payment calls. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSpendLimitRead,
  readSpendLimitSource,
} from "../../electron/account/spend-limit-read";
import { Sub2ApiError } from "../../electron/sub2api/http";
const body = {
  limit_usd: null,
  used_usd: 0,
  resets_at: "2026-12-01T00:00:00.000Z",
};
test("explicit unlimited, zero and sub-cent financial values remain exact", async () => {
  assert.deepEqual(parseSpendLimitRead(body), {
    limitUsd: null,
    usedUsd: 0,
    resetsAt: body.resets_at,
  });
  const value = { ...body, limit_usd: 0.012345, used_usd: 0.000001 };
  assert.deepEqual(
    await readSpendLimitSource(
      async () => value,
      () => true,
    ),
    {
      limitUsd: value.limit_usd,
      usedUsd: value.used_usd,
      resetsAt: value.resets_at,
    },
  );
});
test("missing/nonfinite/negative/wrong types never become zero or unlimited", () => {
  for (const value of [
    null,
    [],
    {},
    { ...body, limit_usd: undefined },
    { ...body, used_usd: undefined },
    { ...body, used_usd: "0" },
    { ...body, limit_usd: "10" },
    { ...body, used_usd: NaN },
    { ...body, limit_usd: Infinity },
    { ...body, used_usd: -1 },
    { ...body, limit_usd: -1 },
    { ...body, resets_at: "" },
    { ...body, resets_at: "2026-12-01" },
    { ...body, resets_at: "2026-99-99T00:00:00Z" },
    { ...body, resets_at: "2026-02-30T00:00:00Z" },
  ])
    assert.throws(() => parseSpendLimitRead(value), /Invalid/);
});
test("only real protocol 404/501 is unavailable; failures are redacted", async () => {
  for (const status of [404, 501])
    assert.equal(
      await readSpendLimitSource(
        async () => {
          throw new Sub2ApiError(status, "", "private detail");
        },
        () => true,
      ),
      null,
    );
  for (const error of [
    Error("private detail"),
    new Sub2ApiError(401, "", "private detail"),
    new Sub2ApiError(403, "", "private detail"),
    new Sub2ApiError(500, "", "private detail"),
    { status: 404 },
  ])
    await assert.rejects(
      readSpendLimitSource(
        async () => {
          throw error;
        },
        () => true,
      ),
      (e) =>
        e instanceof Error &&
        /could not be read/.test(e.message) &&
        !e.message.includes("private detail"),
    );
  await assert.rejects(
    readSpendLimitSource(
      async () => ({}),
      () => true,
    ),
    /could not be read/,
  );
});
test("retired source never reads, late result/error cannot cross activation", async () => {
  let reads = 0;
  await assert.rejects(
    readSpendLimitSource(
      async () => {
        reads++;
        return body;
      },
      () => false,
    ),
    /account changed/,
  );
  assert.equal(reads, 0);
  for (const failure of [false, true]) {
    let current = true;
    await assert.rejects(
      readSpendLimitSource(
        async () => {
          current = false;
          if (failure) throw new Sub2ApiError(404, "", "hidden");
          return body;
        },
        () => current,
      ),
      /account changed/,
    );
  }
});
test("authorization callback checks activation before transport after token wait", async () => {
  let current = true,
    transportCalls = 0;
  await assert.rejects(
    readSpendLimitSource(
      async (check) => {
        await Promise.resolve();
        current = false;
        check();
        transportCalls++;
        return body;
      },
      () => current,
    ),
    /account changed/,
  );
  assert.equal(transportCalls, 0);
});
