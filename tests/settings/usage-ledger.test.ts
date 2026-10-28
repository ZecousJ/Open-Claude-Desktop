import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageLedger } from "../../electron/conversations/usage-ledger";

test("account usage records aggregate tokens and failures without storing request content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-usage-"));
  try {
    const ledger = new UsageLedger(root);
    const base = {
      id: "one",
      at: Date.UTC(2026, 8, 23),
      providerId: "fixture",
      model: "test-model",
      protocol: "responses" as const,
      durationMs: 35,
      statusCode: 200,
      usageKnown: true,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 25,
      reasoningTokens: 5,
    };
    ledger.record(base);
    ledger.record({
      ...base,
      id: "two",
      statusCode: 429,
      usageKnown: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
    ledger.record({
      ...base,
      id: "three",
      model: "other-model",
      inputTokens: 3,
      outputTokens: 4,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
    const report = new UsageLedger(root).summary("all", base.at + 1000);
    assert.deepEqual(report.total, {
      requests: 3,
      successful: 2,
      failed: 1,
      unmetered: 1,
      inputTokens: 103,
      outputTokens: 54,
      cachedTokens: 25,
      reasoningTokens: 5,
    });
    assert.equal(report.models.length, 2);
    assert.equal(report.daily.length, 1);
    assert.equal(report.daily[0].requests, 3);
    assert.equal(
      report.hours.reduce((sum, hour) => sum + hour.requests, 0),
      3,
    );
    const file = fs.readFileSync(
      path.join(root, "usage", "2026-09.jsonl"),
      "utf8",
    );
    assert.equal(file.trim().split("\n").length, 3);
    assert.doesNotMatch(file, /prompt|apiKey|password/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("usage ranges filter request time while preserving per-model and daily totals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-usage-range-"));
  try {
    const ledger = new UsageLedger(root),
      now = Date.UTC(2026, 8, 23, 12);
    const base = {
      id: "recent",
      at: now - 86400000,
      providerId: "fixture",
      model: "model-a",
      protocol: "chat" as const,
      durationMs: 20,
      statusCode: 200,
      usageKnown: true,
      inputTokens: 12,
      outputTokens: 3,
      cachedTokens: 0,
      reasoningTokens: 0,
    };
    ledger.record(base);
    ledger.record({
      ...base,
      id: "old",
      at: now - 10 * 86400000,
      model: "model-b",
      inputTokens: 50,
    });
    const week = ledger.summary("7d", now),
      month = ledger.summary("30d", now);
    assert.deepEqual(
      [
        week.total.requests,
        week.total.inputTokens,
        week.models.length,
        week.daily.length,
      ],
      [1, 12, 1, 1],
    );
    assert.deepEqual(
      [
        month.total.requests,
        month.total.inputTokens,
        month.models.length,
        month.daily.length,
      ],
      [2, 62, 2, 2],
    );
    assert.equal(
      week.hours.reduce((sum, hour) => sum + hour.requests, 0),
      1,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt usage history is preserved and refuses to report invented totals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-usage-"));
  try {
    const ledger = new UsageLedger(root);
    const filename = path.join(root, "usage", "2026-09.jsonl");
    fs.writeFileSync(filename, "{broken\n");
    assert.throws(() => ledger.summary(), /cannot be read/);
    assert.equal(fs.readFileSync(filename, "utf8"), "{broken\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
