import test from "node:test";
import assert from "node:assert/strict";
import { officialContextUsage } from "../shared/official-code-context";
import type { Conversation } from "../shared/types";
test("context uses latest measured request, not accumulated usage, and never invents a breakdown", () => {
  const c: any = {
    model: "test",
    usage: { totalTokens: 900000 },
    tokenUsage: {
      last: { totalTokens: 12345 },
      total: { totalTokens: 900000 },
      modelContextWindow: 200000,
    },
  };
  const r = officialContextUsage(c)!;
  assert.equal(r.totalTokens, 12345);
  assert.equal(r.rawMaxTokens, 200000);
  assert.equal(r.percentage, 6);
  assert.equal(r.detail, "summary");
  assert.deepEqual(r.memoryFiles, []);
  assert.equal(r.categories[1].tokens, 187655);
  assert.equal(officialContextUsage({ model: "test" } as any), null);
  assert.equal(
    officialContextUsage({
      ...c,
      tokenUsage: { ...c.tokenUsage, modelContextWindow: null },
    }),
    null,
  );
});

test("context summary tolerates incomplete or invalid runtime reports", () => {
  const valid = { last: { totalTokens: 10 }, modelContextWindow: 100 };
  for (const tokenUsage of [
    null,
    {},
    { ...valid, last: undefined },
    { ...valid, last: null },
    { ...valid, last: {} },
    ...[undefined, null, "10", -1, NaN, Infinity, -Infinity].map(
      (totalTokens) => ({ ...valid, last: { totalTokens } }),
    ),
    ...[undefined, null, "100", 0, -1, NaN, Infinity, -Infinity].map(
      (modelContextWindow) => ({ ...valid, modelContextWindow }),
    ),
  ]) {
    assert.equal(
      officialContextUsage({ model: "test", tokenUsage } as any),
      null,
    );
  }
});

test("context summary preserves measured zero and over-window usage", () => {
  const usage = (totalTokens: number) =>
    officialContextUsage({
      model: "test",
      tokenUsage: { last: { totalTokens }, modelContextWindow: 100 },
    } as any)!;
  assert.equal(usage(0).totalTokens, 0);
  assert.equal(usage(0).percentage, 0);
  assert.equal(usage(0).categories[1].tokens, 100);
  assert.equal(usage(150).totalTokens, 150);
  assert.equal(usage(150).percentage, 150);
  assert.equal(usage(150).categories[1].tokens, 0);
});

test("context shows measurements for their model only", () => {
  const tokenUsage = {
    last: { totalTokens: 10 }, modelContextWindow: 100, model: "old",
  } as Conversation["tokenUsage"];
  assert.equal(officialContextUsage({ model: "new", tokenUsage }), null);
  assert.equal(officialContextUsage({ model: "old", tokenUsage })?.totalTokens, 10);
});
