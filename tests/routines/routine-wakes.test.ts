import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoutineWakes, wakeRetryMs } from "../../runner/src/routine-wakes";
import { nextWakeAt } from "../../shared/routines";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the next wake is the earliest enabled task that starts by itself", () => {
  const task = (
    nextRunAt: number,
    enabled = true,
    repeat?: { kind: "manual" },
  ) => ({ enabled, nextRunAt, repeat }) as any;
  assert.equal(nextWakeAt([]), undefined);
  assert.equal(nextWakeAt([task(50), task(20), task(30)]), 20);
  // A paused task and a manual one never start by themselves.
  assert.equal(
    nextWakeAt([task(10, false), task(5, true, { kind: "manual" })]),
    undefined,
  );
  assert.equal(nextWakeAt([task(10, false), task(40)]), 40);
  assert.equal(
    nextWakeAt([
      { ...task(5), connectionHold: { service: "notion" } },
      task(40),
    ]),
    40,
  );
});

function state(users: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wakes-"));
  for (const [id, schedules] of Object.entries(users)) {
    const profile = path.join(dir, "users", id, "profile");
    fs.mkdirSync(profile, { recursive: true });
    if (schedules !== undefined)
      fs.writeFileSync(
        path.join(profile, "schedules.json"),
        JSON.stringify(schedules),
      );
  }
  return dir;
}

test("at start each user's saved schedule arms one wake; other folders are ignored", async () => {
  const now = 1_000_000;
  const dir = state({
    "12": [{ enabled: true, nextRunAt: now - 10 }],
    "13": [{ enabled: false, nextRunAt: now - 10 }],
    "14": undefined,
    notauser: [{ enabled: true, nextRunAt: now }],
  });
  const woken: number[] = [];
  const wakes = new RoutineWakes({
    stateDir: dir,
    now: () => now,
    wake: async (id) => void woken.push(id),
  });
  wakes.scan();
  await sleep(30);
  assert.deepEqual(woken, [12]);
  assert.equal(wakes.dueAt(13), undefined);
  wakes.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a context's report replaces the user's time; nothing due cancels the wake", async () => {
  let now = 0;
  const woken: number[] = [];
  const wakes = new RoutineWakes({
    stateDir: "/nonexistent",
    now: () => now,
    wake: async (id) => void woken.push(id),
  });
  wakes.set(5, 20);
  wakes.set(5, 60_000);
  await sleep(50);
  assert.deepEqual(woken, []);
  wakes.set(5, undefined);
  assert.equal(wakes.dueAt(5), undefined);
  now = 100_000;
  await sleep(20);
  assert.deepEqual(woken, []);
  wakes.stop();
});

test("a wake that fails is tried again; a wake that leaves the task due looks again", async () => {
  assert.equal(wakeRetryMs, 120_000);
  let calls = 0;
  const logged: string[] = [];
  const wakes = new RoutineWakes({
    stateDir: "/nonexistent",
    now: () => 1_000,
    wake: async () => {
      calls++;
      throw new Error("service down");
    },
    log: (message) => logged.push(message),
  });
  wakes.set(9, 900);
  await sleep(30);
  assert.equal(calls, 1);
  assert.match(logged[0], /waking user 9.*service down/);
  // Re-armed for two minutes: no second call yet, and stopping clears it.
  await sleep(30);
  assert.equal(calls, 1);
  wakes.stop();
});
