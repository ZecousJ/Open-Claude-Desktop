import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runShutdown, settleWithin } from "../../electron/app/shutdown";
import { readSource } from "../support/read-source";

test("a step that never finishes is given up on and the next steps still run", async () => {
  const ran: string[] = [];
  const { timedOut } = await runShutdown(
    [
      { name: "engine", run: () => new Promise(() => {}) },
      { name: "store", run: () => void ran.push("store") },
    ],
    { stepMs: 20, totalMs: 1_000 },
  );
  assert.deepEqual(timedOut, ["engine"]);
  assert.deepEqual(ran, ["store"]);
});

test("failing steps don't stop the shutdown", async () => {
  const ran: string[] = [];
  const { timedOut } = await runShutdown(
    [
      {
        name: "throws",
        run: () => {
          throw new Error("boom");
        },
      },
      { name: "rejects", run: () => Promise.reject(new Error("no")) },
      { name: "ok", run: () => void ran.push("ok") },
    ],
    { stepMs: 50, totalMs: 1_000 },
  );
  assert.deepEqual(timedOut, []);
  assert.deepEqual(ran, ["ok"]);
});

test("the whole shutdown has its own limit", async () => {
  const started = Date.now();
  const { timedOut } = await runShutdown(
    [
      { name: "a", run: () => new Promise(() => {}) },
      { name: "b", run: () => new Promise(() => {}) },
    ],
    { stepMs: 200, totalMs: 60 },
  );
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(timedOut, ["shutdown"]);
});

test("settleWithin reports a timeout only when time ran out", async () => {
  assert.equal(await settleWithin(Promise.resolve(1), 50), false);
  assert.equal(await settleWithin(new Promise(() => {}), 10), true);
  assert.equal(await settleWithin(undefined, 10), false);
});

test("quitting uses the bounded shutdown and the install can't hold the exit", () => {
  const root = path.join(import.meta.dirname, "..", "..");
  const main = readSource(path.join(root, "electron/main.ts"));
  const launch = fs.readFileSync(
    path.join(root, "electron/updates/launch.ts"),
    "utf8",
  );
  assert.match(main, /await runShutdown\(\[/);
  assert.match(launch, /setTimeout\(\(\) => app\.exit\(0\), installHoldMs\)/);
});
