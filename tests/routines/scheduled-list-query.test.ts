import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { act, createElement as h, StrictMode } from "react";
import { Scheduler } from "../../electron/routines/scheduler";
import { defaultSettings, Store } from "../../electron/store/store";
import { CloudRoutines } from "../../electron/cloud/cloud-routines";
import {
  queryRoutineList,
  readRoutine,
} from "../../electron/routines/routine-query";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import type { AppContext } from "../../electron/app/app-context";
import type { CloudCalls } from "../../electron/cloud/cloud-router";
import type {
  Routine,
  RoutineListResult,
  RoutineDetailResult,
} from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";
import type { Conversation, Approval } from "../../shared/types";
import { webRemoteRunnerMethods } from "../../shared/web-bridge-methods";
import { desktopHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { RoutinesPage } from "../../src/collections/routines/RoutinesPage";
import {
  defaultRoutineFilter,
  offeredRoutineFilters,
  routineAttention,
  visibleRoutines,
} from "../../src/collections/routines/routine-list";
import {
  readRoutineList,
  useRoutineQuery,
  useRoutineDetail,
} from "../../src/collections/routines/useRoutineQuery";
import { routineDom } from "../support/routine-dom";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";

const task = (id: string, patch: Partial<Routine> = {}): Routine => ({
  id,
  name: id,
  prompt: "Synthetic instructions",
  mode: "code",
  providerId: "p",
  model: "m",
  frequency: "daily",
  nextRunAt: Date.now() + 86_400_000,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  repeat: { kind: "daily", time: "09:00" },
  ...patch,
});
const result = (
  tasks: Routine[],
  source: "local" | "remote" = "local",
): RoutineListResult => ({ tasks, sources: [{ source, status: "ready" }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("real local/runner list protocol summarizes all retained runs and older linked conversations without transcripts", (t) => {
  const folder = fs.mkdtempSync("/tmp/claudex-b20-query-");
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const store = new Store(folder);
  const makeScheduler = () =>
    new Scheduler(path.join(folder, "scheduler"), {
      isBusy: () => false,
      run: async () => {
        throw new Error("unused");
      },
    });
  const initial = makeScheduler();
  const { id: _id, ...input } = task("all-runs");
  const saved = initial.save(input);
  const runs: RoutineRun[] = [
    {
      id: "latest",
      status: "completed",
      startedAt: 30,
      trigger: "manual",
      readAt: 40,
      conversationId: "latest-chat",
    },
    {
      id: "older",
      status: "completed",
      startedAt: 20,
      trigger: "manual",
      conversationId: "older-chat",
    },
    {
      id: "failed",
      status: "failed",
      startedAt: 10,
      trigger: "manual",
      conversationId: "failed-chat",
    },
  ];
  fs.writeFileSync(
    path.join(folder, "scheduler/routine-runs.json"),
    JSON.stringify({ [saved.id]: runs }),
  );
  store.conversations = [
    { id: "latest-chat", scheduledTaskId: saved.id, unread: false, turns: [] },
    { id: "older-chat", scheduledTaskId: saved.id, unread: true, turns: [] },
    {
      id: "evicted-history-chat",
      scheduledTaskId: saved.id,
      unread: true,
      turns: [{ status: "failed" }],
    },
    { id: "unrelated", unread: true, turns: [] },
  ] as unknown as Conversation[];
  const ctx = {
    store,
    scheduler: makeScheduler(),
    engine: {
      approvals: [
        { id: "old-wait", conversationId: "older-chat" },
        { id: "evicted-wait", conversationId: "evicted-history-chat" },
        { id: "other-wait", conversationId: "unrelated" },
      ],
    },
    allowedFolder() {},
    onAccountActivated() {},
    onAccountDeactivating() {},
    onSettingsChanged: () => () => {},
  } as unknown as AppContext;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCollectionHandlers((name, fn) => handlers.set(name, fn), ctx);
  const listed = handlers.get("querySchedules")!() as RoutineListResult;
  assert.deepEqual(listed.sources, [{ source: "local", status: "ready" }]);
  const metadata = listed.tasks[0].listMetadata!;
  assert.equal(metadata.source, "code");
  assert.equal(metadata.host, "this-computer");
  assert.equal(metadata.attention.unread, 2);
  assert.equal(metadata.attention.awaiting, 2);
  assert.equal(metadata.attention.failed, 2);
  assert.ok(
    metadata.attention.conversationIds.includes("evicted-history-chat"),
  );
  assert.equal(JSON.stringify(listed).includes('"turns"'), false);
  assert.equal(
    queryRoutineList(ctx, "remote").tasks[0].listMetadata?.host,
    "cloud",
  );
  assert.equal(readRoutine(ctx, "remote", saved.id).status, "ready");
  const spaceContext = {
    ...ctx,
    scheduler: {
      list: () => [
        task("space", { environment: { kind: "space", spaceId: "s" } }),
      ],
      runs: () => [],
    },
  } as unknown as AppContext;
  assert.equal(
    queryRoutineList(spaceContext, "local").tasks[0].listMetadata?.host,
    undefined,
    "a cloud space is never guessed to be this computer",
  );
  assert.deepEqual(handlers.get("readSchedule")!("not-present"), {
    status: "missing",
  });
  assert.ok(webRemoteRunnerMethods.includes("querySchedules"));
  assert.ok(webRemoteRunnerMethods.includes("readSchedule"));
});

test("source/host/status filters offer only known facts and include connection holds", () => {
  const rows = [
    task("code", {
      listMetadata: {
        source: "code",
        host: "this-computer",
        attention: { unread: 0, awaiting: 0, failed: 0, conversationIds: [] },
      },
    }),
    task("chat", {
      mode: "cowork",
      executionLocation: "remote",
      connectionHold: { service: "test" },
      listMetadata: {
        source: "chat",
        host: "cloud",
        attention: { unread: 0, awaiting: 0, failed: 0, conversationIds: [] },
      },
    }),
    task("another", {
      listMetadata: {
        source: "code",
        host: "another-computer",
        attention: { unread: 0, awaiting: 0, failed: 0, conversationIds: [] },
      },
    }),
    task("local-only", {
      listMetadata: {
        source: "code",
        host: "local-only",
        attention: { unread: 0, awaiting: 0, failed: 0, conversationIds: [] },
      },
    }),
  ];
  assert.deepEqual(offeredRoutineFilters(rows).sources, [
    "all",
    "chat",
    "code",
  ]);
  assert.deepEqual(offeredRoutineFilters(rows).hosts, [
    "all",
    "cloud",
    "this-computer",
    "another-computer",
    "local-only",
  ]);
  assert.deepEqual(
    offeredRoutineFilters([task("legacy")]).hosts,
    ["all"],
    "no guessed device for an unclassified legacy row",
  );
  assert.deepEqual(
    visibleRoutines(
      rows,
      "",
      { ...defaultRoutineFilter, source: "chat", status: "on-hold" },
      "name",
    ).map((t) => t.id),
    ["chat"],
  );
  assert.deepEqual(
    visibleRoutines(
      rows,
      "",
      { ...defaultRoutineFilter, runsOn: "another-computer" },
      "name",
    ).map((t) => t.id),
    ["another"],
  );
  assert.equal(
    visibleRoutines(
      rows,
      "",
      { ...defaultRoutineFilter, status: "active" },
      "name",
    ).some((t) => t.id === "chat"),
    false,
  );
  assert.deepEqual(
    routineAttention(
      rows[0],
      [{ id: "old", scheduledTaskId: "code", unread: true } as Conversation],
      [{ conversationId: "old" } as Approval],
    ),
    { unread: true, awaiting: true, failed: false },
  );
});

test("the final fixture domain implements real query/read results and follows task edits", async () => {
  const bridge = createFixtureDesktop({}, new URLSearchParams("routines=some"));
  const rows = await bridge.listSchedules();
  const listed = await bridge.querySchedules();
  assert.deepEqual(
    listed.tasks.map((task) => task.id),
    rows.map((task) => task.id),
  );
  assert.equal(listed.sources[0].status, "ready");
  const first = rows[0];
  assert.ok(first);
  const read = await bridge.readSchedule(first.id);
  assert.equal(read.status, "ready");
  await bridge.saveSchedule({ ...first, enabled: !first.enabled });
  const changed = await bridge.readSchedule(first.id);
  assert.equal(changed.status, "ready");
  if (changed.status === "ready")
    assert.equal(changed.task.enabled, !first.enabled);
  assert.deepEqual(await bridge.readSchedule("not-present"), {
    status: "missing",
  });
});

test("partial cloud/local failures preserve both successful data and same-account cached rows, including refusals", async () => {
  let localFail = false,
    remoteFail: unknown,
    remoteTasks = [task("remote")];
  const client = {
    call: async () => {
      if (remoteFail) throw remoteFail;
      return result(remoteTasks, "remote");
    },
  } as unknown as CloudCalls;
  const cloud = new CloudRoutines(() => client);
  const query = cloud.route("querySchedules", async () => {
    if (localFail) throw new Error("local unavailable");
    return result([task("local")]);
  })!;
  assert.deepEqual(
    (await query()).sources.map((s: any) => s.status),
    ["ready", "ready"],
  );
  remoteFail = new Error("cloud unavailable");
  let value = (await query()) as RoutineListResult;
  assert.deepEqual(
    value.tasks.map((t) => t.id),
    ["local", "remote"],
  );
  assert.deepEqual(
    value.sources.map((s) => s.status),
    ["ready", "error"],
  );
  localFail = true;
  remoteFail = undefined;
  remoteTasks = [task("new-remote")];
  value = await query();
  assert.deepEqual(
    value.tasks.map((t) => t.id),
    ["local", "new-remote"],
  );
  assert.deepEqual(
    value.sources.map((s) => s.status),
    ["error", "ready"],
  );
  remoteFail = Object.assign(new Error("forbidden"), {
    code: "CLAUDEX_WEB_NOT_ALLOWED",
  });
  value = await query();
  assert.deepEqual(
    value.sources.map((s) => s.status),
    ["error", "refused"],
  );
  assert.deepEqual(
    value.tasks.map((t) => t.id),
    ["local", "new-remote"],
  );
});

test("malformed cloud reads cannot disguise failure as an empty source", async () => {
  const cloud = new CloudRoutines(
    () => ({ call: async () => [] }) as unknown as CloudCalls,
  );
  const query = cloud.route("querySchedules", async () =>
    result([task("real-local")]),
  )!;
  const value = (await query()) as RoutineListResult;
  assert.deepEqual(
    value.tasks.map((t) => t.id),
    ["real-local"],
  );
  assert.deepEqual(
    value.sources.map((s) => s.status),
    ["ready", "error"],
  );
});

test("list generations and same-scope ordering prevent late reads from overwriting newer cache", async () => {
  const first = deferred<RoutineListResult>();
  let calls = 0,
    failing = false;
  const cloud = new CloudRoutines(() => undefined);
  const query = cloud.route("querySchedules", async () => {
    if (failing) throw new Error("offline");
    return ++calls === 1 ? first.promise : result([task("new")]);
  })!;
  const old = query();
  await Promise.resolve();
  await query();
  first.resolve(result([task("old")]));
  assert.equal(
    (await old).tasks[0].id,
    "old",
    "old caller gets its own successful data",
  );
  failing = true;
  assert.equal(
    (await query()).tasks[0].id,
    "new",
    "shared fallback cache keeps newer data",
  );
  const waiting = deferred<RoutineListResult>();
  const oldScope = cloud.route("querySchedules", () => waiting.promise)!();
  cloud.reset();
  const next = cloud.route("querySchedules", async () => result([task("B")]))!;
  await next();
  waiting.resolve(result([task("A")]));
  assert.deepEqual(
    (await oldScope).tasks,
    [],
    "retired caller never receives B's cache",
  );
  const failed = cloud.route("querySchedules", async () => {
    throw new Error("offline");
  })!;
  assert.deepEqual(
    (await failed()).tasks.map((t: Routine) => t.id),
    ["B"],
  );
});

test("independent remote detail resolves before list hydration and routes subsequent actions to its real backend", async () => {
  const calls: string[] = [];
  let remoteValue: RoutineDetailResult | Error = {
    status: "ready",
    task: task("remote-direct"),
  };
  const client = {
    call: async (name: string) => {
      calls.push(name);
      if (name === "readSchedule") {
        if (remoteValue instanceof Error) throw remoteValue;
        return remoteValue;
      }
      return "remote-action";
    },
  } as unknown as CloudCalls;
  const cloud = new CloudRoutines(() => client);
  const read = cloud.route("readSchedule", async () => ({
    status: "missing",
  }))!;
  assert.equal((await read("remote-direct")).task.executionLocation, "remote");
  assert.equal(
    await cloud.route("runSchedule", async () => "wrong-local")!(
      "remote-direct",
    ),
    "remote-action",
  );
  remoteValue = Object.assign(new Error("refused"), { status: 403 });
  assert.equal((await read("missing-local-refused-cloud")).status, "refused");
  remoteValue = new Error("network");
  assert.equal((await read("missing-local-offline-cloud")).status, "error");
  remoteValue = { status: "missing" };
  assert.deepEqual(await read("gone"), { status: "missing" });
  const before = calls.length;
  assert.deepEqual(await read("only-local", "local"), { status: "missing" });
  assert.equal(
    calls.length,
    before,
    "explicit provenance does not probe another backend",
  );
});

test("malformed new list API rejects while old bridges preserve genuine list failures", async () => {
  await assert.rejects(
    readRoutineList({ querySchedules: async () => undefined } as never, false),
    /load scheduled tasks/,
  );
  await assert.rejects(
    readRoutineList(
      {
        listSchedules: async () => {
          throw new Error("offline");
        },
      } as never,
      false,
    ),
    /offline/,
  );
  assert.deepEqual(
    await readRoutineList({ listSchedules: async () => [] } as never, true),
    result([], "remote"),
  );
});

test("real list hook handles StrictMode, coalesces retry, and retires old account/bridge callbacks", async () => {
  const pending = deferred<RoutineListResult>();
  let reads = 0;
  const env = await routineDom({
    querySchedules: () => {
      reads++;
      return pending.promise;
    },
  });
  let view!: ReturnType<typeof useRoutineQuery>;
  function Harness({ owner }: { owner: string }) {
    view = useRoutineQuery(true, owner, false);
    return null;
  }
  try {
    await env.render(h(StrictMode, null, h(Harness, { owner: "A" })));
    assert.equal(
      reads,
      2,
      "StrictMode's retired first read must not strand pending state",
    );
    const oldRefresh = view.refresh;
    await act(async () => {
      void view.refresh();
      void view.refresh();
    });
    assert.equal(reads, 2);
    const bridgeB = {
      ...env.window.desktop,
      querySchedules: async () => result([task("B")]),
    };
    env.window.desktop = bridgeB;
    await env.render(h(StrictMode, null, h(Harness, { owner: "B" })));
    assert.deepEqual(
      view.tasks.map((t) => t.id),
      ["B"],
    );
    await act(async () => {
      pending.resolve(result([task("A")]));
      await oldRefresh();
    });
    assert.deepEqual(
      view.tasks.map((t) => t.id),
      ["B"],
    );
    assert.equal(view.loading, false);
  } finally {
    await env.clean();
  }
});

test("approval/history events during an in-flight list read schedule one fresh follow-up", async () => {
  const pending = deferred<RoutineListResult>();
  let reads = 0,
    emit!: Parameters<Window["desktop"]["onEvent"]>[0];
  const env = await routineDom({
    querySchedules: () =>
      ++reads === 1
        ? pending.promise
        : Promise.resolve(result([task("fresh")])),
    onEvent: (callback) => {
      emit = callback;
      return () => {};
    },
  });
  let view!: ReturnType<typeof useRoutineQuery>;
  function Harness() {
    view = useRoutineQuery(true, "owner", false);
    return null;
  }
  try {
    await env.render(h(Harness));
    await act(async () => {
      emit({ type: "approval-resolved", id: "x" });
      emit({ type: "schedules", schedules: [] });
    });
    assert.equal(reads, 1);
    await act(async () => pending.resolve(result([task("old")])));
    assert.equal(reads, 2);
    assert.deepEqual(
      view.tasks.map((t) => t.id),
      ["fresh"],
    );
  } finally {
    await env.clean();
  }
});

for (const status of ["missing", "refused", "error"] as const) {
  test(`actual direct route keeps ${status} distinct from the still-pending list and offers Back/retry appropriately`, async () => {
    let reads = 0;
    const env = await routineDom({
      querySchedules: () => new Promise(() => {}),
      readSchedule: async () => {
        reads++;
        return { status };
      },
    });
    const navigations: unknown[] = [];
    try {
      await env.render(
        h(
          HostContext.Provider,
          { value: desktopHost },
          h(RoutinesPage, {
            settings: defaultSettings,
            detailId: "direct",
            onDetailChange: (value) => navigations.push(value),
            onOpenConversation() {},
            onChooseFolder: async () => null,
            onConfirmDelete() {},
            onError(error) {
              throw error;
            },
          }),
        ),
      );
      assert.equal(navigations.length, 0);
      assert.equal(reads, 1);
      assert.equal(
        env.document.querySelector(".routines-title"),
        null,
        "never silently returns to the list",
      );
      const buttons = [
        ...env.document.querySelectorAll(".routines-load-error button"),
      ];
      assert.deepEqual(
        buttons.map((b) => b.textContent),
        status === "missing" ? ["Back"] : ["Retry", "Back"],
      );
      if (status !== "missing") {
        await env.event(buttons[0], "click");
        assert.equal(reads, 2);
      }
      const back = [
        ...env.document.querySelectorAll(".routines-load-error button"),
      ].find((button) => button.textContent === "Back")!;
      await env.event(back, "click");
      assert.deepEqual(navigations, [undefined]);
    } finally {
      await env.clean();
    }
  });
}

test("detail hook ignores an old ID result and explicitly retries a network failure", async () => {
  const old = deferred<RoutineDetailResult>();
  let retry = false;
  const env = await routineDom({
    readSchedule: async (id) =>
      id === "A"
        ? old.promise
        : retry
          ? { status: "ready", task: task("B") }
          : { status: "error" },
  });
  let view!: ReturnType<typeof useRoutineDetail>;
  function Harness({ id }: { id: string }) {
    view = useRoutineDetail(id, "owner");
    return null;
  }
  try {
    await env.render(h(Harness, { id: "A" }));
    await env.render(h(Harness, { id: "B" }));
    assert.equal(view.status, "error");
    await act(async () => old.resolve({ status: "ready", task: task("A") }));
    assert.equal(view.status, "error");
    retry = true;
    await act(async () => view.refresh());
    const currentView = () => view;
    assert.equal(currentView().status, "ready");
    const ready = currentView();
    if (ready.status === "ready") assert.equal(ready.task.id, "B");
  } finally {
    await env.clean();
  }
});

test("actual list retains cards and source-specific retry status while the failed source reloads", async () => {
  const pending = deferred<RoutineListResult>();
  let reads = 0;
  const env = await routineDom({
    querySchedules: () =>
      ++reads === 1
        ? Promise.resolve({
            tasks: [
              task("surviving-card", {
                lastRunStatus: "completed",
                listMetadata: {
                  source: "code",
                  host: "this-computer",
                  attention: {
                    unread: 1,
                    awaiting: 1,
                    failed: 1,
                    conversationIds: ["older-run-chat"],
                  },
                },
              }),
            ],
            sources: [
              { source: "local", status: "ready" },
              { source: "remote", status: "error" },
            ],
          })
        : pending.promise,
  });
  try {
    await env.render(
      h(RoutinesPage, {
        settings: defaultSettings,
        onOpenConversation() {},
        onChooseFolder: async () => null,
        onConfirmDelete() {},
        onError(error) {
          throw error;
        },
      }),
    );
    assert.match(env.document.body.textContent!, /surviving-card/);
    assert.equal(
      env.document
        .querySelector(".routine-status-dot")
        ?.getAttribute("data-dot"),
      "failed",
      "an older failed run remains visible after the latest run completed",
    );
    assert.match(
      env.document.body.textContent!,
      /Couldn’t load cloud scheduled tasks/,
    );
    const retry = [
      ...env.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent === "Retry")!;
    await env.event(retry, "click");
    assert.equal(retry.disabled, true);
    assert.equal(retry.textContent, "Retrying…");
    assert.equal(reads, 2);
    assert.match(env.document.body.textContent!, /surviving-card/);
    assert.doesNotMatch(
      env.document.body.textContent!,
      /No scheduled tasks yet/,
    );
    await act(async () =>
      pending.resolve(result([task("surviving-card"), task("cloud-card")])),
    );
    assert.match(env.document.body.textContent!, /cloud-card/);
    assert.doesNotMatch(
      env.document.body.textContent!,
      /Couldn’t load cloud scheduled tasks/,
    );
  } finally {
    await env.clean();
  }
});

test("a loaded detail stays mounted during a genuine background metadata refresh", async () => {
  const pending = deferred<RoutineDetailResult>();
  let reads = 0;
  const env = await routineDom({
    readSchedule: () =>
      ++reads === 1
        ? Promise.resolve({ status: "ready", task: task("stable") })
        : pending.promise,
  });
  let view!: ReturnType<typeof useRoutineDetail>;
  function Harness() {
    view = useRoutineDetail("stable", "owner");
    return null;
  }
  try {
    await env.render(h(Harness));
    assert.equal(view.status, "ready");
    await act(async () => {
      void view.refresh();
    });
    assert.equal(
      view.status,
      "ready",
      "saving does not introduce a whole-page skeleton frame",
    );
    await act(async () =>
      pending.resolve({
        status: "ready",
        task: task("stable", { name: "Fresh name" }),
      }),
    );
    if (view.status === "ready") assert.equal(view.task.name, "Fresh name");
  } finally {
    await env.clean();
  }
});
