import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { CloudRoutines } from "../../electron/cloud/cloud-routines";
import type { CloudCalls } from "../../electron/cloud/cloud-router";
import { Scheduler } from "../../electron/routines/scheduler";
import { Store } from "../../electron/store/store";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import type { AppContext } from "../../electron/app/app-context";
import type {
  Routine,
  RoutineInput,
  RoutineRunPage,
} from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";
import { RoutineHistory } from "../../src/collections/routines/RoutineHistory";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import { routineDom } from "../support/routine-dom";

const now = Date.UTC(2026, 9, 17, 0, 1);
const task = (id: string, name: string): Routine => ({
  id,
  name,
  prompt: "Review this.",
  mode: "cowork",
  model: "Opus",
  providerId: "p",
  enabled: true,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:00" },
  createdAt: now,
  updatedAt: now,
  nextRunAt: now + 86_400_000,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("reviewer: refreshing a remotely renamed task must revalidate the incoming old name against local tasks", async () => {
  const local = [task("local", "Alpha")];
  let remote = [task("remote", "Alpha")]; // A legitimate legacy duplicate is initially unchanged.
  let writes = 0;
  const client: CloudCalls = {
    call: async (method, args) => {
      if (method === "listSchedules") return structuredClone(remote);
      if (method === "saveSchedule") {
        writes++;
        remote = [{ ...remote[0], ...(args?.[0] as RoutineInput) }];
        return remote[0];
      }
      throw new Error("Unexpected method");
    },
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  const cloud = new CloudRoutines(() => client);
  await cloud.route("listSchedules", async () => structuredClone(local))!();
  const save = cloud.route("saveSchedule", async () => {
    throw new Error("must use remote");
  })!;
  remote = [task("remote", "Beta")]; // Another session changed the real source after the editor loaded Alpha.
  await assert.rejects(
    save({
      ...task("remote", "Alpha"),
      prompt: "Edited instructions",
      executionLocation: "remote",
    }),
    /already exists/,
  );
  assert.equal(
    writes,
    0,
    "freshly observed Beta -> Alpha is a rename and must not recreate the collision",
  );
});

test("reviewer: truly unchanged legacy duplicate names remain pausable after fresh source validation", async () => {
  const local = [task("local", "Alpha")];
  let remote = [task("remote", "Alpha")];
  const client: CloudCalls = {
    call: async (method, args) => {
      if (method === "listSchedules") return structuredClone(remote);
      remote = [{ ...remote[0], ...(args?.[0] as RoutineInput) }];
      return remote[0];
    },
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  const cloud = new CloudRoutines(() => client);
  await cloud.route("listSchedules", async () => local)!();
  const saved = await cloud.route("saveSchedule", async () => {
    throw new Error("wrong source");
  })!({ ...remote[0], enabled: false, executionLocation: "remote" });
  assert.equal(saved.enabled, false);
  assert.equal(saved.name, "Alpha");
});

test("reviewer: real IPC paging validates task ownership and opaque cursors across independent account stores", (context) => {
  const folder = fs.mkdtempSync("/tmp/claudex-r4-scheduled-cross-accounts-");
  context.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const options = {
    now: () => now,
    isBusy: () => false,
    run: async () => {
      throw new Error("unused");
    },
  };
  const a = new Scheduler(path.join(folder, "a"), options),
    b = new Scheduler(path.join(folder, "b"), options);
  const fields: RoutineInput = { ...task("", "Owned"), id: undefined };
  const aTask = a.save(fields),
    bTask = b.save(fields);
  const runs: RoutineRun[] = Array.from({ length: 3 }, (_, index) => ({
    id: `run-${index}`,
    startedAt: now - index,
    status: "completed",
    trigger: "manual",
  }));
  fs.writeFileSync(
    path.join(folder, "a", "routine-runs.json"),
    JSON.stringify({ [aTask.id]: runs }),
  );
  const restored = new Scheduler(path.join(folder, "a"), options);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerCollectionHandlers((name, handler) => handlers.set(name, handler), {
    store: new Store(path.join(folder, "b")),
    scheduler: b,
    allowedFolder() {},
    onAccountActivated() {},
    onAccountDeactivating() {},
    onSettingsChanged: () => () => {},
  } as unknown as AppContext);
  const cursor = restored.runsPage(aTask.id, { limit: 1 }).nextCursor!;
  assert.ok(cursor);
  assert.throws(
    () => handlers.get("routineRunsPage")!(aTask.id, { cursor, limit: 1 }),
    Error,
  );
  assert.throws(
    () => handlers.get("routineRunsPage")!(bTask.id, { cursor, limit: 1 }),
    Error,
  );
  assert.deepEqual(handlers.get("routineRunsPage")!(bTask.id, { limit: 1 }), {
    runs: [],
  });
});

test("reviewer: late remote receipts and approval removals cannot settle under the next account", async () => {
  for (const method of ["markRoutineRunRead", "removeRoutineApproval"]) {
    const answer = deferred<unknown>();
    let owner = "A",
      active = "A",
      localCalls = 0,
      bCalls = 0;
    const a: CloudCalls = {
      call: async (name) =>
        name === "listSchedules" ? [task("a-task", "A task")] : answer.promise,
      snapshot: async () => {
        throw new Error("unused");
      },
    };
    const b: CloudCalls = {
      call: async () => {
        bCalls++;
        return [];
      },
      snapshot: async () => {
        throw new Error("unused");
      },
    };
    const cloud = new CloudRoutines(() => {
      if (owner !== active) {
        active = owner;
        cloud.reset();
      }
      return owner === "A" ? a : b;
    });
    await cloud.route("listSchedules", async () => [])!();
    const result = cloud.route(method, async () => {
      localCalls++;
    })!(
      "a-task",
      method === "markRoutineRunRead" ? "run" : { kind: "tool", tool: "Read" },
    );
    const rejected = assert.rejects(result, /Couldn’t connect/);
    owner = "B";
    answer.resolve(undefined);
    await rejected;
    assert.equal(localCalls, 0);
    assert.equal(
      bCalls,
      0,
      "the stale operation must never be retried with B's client",
    );
  }
});

test("reviewer: actual schedule preview uses the execution machine's timezone rather than a browser-local approximation", (context) => {
  const folder = fs.mkdtempSync("/tmp/claudex-r4-scheduled-cross-zones-");
  context.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const original = process.env.TZ;
  try {
    const scheduler = new Scheduler(folder, {
      now: () => now,
      isBusy: () => false,
      run: async () => {
        throw new Error("unused");
      },
    });
    const rule = { kind: "cron", expression: "0 9 * * *" } as const;
    process.env.TZ = "America/New_York";
    assert.deepEqual(scheduler.preview(rule), {
      nextRunAt: Date.UTC(2026, 9, 17, 13),
      timeZone: "America/New_York",
    });
    process.env.TZ = "Asia/Tokyo";
    assert.deepEqual(scheduler.preview(rule), {
      nextRunAt: Date.UTC(2026, 9, 18, 0),
      timeZone: "Asia/Tokyo",
    });
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("reviewer: an unmounted history panel does not inspect or append a late page payload", async () => {
  const answer = deferred<RoutineRunPage>();
  let fieldsRead = 0;
  const page = await routineDom({
    routineRunsPage: async (_id, query) =>
      query?.cursor
        ? answer.promise
        : {
            runs: [
              {
                id: "first",
                startedAt: now,
                status: "completed",
                trigger: "manual",
              },
            ],
            nextCursor: "opaque-cursor",
          },
  });
  try {
    await page.render(
      createElement(
        HostContext.Provider,
        { value: webHost },
        createElement(RoutineHistory, {
          routine: task("A", "A"),
          onOpenConversation() {},
        }),
      ),
    );
    await page.click(".routine-history-more");
    await page.render(
      createElement("p", { "data-new-page": true }, "Another page"),
    );
    await act(async () =>
      answer.resolve({
        get runs() {
          fieldsRead++;
          return [];
        },
      }),
    );
    assert.equal(fieldsRead, 0);
    assert.equal(
      page.document.querySelector("[data-new-page]")?.textContent,
      "Another page",
    );
  } finally {
    await page.clean();
  }
});
