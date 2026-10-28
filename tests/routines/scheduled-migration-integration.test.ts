import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { Scheduler } from "../../electron/routines/scheduler";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import type { AppContext } from "../../electron/app/app-context";
import { CloudRoutines } from "../../electron/cloud/cloud-routines";
import type { CloudCalls } from "../../electron/cloud/cloud-router";
import { RoutineMigrationRegistry } from "../../electron/cloud/routine-migration-registry";
import { openPolicy } from "../../shared/client-policy";
import type { Routine, RoutineInput } from "../../shared/routines";

function backend(t: TestContext, root: string) {
  const store = new Store(root);
  store.settings.providers[0].model = "Opus";
  store.settings.providers[0].models = ["Opus"];
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => {
      throw Error("No model or scheduled job is run in this test");
    },
    policy: () => openPolicy,
  });
  const ctx = {
    store,
    scheduler,
    dataRoot: root,
    services: {},
    engine: { approvals: [] },
    routineSources: () => ["chat", "code"],
    policy: () => openPolicy,
    allowedFolder() {},
    onAccountActivated() {},
    onAccountDeactivating() {},
    onSettingsChanged: () => () => {},
  } as unknown as AppContext;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCollectionHandlers(
    (name, handler) => handlers.set(name, handler),
    ctx,
  );
  return {
    store,
    scheduler,
    handlers,
    dispose: () => {
      scheduler.stop();
      store.flush();
    },
  };
}
const input = (): RoutineInput => ({
  name: "Owned migration",
  prompt: "Original local instructions",
  mode: "cowork",
  providerId: "default",
  model: "Opus",
  frequency: "daily",
  repeat: { kind: "daily", time: "09:00" },
  nextRunAt: Date.now() + 86400000,
  enabled: true,
  executionLocation: "local",
});

test("5 partial: actual registered local/remote handlers and Schedulers complete forward/back without lifecycle contract adapters", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b31-ipc-migration-"),
  );
  const local = backend(t, path.join(root, "local")),
    remote = backend(t, path.join(root, "remote"));
  t.after(() => {
    local.dispose();
    remote.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const journal = new RoutineMigrationRegistry(path.join(root, "local"));
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    call: async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      const fn = remote.handlers.get(method);
      assert.ok(fn, method);
      return fn(...args);
    },
  } as unknown as CloudCalls;
  const router = new CloudRoutines(
    () => client,
    () => ({
      owner: {
        accountId: "owner",
        serviceId: "https://service.test",
        deviceId: "device",
      },
      journal,
    }),
  );
  for (const [name, handler] of local.handlers) router.route(name, handler);
  const call = async (name: string, ...args: unknown[]) => {
    const handler = local.handlers.get(name)!;
    return (router.route(name, handler) ?? handler)(...args);
  };
  const original = (await call("saveSchedule", input())) as Routine;
  assert.equal(
    (await call("routineMigration", original.id, "local")).toCloud.ok,
    true,
  );
  const moved = await call("migrateRoutine", {
    id: original.id,
    direction: "to-cloud",
  });
  assert.equal(moved.fromId, original.id);
  assert.notEqual(moved.toId, original.id);
  assert.equal(local.scheduler.list()[0].enabled, false);
  assert.equal(remote.scheduler.list().length, 1);
  assert.throws(
    () => local.scheduler.save({ ...original, enabled: true }),
    /Finish that move/,
  );
  assert.equal(
    (await call("listSchedules")).length,
    1,
    "only the cloud copy is listed after successful move",
  );
  const cloud = remote.scheduler.list()[0];
  remote.handlers.get("saveSchedule")!({
    ...cloud,
    name: "Cloud rename",
    prompt: "Updated cloud instructions",
  });
  const restored = await call("migrateRoutine", {
    id: cloud.id,
    direction: "to-local",
  });
  assert.equal(restored.toId, original.id);
  assert.equal(restored.task.name, original.name);
  assert.equal(restored.task.prompt, "Updated cloud instructions");
  assert.equal(restored.history, "cloud-deleted");
  assert.equal(remote.scheduler.list().length, 0);
  assert.equal(local.scheduler.list()[0].enabled, true);
  assert.ok(calls.some((value) => value.method === "importRoutineMigration"));
  assert.ok(calls.some((value) => value.method === "deleteRoutineMigration"));
  assert.equal(
    JSON.stringify(
      calls.filter((value) => value.method === "importRoutineMigration"),
    ).includes(root),
    false,
    "local recovery paths never enter the cloud payload",
  );
});

test("5 partial: actual import IPC validates owned context before creation and skips provider preparation for a durable replay", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b31-ipc-import-"),
  );
  const remote = backend(t, root),
    call = remote.handlers.get("importRoutineMigration")!,
    key = "rm1-" + "a".repeat(64);
  t.after(() => {
    remote.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.throws(
    () =>
      call({ key, task: { ...input(), projectId: "another-account-project" } }),
    (error: any) => error.code === "CLAUDEX_MIGRATION_NOT_CREATED",
  );
  assert.equal(remote.scheduler.list().length, 0);
  const saved = call({ key, task: input() }) as Routine;
  remote.store.settings.providers = [];
  assert.equal((call({ key, task: input() }) as Routine).id, saved.id);
  const removed = remote.handlers.get("deleteRoutineMigration")!({
    key,
    id: saved.id,
  });
  assert.deepEqual(removed, { deleted: true, historyDeleted: true });
  assert.throws(() => call({ key, task: input() }), /already used or deleted/);
  assert.equal(remote.scheduler.list().length, 0);
});
