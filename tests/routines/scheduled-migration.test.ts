import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import { CloudRoutines } from "../../electron/cloud/cloud-routines";
import {
  RoutineMigrationRegistry,
  type RoutineMigrationOwner,
} from "../../electron/cloud/routine-migration-registry";
import { routineMigrationReasons } from "../../shared/routine-migration";
import type { Routine, RoutineInput } from "../../shared/routines";

const NOW = new Date(2026, 9, 19, 12).getTime();
const input = (patch: Partial<RoutineInput> = {}): RoutineInput => ({
  name: "scheduled-move",
  prompt: "Original local instructions",
  mode: "cowork",
  providerId: "p",
  model: "m",
  enabled: true,
  frequency: "hourly",
  repeat: { kind: "hourly", minute: 0 },
  nextRunAt: NOW + 3_600_000,
  permission: "auto",
  description: "Local settings",
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Contract adapter uses real temp-directory Schedulers for task/history
 * persistence. Root's Scheduler lifecycle tests exercise the atomic endpoints. */
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b31-migration-"));
  const localRoot = path.join(root, "local"),
    remoteRoot = path.join(root, "remote");
  const options = {
    now: () => NOW,
    isBusy: () => false,
    run: async () => {
      throw new Error("No test dispatch");
    },
  };
  const local = new Scheduler(localRoot, options),
    remote = new Scheduler(remoteRoot, options);
  t.after(() => {
    local.stop();
    remote.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const journal = () => new RoutineMigrationRegistry(localRoot);
  let owner: RoutineMigrationOwner = {
    accountId: "account-A",
    serviceId: "https://service.test",
    deviceId: "device-A",
  };
  const origins = new Map<string, { task: Routine; restored?: boolean }>();
  const imported = new Map<string, { id: string; deleted?: boolean }>();
  const calls: string[] = [];
  let targetTimeZone = "Asia/Shanghai";
  let enabled = true,
    targetModel = "m",
    beforeImport: (() => Promise<void>) | undefined;
  let lostImport = false,
    lostDelete = false,
    failRestore = false,
    definiteRefusal = false;
  const read = (scheduler: Scheduler, id: string) => {
    const task = scheduler.list().find((task) => task.id === id);
    return task ? { status: "ready", task } : { status: "missing" };
  };
  const capabilities = (side: string) => ({
    remote: false,
    email: false,
    slack: false,
    sources: ["chat"],
    migration: enabled
      ? {
          timeZone: side === "local" ? "Asia/Shanghai" : targetTimeZone,
          originLock: side === "local",
          import: side === "remote",
          deleteHistory: side === "remote",
          models: [{ providerId: "p", model: targetModel }],
          defaultModel: { providerId: "p", model: targetModel },
        }
      : undefined,
  });
  const remoteCall = async (method: string, args: any[] = []) => {
    calls.push(`remote:${method}`);
    if (method === "routineCapabilities") return capabilities("remote");
    if (method === "listSchedules") return remote.list();
    if (method === "readSchedule") return read(remote, args[0]);
    if (method === "saveSchedule") return remote.save(args[0]);
    if (method === "importRoutineMigration") {
      await beforeImport?.();
      if (definiteRefusal)
        throw Object.assign(new Error("Import refused before creation"), {
          code: "CLAUDEX_MIGRATION_NOT_CREATED",
        });
      const { key, task } = args[0];
      const previous = imported.get(key);
      if (previous?.deleted) throw new Error("Migration key was deleted");
      const created = previous
        ? remote.list().find((task) => task.id === previous.id)!
        : remote.save(task, { setupConversationId: key });
      imported.set(key, { id: created.id });
      if (lostImport) {
        lostImport = false;
        throw new Error("Connection lost after import");
      }
      return created;
    }
    if (method === "deleteRoutineMigration") {
      const { key, id } = args[0];
      const previous = imported.get(key);
      if (!previous || previous.id !== id)
        throw new Error("Wrong migration key");
      if (!previous.deleted) remote.delete(id);
      imported.set(key, { id, deleted: true });
      if (lostDelete) {
        lostDelete = false;
        throw new Error("Connection lost after delete");
      }
      return { deleted: true, historyDeleted: true };
    }
    throw new Error(`Unexpected remote ${method}`);
  };
  const client = { call: remoteCall };
  const handlers: Record<string, (...args: any[]) => unknown> = {
    listSchedules: () => local.list(),
    readSchedule: (id) => read(local, id),
    routineCapabilities: () => capabilities("local"),
    saveSchedule: (value) => local.save(value),
    beginRoutineMigration: ({ key, id, expectedUpdatedAt }) => {
      calls.push("local:begin");
      const existing = origins.get(key);
      if (existing) return { task: existing.task };
      const task = local.list().find((task) => task.id === id)!;
      assert.equal(task.updatedAt, expectedUpdatedAt);
      origins.set(key, { task });
      local.save({ ...task, enabled: false });
      return { task };
    },
    restoreRoutineMigration: ({ key, id, prompt }) => {
      calls.push("local:restore");
      if (failRestore) throw new Error("Local restore failed");
      const origin = origins.get(key)!;
      assert.equal(origin.task.id, id);
      if (origin.restored) return local.list().find((task) => task.id === id);
      const restored = local.save({ ...origin.task, prompt });
      origin.restored = true;
      return restored;
    },
    deleteSchedule: (id) => local.delete(id),
  };
  const controller = () => {
    const cloud = new CloudRoutines(
      () => client as never,
      () => ({ owner, journal: journal() }),
    );
    for (const [name, handler] of Object.entries(handlers))
      cloud.route(name, handler);
    return {
      cloud,
      list: cloud.route("listSchedules", handlers.listSchedules)!,
      save: cloud.route("saveSchedule", handlers.saveSchedule)!,
      eligibility: cloud.route("routineMigration", () => {})!,
      move: cloud.route("migrateRoutine", () => {})!,
    };
  };
  return {
    local,
    remote,
    localRoot,
    remoteRoot,
    calls,
    origins,
    imported,
    journal,
    controller,
    replaceOwner: (patch: Partial<RoutineMigrationOwner>) => {
      owner = { ...owner, ...patch };
    },
    zone: (value: string) => {
      targetTimeZone = value;
    },
    unsupported: () => {
      enabled = false;
    },
    model: (value: string) => {
      targetModel = value;
    },
    loseImport: () => {
      lostImport = true;
    },
    loseDelete: () => {
      lostDelete = true;
    },
    restoreFails: (value: boolean) => {
      failRestore = value;
    },
    refuseImport: () => {
      definiteRefusal = true;
    },
    delayImport: (callback: () => Promise<void>) => {
      beforeImport = callback;
    },
  };
}

test("explicit move keeps local origin/history, returns cloud canonical ID, and back drops cloud edits except instructions", async (t) => {
  const env = fixture(t);
  const source = env.local.save(input());
  const api = env.controller();
  await assert.rejects(env.local.runNow(source.id));
  const localHistory = env.local.runs(source.id);
  assert.equal(localHistory.length, 1);
  const moved = await api.move({ id: source.id, direction: "to-cloud" });
  assert.notEqual(moved.toId, source.id);
  assert.equal(moved.task.id, moved.toId);
  assert.equal(moved.history, "local-retained");
  assert.equal(env.local.list()[0].enabled, false);
  assert.equal(env.local.list()[0].id, source.id);
  assert.deepEqual(
    (await api.list()).map((task: Routine) => task.id),
    [moved.toId],
  );
  assert.deepEqual(env.local.runs(source.id), localHistory);
  await assert.rejects(env.remote.runNow(moved.toId));
  assert.equal(env.remote.runs(moved.toId).length, 1);
  const changed = env.remote.save({
    ...moved.task,
    name: "Cloud name",
    prompt: "Updated instructions",
    description: "Cloud changes",
    permission: "bypass",
    repeat: { kind: "daily", time: "16:00" },
  });
  const restored = await api.move({ id: changed.id, direction: "to-local" });
  assert.equal(restored.toId, source.id);
  assert.equal(restored.history, "cloud-deleted");
  assert.equal(restored.task.prompt, "Updated instructions");
  assert.equal(restored.task.name, source.name);
  assert.equal(restored.task.description, source.description);
  assert.deepEqual(restored.task.repeat, source.repeat);
  assert.equal(restored.task.permission, source.permission);
  assert.equal(restored.task.enabled, true);
  assert.deepEqual(env.remote.list(), []);
  assert.deepEqual(env.local.runs(source.id), localHistory);
  const cloudHistory = JSON.parse(
    fs.readFileSync(path.join(env.remoteRoot, "routine-runs.json"), "utf8"),
  );
  assert.equal(cloudHistory[moved.toId], undefined);
  assert.deepEqual(
    env
      .journal()
      .list()
      .map((record) => record.state),
    ["local"],
  );
  assert.equal(
    (await api.move({ id: changed.id, direction: "to-local" })).task.id,
    source.id,
  );
});

test("ordinary save rejects a host switch before pausing, copying, or deleting", async (t) => {
  const env = fixture(t);
  const task = env.local.save(input());
  const api = env.controller();
  await assert.rejects(
    api.save({ ...task, executionLocation: "remote" }),
    /can’t be changed/,
  );
  assert.equal(env.local.list()[0].enabled, true);
  assert.deepEqual(env.remote.list(), []);
  assert.equal(
    env.calls.some((call) => /begin|importRoutine|deleteRoutine/.test(call)),
    false,
  );
});

test("older backend, unsupported model and source conditions refuse before creating an origin lock", async (t) => {
  const env = fixture(t);
  const task = env.local.save(input());
  const api = env.controller();
  env.unsupported();
  assert.equal((await api.eligibility(task.id, "local")).toCloud.ok, false);
  await assert.rejects(
    api.move({ id: task.id, direction: "to-cloud" }),
    /unavailable/,
  );
  assert.equal(env.local.list()[0].enabled, true);
  assert.equal(env.origins.size, 0);
  const env2 = fixture(t);
  const second = env2.local.save(input());
  env2.model("different-model");
  await assert.rejects(
    env2.controller().move({ id: second.id, direction: "to-cloud" }),
    /model/,
  );
  assert.equal(env2.origins.size, 0);
  const reasons = routineMigrationReasons({
    ...second,
    cwd: "/local",
    projectId: "p",
    environment: { kind: "space", spaceId: "s" },
    alwaysAllowed: [{ kind: "tool", tool: "shell", pattern: "rm *" }],
    repeat: { kind: "cron", expression: "*/15 * * * *" },
  });
  for (const reason of [
    "cwd",
    "projects",
    "space",
    "pattern_approvals",
    "sub_hourly",
  ])
    assert.ok(reasons.includes(reason as never));
});

test("lost import reply and router recreation reuse durable key instead of creating duplicate remote tasks", async (t) => {
  const env = fixture(t);
  const task = env.local.save(input());
  let api = env.controller();
  env.loseImport();
  await assert.rejects(
    api.move({ id: task.id, direction: "to-cloud" }),
    /Connection lost/,
  );
  assert.equal(env.local.list()[0].enabled, false);
  assert.equal(env.remote.list().length, 1);
  const key = env.journal().list()[0].key;
  assert.equal(env.journal().list()[0].state, "origin-locked");
  api = env.controller();
  const moved = await api.move({ id: task.id, direction: "to-cloud" });
  assert.equal(env.remote.list().length, 1);
  assert.equal(env.journal().list()[0].key, key);
  assert.equal(moved.toId, env.remote.list()[0].id);
});

test("lost delete reply and restore failure keep the local origin paused until deletion is confirmed and restoration retries", async (t) => {
  const env = fixture(t);
  const task = env.local.save(input());
  let api = env.controller();
  const moved = await api.move({ id: task.id, direction: "to-cloud" });
  env.loseDelete();
  await assert.rejects(
    api.move({ id: moved.toId, direction: "to-local" }),
    /Connection lost/,
  );
  assert.equal(env.local.list()[0].enabled, false);
  assert.equal(env.remote.list().length, 0);
  env.restoreFails(true);
  api = env.controller();
  await assert.rejects(
    api.move({ id: moved.toId, direction: "to-local" }),
    /Local restore/,
  );
  assert.equal(env.journal().list()[0].state, "remote-deleted");
  assert.equal(env.local.list()[0].enabled, false);
  env.restoreFails(false);
  api = env.controller();
  const restored = await api.move({ id: task.id, direction: "to-local" });
  assert.equal(restored.task.enabled, true);
  assert.equal(env.remote.list().length, 0);
  assert.equal(env.imported.get(env.journal().list()[0].key)?.deleted, true);
});

test("definite precreation refusal compensates origin, while account replacement prevents stale compensation", async (t) => {
  const env = fixture(t);
  const task = env.local.save(input());
  const api = env.controller();
  env.refuseImport();
  await assert.rejects(
    api.move({ id: task.id, direction: "to-cloud" }),
    /refused/,
  );
  assert.equal(env.local.list()[0].enabled, true);
  assert.equal(env.remote.list().length, 0);
  assert.equal(env.journal().list()[0].state, "local");
  const other = fixture(t);
  const source = other.local.save(input());
  const current = other.controller();
  const started = deferred<void>(),
    finish = deferred<void>();
  other.delayImport(async () => {
    started.resolve();
    await finish.promise;
  });
  const pending = current.move({ id: source.id, direction: "to-cloud" });
  const rejected = assert.rejects(pending, /account changed/);
  await started.promise;
  other.replaceOwner({ accountId: "account-B" });
  current.cloud.reset();
  finish.resolve();
  await rejected;
  assert.equal(
    other.calls.filter((call) => call === "local:restore").length,
    0,
  );
  assert.equal(other.local.list()[0].enabled, false);
  assert.equal(other.journal().list()[0].state, "origin-locked");
});

test("migration linkage is isolated by device and service and corrupt journals fail closed", async (t) => {
  const env = fixture(t);
  const source = env.local.save(input());
  let api = env.controller();
  const moved = await api.move({ id: source.id, direction: "to-cloud" });
  env.replaceOwner({ deviceId: "other-device" });
  api = env.controller();
  assert.equal((await api.eligibility(moved.toId, "remote")).toLocal.ok, false);
  env.replaceOwner({ deviceId: "device-A", serviceId: "https://other.test" });
  api = env.controller();
  assert.equal((await api.eligibility(moved.toId, "remote")).toLocal.ok, false);
  fs.writeFileSync(
    path.join(env.localRoot, "routine-migrations.json"),
    "broken",
  );
  await assert.rejects(
    api.move({ id: source.id, direction: "to-cloud" }),
    /recovery could not be read/,
  );
  assert.equal(env.local.list()[0].enabled, false);
});

test("different execution time zones refuse repeating migration before origin lock", async (t) => {
  const env = fixture(t);
  const source = env.local.save(input());
  const api = env.controller();
  env.zone("UTC");
  await assert.rejects(
    api.move({ id: source.id, direction: "to-cloud" }),
    /timezone/,
  );
  assert.equal(env.local.list()[0].enabled, true);
  assert.equal(env.origins.size, 0);
});

test("a later forward move uses a fresh cycle key after deleting the previous cloud version", async (t) => {
  const env = fixture(t);
  const source = env.local.save(input());
  const api = env.controller();
  const first = await api.move({ id: source.id, direction: "to-cloud" });
  const oldKey = env.journal().list()[0].key;
  await api.move({ id: first.toId, direction: "to-local" });
  const second = await api.move({ id: source.id, direction: "to-cloud" });
  assert.notEqual(first.toId, second.toId);
  assert.equal(env.journal().list().length, 2);
  assert.notEqual(env.journal().list().at(-1)!.key, oldKey);
  assert.equal(env.imported.get(oldKey)?.deleted, true);
});
