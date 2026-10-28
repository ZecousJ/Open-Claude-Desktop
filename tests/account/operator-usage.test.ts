import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Accounts } from "../../electron/account/accounts";
import { UsageLedger } from "../../electron/conversations/usage-ledger";
import { operatorUsageReport } from "../../server/operator-usage";

test("operator usage report aggregates isolated accounts without credential or prompt data", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-operator-usage-"),
  );
  try {
    const now = Date.UTC(2026, 8, 23, 12),
      accounts = new Accounts(root, () => now);
    const first = (
      await accounts.register(
        "first@example.invalid",
        "Synthetic-Passphrase-First!",
        "First",
      )
    ).account;
    const second = (
      await accounts.register(
        "second@example.invalid",
        "Synthetic-Passphrase-Second!",
        "Second",
      )
    ).account;
    const record = {
      id: "one",
      at: now - 86400000,
      providerId: "managed",
      model: "fixture-model",
      protocol: "responses" as const,
      durationMs: 10,
      statusCode: 200,
      usageKnown: true,
      inputTokens: 20,
      outputTokens: 5,
      cachedTokens: 0,
      reasoningTokens: 0,
    };
    new UsageLedger(accounts.profileRoot(first.id)).record(record);
    new UsageLedger(accounts.profileRoot(second.id)).record({
      ...record,
      id: "two",
      at: now - 10 * 86400000,
      inputTokens: 7,
    });
    const week = operatorUsageReport(root, "7d", now),
      month = operatorUsageReport(root, "30d", now);
    assert.equal(week.accounts.length, 2);
    assert.deepEqual(
      week.accounts.map((row) => row.usage.total.requests),
      [1, 0],
    );
    assert.equal(week.total.inputTokens, 20);
    assert.equal(month.total.inputTokens, 27);
    const serialized = JSON.stringify(week);
    assert.equal(serialized.includes("passwordHash"), false);
    assert.equal(serialized.includes("Synthetic-Passphrase"), false);
    assert.equal(serialized.includes("prompt"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
