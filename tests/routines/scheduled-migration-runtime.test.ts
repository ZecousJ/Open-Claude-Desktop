import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import { routineMigrationLockedMessage } from "../../electron/routines/scheduler-support";
import { openPolicy } from "../../shared/client-policy";
import type { RoutineInput } from "../../shared/routines";
import type { Conversation } from "../../shared/types";

const NOW = Date.UTC(2026, 9, 19, 8);
const key = `rm1-${"a".repeat(64)}`,
  secondKey = `rm1-${"b".repeat(64)}`;
const input = (patch: Partial<RoutineInput> = {}): RoutineInput => ({
  name: "Review work",
  prompt: "Original instructions",
  mode: "cowork",
  providerId: "provider",
  model: "model",
  frequency: "daily",
  enabled: true,
  nextRunAt: NOW + 3600000,
  disableJitter: true,
  ...patch,
});
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-b31-migration-")),
  );
  let now = NOW,
    calls = 0;
  const options = {
    now: () => now,
    isBusy: () => false,
    run: async () => {
      calls++;
      return {
        id: `run-${calls}`,
        title: "Run",
        mode: "cowork",
        providerId: "provider",
        model: "model",
        createdAt: now,
        updatedAt: now,
        pinned: false,
        archived: false,
        turns: [
          {
            id: `turn-${calls}`,
            prompt: "Work",
            attachments: [],
            items: [],
            status: "completed",
            createdAt: now,
          },
        ],
      } as Conversation;
    },
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    options,
    create: () => new Scheduler(root, options),
    later: (value = NOW + 7200000) => {
      now = value;
    },
    calls: () => calls,
  };
}
function failRename(target: string) {
  const original = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === target)
      throw Object.assign(Error("disk rename failed"), { code: "EIO" });
    return original(from, to);
  }) as typeof original;
  return () => {
    fs.renameSync = original;
  };
}
const saved = (root: string): Record<string, any>[] =>
  JSON.parse(fs.readFileSync(path.join(root, "schedules.json"), "utf8"));
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const history = (root: string): Record<string, any[]> =>
  JSON.parse(fs.readFileSync(path.join(root, "routine-runs.json"), "utf8"));

test("5: begin persists the original snapshot and locks save/manual run/delete/tick across restart; replay returns the original", async (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const original = scheduler.save(
    input({
      description: "Original detail",
      permission: "default",
      defaultModel: true,
      notifyOnCompletion: { push: true, email: false, slack: false },
    }),
  );
  const begin = { key, id: original.id, expectedUpdatedAt: original.updatedAt };
  assert.deepEqual(wire(scheduler.beginMigration(begin)), {
    task: wire(original),
  });
  assert.equal(scheduler.list()[0].enabled, false);
  assert.equal(saved(env.root)[0].enabled, false);
  assert.throws(
    () => scheduler.save({ ...scheduler.list()[0], enabled: true }),
    { message: routineMigrationLockedMessage },
  );
  assert.throws(() => scheduler.delete(original.id), {
    message: routineMigrationLockedMessage,
  });
  await assert.rejects(scheduler.runNow(original.id), {
    message: routineMigrationLockedMessage,
  });
  env.later();
  scheduler = env.create();
  await scheduler.tick();
  assert.equal(env.calls(), 0);
  assert.deepEqual(
    wire(scheduler.beginMigration({ ...begin, expectedUpdatedAt: -1 })),
    { task: wire(original) },
  );
  assert.throws(
    () => scheduler.beginMigration({ ...begin, key: secondKey }),
    /moving/,
  );
  assert.throws(
    () => scheduler.beginMigration({ ...begin, id: "wrong" }),
    /different task/,
  );
});

test("5: a lock journal committed before a failed task write still blocks a due task after restart and begin retry finishes disabling it", async (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const original = scheduler.save(input());
  const fail = failRename(path.join(env.root, "schedules.json"));
  try {
    assert.throws(
      () =>
        scheduler.beginMigration({
          key,
          id: original.id,
          expectedUpdatedAt: original.updatedAt,
        }),
      /disk rename failed/,
    );
  } finally {
    fail();
  }
  assert.equal(
    saved(env.root)[0].enabled,
    true,
    "simulate crash before schedules disable commit",
  );
  env.later();
  scheduler = env.create();
  assert.equal(
    scheduler.list()[0].enabled,
    false,
    "journal lock overrides an older enabled schedule JSON",
  );
  await scheduler.tick();
  assert.equal(env.calls(), 0);
  await assert.rejects(scheduler.runNow(original.id), /moving/);
  assert.throws(
    () => scheduler.save({ ...scheduler.list()[0], enabled: true }),
    /moving/,
  );
  assert.throws(() => scheduler.delete(original.id), /moving/);
  assert.deepEqual(
    wire(
      scheduler.beginMigration({
        key,
        id: original.id,
        expectedUpdatedAt: original.updatedAt,
      }),
    ),
    { task: wire(original) },
  );
  assert.equal(saved(env.root)[0].enabled, false);
});

test("5: a journal failure leaves the task unchanged and unlocked; stale/paused/running origins and malformed keys never lock", async (t) => {
  const env = fixture(t);
  const scheduler = env.create();
  const original = scheduler.save(input());
  const fail = failRename(
    path.join(env.root, "routine-migration-scheduler.json"),
  );
  try {
    assert.throws(
      () =>
        scheduler.beginMigration({
          key,
          id: original.id,
          expectedUpdatedAt: original.updatedAt,
        }),
      /disk rename failed/,
    );
  } finally {
    fail();
  }
  assert.equal(scheduler.list()[0].enabled, true);
  assert.throws(
    () =>
      scheduler.beginMigration({ key, id: original.id, expectedUpdatedAt: -1 }),
    /changed/,
  );
  for (const invalid of [
    "",
    "rm1-a",
    `rm1-${"A".repeat(64)}`,
    `other-${"a".repeat(64)}`,
  ])
    assert.throws(
      () =>
        scheduler.beginMigration({
          key: invalid,
          id: original.id,
          expectedUpdatedAt: original.updatedAt,
        }),
      /key/,
    );
  const paused = scheduler.save({ ...original, enabled: false });
  assert.throws(
    () =>
      scheduler.beginMigration({
        key,
        id: paused.id,
        expectedUpdatedAt: paused.updatedAt,
      }),
    /Turn on/,
  );
  assert.equal(
    fs.existsSync(path.join(env.root, "routine-migration-scheduler.json")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(env.root, "routine-migration-scheduler.json.tmp")),
    false,
  );
  const running = { ...paused, enabled: true, lastRunStatus: "running" };
  fs.writeFileSync(
    path.join(env.root, "schedules.json"),
    JSON.stringify([running]),
  );
  let release!: (value: Conversation) => void;
  const active = new Scheduler(path.join(env.root, "active"), {
    ...env.options,
    run: () =>
      new Promise<Conversation>((resolve) => {
        release = resolve;
      }),
  });
  const task = active.save(input());
  const pending = active.runNow(task.id);
  await Promise.resolve();
  assert.throws(
    () =>
      active.beginMigration({
        key,
        id: task.id,
        expectedUpdatedAt: active.list()[0].updatedAt,
      }),
    /running/,
  );
  release(await env.options.run());
  await pending;
});

test("5: restore resets the original settings and history with only cloud instructions replaced, then replay preserves later edits", async (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const original = scheduler.save(
    input({
      description: "Keep original",
      permission: "default",
      repeat: { kind: "daily", time: "18:30" },
      defaultModel: true,
    }),
  );
  await scheduler.runNow(original.id);
  const before = scheduler.list()[0],
    runs = scheduler.runs(original.id);
  scheduler.beginMigration({
    key,
    id: before.id,
    expectedUpdatedAt: before.updatedAt,
  });
  env.later();
  scheduler = env.create();
  const restored = scheduler.restoreMigration({
    key,
    id: original.id,
    prompt: "Cloud instructions only",
  });
  assert.deepEqual(
    wire({ ...restored, prompt: before.prompt, updatedAt: before.updatedAt }),
    wire(before),
  );
  assert.deepEqual(scheduler.runs(original.id), runs);
  assert.equal(restored.enabled, true);
  const edited = scheduler.save({
    ...restored,
    name: "Later local edit",
    prompt: "Later local prompt",
  });
  scheduler = env.create();
  assert.deepEqual(
    wire(
      scheduler.restoreMigration({
        key,
        id: original.id,
        prompt: "stale reply",
      }),
    ),
    wire(edited),
  );
  assert.deepEqual(
    wire(
      scheduler.beginMigration({ key, id: original.id, expectedUpdatedAt: 0 }),
    ),
    { task: wire(before) },
  );
  assert.equal(scheduler.list()[0].name, "Later local edit");
});

test("5: restore's task marker survives failure finalizing the journal and prevents retry from overwriting newer edits", (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const original = scheduler.save(input());
  scheduler.beginMigration({
    key,
    id: original.id,
    expectedUpdatedAt: original.updatedAt,
  });
  const fail = failRename(
    path.join(env.root, "routine-migration-scheduler.json"),
  );
  try {
    assert.throws(
      () =>
        scheduler.restoreMigration({
          key,
          id: original.id,
          prompt: "Restored cloud prompt",
        }),
      /disk rename failed/,
    );
  } finally {
    fail();
  }
  assert.equal(saved(env.root)[0].migrationRestoreKey, key);
  const edited = scheduler.save({
    ...scheduler.list()[0],
    prompt: "User's newer instructions",
  });
  scheduler = env.create();
  assert.deepEqual(
    wire(
      scheduler.restoreMigration({
        key,
        id: original.id,
        prompt: "Old cloud prompt",
      }),
    ),
    wire(edited),
  );
  scheduler.beginMigration({
    key: secondKey,
    id: original.id,
    expectedUpdatedAt: edited.updatedAt,
  });
  const second = scheduler.restoreMigration({
    key: secondKey,
    id: original.id,
    prompt: "New cloud round",
  });
  assert.equal(
    second.enabled,
    true,
    "an older unfinished journal record cannot resurrect its lock",
  );
  assert.equal(
    scheduler.save({ ...second, name: "Editable again" }).name,
    "Editable again",
  );
});

test("5: imported key is in the same schedules commit, survives ordinary edits/restart and cannot be forged through save input", (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const imported = scheduler.importMigration({ key, task: input() });
  assert.equal(saved(env.root)[0].migrationImportKey, key);
  assert.ok(!("migrationImportKey" in imported));
  assert.equal(
    scheduler.importMigration({
      key,
      task: input({ prompt: "Lost reply retried" }),
    }).id,
    imported.id,
  );
  const edited = scheduler.save({
    ...imported,
    name: "Edited remote name",
    prompt: "Edited remotely",
    migrationImportKey: secondKey,
    migrationRestoreKey: secondKey,
  } as RoutineInput);
  assert.equal(saved(env.root)[0].migrationImportKey, key);
  assert.equal(saved(env.root)[0].migrationRestoreKey, undefined);
  scheduler = env.create();
  assert.deepEqual(
    wire(scheduler.importMigration({ key, task: input() })),
    wire(edited),
  );
  assert.equal(scheduler.list().length, 1);
  const forged = scheduler.save({
    ...input({ name: "Ordinary task" }),
    migrationImportKey: secondKey,
    migrationRestoreKey: secondKey,
  } as RoutineInput);
  const disk = saved(env.root).find((task) => task.id === forged.id)!;
  assert.equal(disk.migrationImportKey, undefined);
  assert.equal(disk.migrationRestoreKey, undefined);
  const setup = scheduler.save(input({ name: "Setup task" }), {
    setupConversationId: "chat-setup",
  });
  assert.equal(
    scheduler.save(input({ name: "A replay" }), {
      setupConversationId: "chat-setup",
    }).id,
    setup.id,
  );
  assert.throws(
    () => scheduler.save(input(), { setupConversationId: "" }),
    /origin/,
  );
  assert.throws(
    () => scheduler.save(input(), { migrationImportKey: secondKey } as never),
    /origin/,
  );
  const projected = scheduler.save(input({ name: "Projected setup" }), {
    setupConversationId: "other-setup",
    migrationImportKey: secondKey,
  } as never);
  assert.equal(
    saved(env.root).find((task) => task.id === projected.id)!
      .migrationImportKey,
    undefined,
  );
});

test("5: validation/policy precreation refusals are tagged; uncertain import filesystem failures stay untagged and replay creates once", (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  assert.throws(
    () => scheduler.importMigration({ key, task: input({ name: "" }) }),
    { code: "CLAUDEX_MIGRATION_NOT_CREATED" },
  );
  const refused = new Scheduler(path.join(env.root, "refused"), {
    ...env.options,
    policy: () => ({
      ...openPolicy,
      scheduledTasks: { ...openPolicy.scheduledTasks, enabled: false },
    }),
  });
  assert.throws(() => refused.importMigration({ key, task: input() }), {
    code: "CLAUDEX_MIGRATION_NOT_CREATED",
  });
  const fail = failRename(path.join(env.root, "schedules.json"));
  try {
    assert.throws(
      () => scheduler.importMigration({ key, task: input() }),
      (error: any) => error.code === "EIO",
    );
  } finally {
    fail();
  }
  scheduler = env.create();
  const imported = scheduler.importMigration({ key, task: input() });
  scheduler = env.create();
  assert.equal(
    scheduler.importMigration({ key, task: input() }).id,
    imported.id,
  );
  assert.equal(saved(env.root).length, 1);
});

test("5: delete confirms real task/history deletion, exact-key replay is safe and a permanent tombstone rejects reimport", async (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const imported = scheduler.importMigration({ key, task: input() });
  await scheduler.runNow(imported.id);
  assert.equal(scheduler.runs(imported.id).length, 1);
  assert.throws(
    () => scheduler.deleteMigration({ key: secondKey, id: imported.id }),
    /not created/,
  );
  assert.throws(
    () => scheduler.deleteMigration({ key, id: "wrong" }),
    /not created/,
  );
  assert.deepEqual(scheduler.deleteMigration({ key, id: imported.id }), {
    deleted: true,
    historyDeleted: true,
  });
  assert.equal(saved(env.root).length, 0);
  assert.equal(history(env.root)[imported.id], undefined);
  scheduler = env.create();
  assert.deepEqual(scheduler.deleteMigration({ key, id: imported.id }), {
    deleted: true,
    historyDeleted: true,
  });
  assert.throws(
    () => scheduler.deleteMigration({ key, id: "wrong" }),
    /different task/,
  );
  assert.throws(
    () => scheduler.importMigration({ key, task: input() }),
    (error: any) =>
      error.message.includes("deleted") && error.code === undefined,
  );
  assert.equal(scheduler.list().length, 0);
});

test("5: a deletion tombstone precedes task deletion and prevents execution/recreation if that task write fails", async (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const imported = scheduler.importMigration({ key, task: input() });
  await scheduler.runNow(imported.id);
  const fail = failRename(path.join(env.root, "schedules.json"));
  try {
    assert.throws(
      () => scheduler.deleteMigration({ key, id: imported.id }),
      /disk rename failed/,
    );
  } finally {
    fail();
  }
  assert.equal(saved(env.root)[0].id, imported.id);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(env.root, "routine-migration-scheduler.json"),
        "utf8",
      ),
    ).records[0].kind,
    "deleted",
  );
  env.later();
  scheduler = env.create();
  await scheduler.tick();
  assert.equal(env.calls(), 1);
  await assert.rejects(scheduler.runNow(imported.id), /moving/);
  assert.throws(
    () => scheduler.save({ ...scheduler.list()[0], enabled: true }),
    /moving/,
  );
  assert.throws(
    () => scheduler.importMigration({ key, task: input() }),
    /deleted/,
  );
  assert.deepEqual(scheduler.deleteMigration({ key, id: imported.id }), {
    deleted: true,
    historyDeleted: true,
  });
  assert.equal(history(env.root)[imported.id], undefined);
});

test("5: failed history deletion cannot acknowledge completion; restart/replay finishes cleanup without recreating the task", async (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const imported = scheduler.importMigration({ key, task: input() });
  await scheduler.runNow(imported.id);
  const fail = failRename(path.join(env.root, "routine-runs.json"));
  try {
    assert.throws(
      () => scheduler.deleteMigration({ key, id: imported.id }),
      /disk rename failed/,
    );
  } finally {
    fail();
  }
  assert.equal(saved(env.root).length, 0);
  assert.equal(history(env.root)[imported.id].length, 1);
  scheduler = env.create();
  assert.throws(
    () => scheduler.importMigration({ key, task: input() }),
    /deleted/,
  );
  assert.deepEqual(scheduler.deleteMigration({ key, id: imported.id }), {
    deleted: true,
    historyDeleted: true,
  });
  assert.equal(history(env.root)[imported.id], undefined);
  assert.equal(
    fs.existsSync(path.join(env.root, "routine-runs.json.tmp")),
    false,
  );
});

test("5: journals are account-root scoped, corrupt recovery fails closed and is never replaced", (t) => {
  const env = fixture(t);
  const first = env.create();
  const original = first.save(input());
  first.beginMigration({
    key,
    id: original.id,
    expectedUpdatedAt: original.updatedAt,
  });
  const other = new Scheduler(
    path.join(env.root, "another-account"),
    env.options,
  );
  const imported = other.importMigration({ key, task: input() });
  assert.notEqual(imported.id, original.id);
  assert.throws(
    () =>
      other.restoreMigration({ key, id: original.id, prompt: "Cross-account" }),
    /does not belong/,
  );
  fs.writeFileSync(
    path.join(env.root, "routine-migration-scheduler.json"),
    "broken recovery",
  );
  assert.throws(() => env.create(), /recovery could not be read/);
  assert.equal(
    fs.readFileSync(
      path.join(env.root, "routine-migration-scheduler.json"),
      "utf8",
    ),
    "broken recovery",
  );
});

test("5: ordinary deletion of an imported task retains the permanent migration tombstone", (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const imported = scheduler.importMigration({ key, task: input() });
  scheduler.delete(imported.id);
  scheduler = env.create();
  assert.throws(
    () => scheduler.importMigration({ key, task: input() }),
    /deleted/,
  );
  assert.deepEqual(scheduler.deleteMigration({ key, id: imported.id }), {
    deleted: true,
    historyDeleted: true,
  });
  assert.equal(saved(env.root).length, 0);
});

test("5: failed restore task write retains the lock; failed initial deletion journal leaves an import editable", (t) => {
  const env = fixture(t);
  const scheduler = env.create();
  const original = scheduler.save(input());
  scheduler.beginMigration({
    key,
    id: original.id,
    expectedUpdatedAt: original.updatedAt,
  });
  const fail = failRename(path.join(env.root, "schedules.json"));
  try {
    assert.throws(
      () =>
        scheduler.restoreMigration({
          key,
          id: original.id,
          prompt: "New instructions",
        }),
      /disk rename failed/,
    );
  } finally {
    fail();
  }
  assert.throws(
    () => scheduler.save({ ...scheduler.list()[0], enabled: true }),
    /moving/,
  );
  assert.equal(
    scheduler.restoreMigration({
      key,
      id: original.id,
      prompt: "New instructions",
    }).enabled,
    true,
  );
  const imported = scheduler.importMigration({
    key: secondKey,
    task: input({ name: "Imported other task" }),
  });
  const failJournal = failRename(
    path.join(env.root, "routine-migration-scheduler.json"),
  );
  try {
    assert.throws(
      () => scheduler.deleteMigration({ key: secondKey, id: imported.id }),
      /disk rename failed/,
    );
  } finally {
    failJournal();
  }
  assert.equal(
    scheduler.save({ ...imported, name: "Still editable" }).name,
    "Still editable",
  );
});

test("5: a completed deletion replay needs no further task/history write and cannot acknowledge a different ID", (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const imported = scheduler.importMigration({ key, task: input() });
  scheduler.deleteMigration({ key, id: imported.id });
  scheduler = env.create();
  const fail = failRename(path.join(env.root, "routine-runs.json"));
  try {
    assert.deepEqual(scheduler.deleteMigration({ key, id: imported.id }), {
      deleted: true,
      historyDeleted: true,
    });
  } finally {
    fail();
  }
  assert.throws(
    () => scheduler.deleteMigration({ key, id: "wrong-task" }),
    /different task/,
  );
});

test("5: ordinary delete can retry an imported task's failed history cleanup after restart", async (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  const imported = scheduler.importMigration({ key, task: input() });
  await scheduler.runNow(imported.id);
  const fail = failRename(path.join(env.root, "routine-runs.json"));
  try {
    assert.throws(() => scheduler.delete(imported.id), /disk rename failed/);
  } finally {
    fail();
  }
  scheduler = env.create();
  scheduler.delete(imported.id);
  assert.equal(history(env.root)[imported.id], undefined);
  assert.throws(
    () => scheduler.importMigration({ key, task: input() }),
    /deleted/,
  );
});

test("5: backend preparation runs once before creation and is skipped on lost-response replay even after the provider disappears", (t) => {
  const env = fixture(t);
  let scheduler = env.create();
  let calls = 0,
    unavailable = false;
  const prepare = (task: RoutineInput) => {
    calls++;
    if (unavailable) throw Error("Provider was removed");
    return {
      ...task,
      providerId: "resolved-provider",
      model: "resolved-model",
    };
  };
  const imported = scheduler.importMigration({ key, task: input() }, prepare);
  assert.equal(calls, 1);
  assert.equal(imported.providerId, "resolved-provider");
  unavailable = true;
  scheduler = env.create();
  assert.equal(
    scheduler.importMigration({ key, task: input() }, prepare).id,
    imported.id,
  );
  assert.equal(
    calls,
    1,
    "replay must not require the old provider, source or execution preparer",
  );
  assert.throws(
    () =>
      scheduler.importMigration(
        { key: secondKey, task: input({ name: "Other import" }) },
        prepare,
      ),
    { code: "CLAUDEX_MIGRATION_NOT_CREATED" },
  );
  assert.equal(scheduler.list().length, 1);
});
