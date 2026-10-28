import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { Routine } from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";
import { webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { AutoDisabledRoutineNotice } from "../../src/collections/routines/AutoDisabledRoutineNotice";
import { RoutineHistory } from "../../src/collections/routines/RoutineHistory";
import { RoutineDetailResources } from "../../src/collections/routines/RoutineDetailResources";
import {
  clearProjectRequest,
  projectRequest,
} from "../../src/collections/open-requests";
import { routineDom } from "../support/routine-dom";

const task: Routine = {
  id: "same-task",
  name: "Actual task",
  prompt: "Actual instructions",
  mode: "code",
  providerId: "p",
  model: "selected-model",
  enabled: true,
  frequency: "daily",
  nextRunAt: 100,
  createdAt: 1,
  updatedAt: 1,
  executionLocation: "local",
};
const run: RoutineRun = {
  id: "run",
  startedAt: 100,
  status: "completed",
  trigger: "manual",
  conversationId: "private-conversation",
  readAt: 101,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
function controller(accountId = "a") {
  const app = {
    accountId,
    controllerScope: {},
    page: "scheduled",
    snapshot: { projects: [] },
    setPage() {},
    currentController: { current: undefined },
  } as unknown as AppController;
  app.currentController!.current = app;
  return app;
}
const wrap = (child: ReturnType<typeof h>, app: AppController) =>
  h(
    HostContext.Provider,
    { value: webHost },
    h(AppContext.Provider, { value: app }, child),
  );
function retainedClick(node: Element) {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps$"),
  )!;
  return (
    node as unknown as Record<string, { onClick: (event?: unknown) => void }>
  )[key].onClick;
}

for (const replacement of ["account", "bridge", "backend"] as const) {
  test(`23: ${replacement} replacement reloads a same-ID history and rejects the previous pending result`, async () => {
    const old = deferred<RoutineRun[]>(),
      next = deferred<RoutineRun[]>();
    let reads = 0;
    const env = await routineDom({
      routineRuns: () => (++reads === 1 ? old.promise : next.promise),
    });
    const app = controller();
    const view = (owner = app, routine = task) =>
      wrap(h(RoutineHistory, { routine, onOpenConversation() {} }), owner);
    try {
      await env.render(view());
      const nextApp = replacement === "account" ? controller("b") : app;
      if (replacement === "bridge")
        env.window.desktop = { ...env.window.desktop };
      await env.render(
        view(
          nextApp,
          replacement === "backend"
            ? { ...task, executionLocation: "remote" }
            : task,
        ),
      );
      assert.equal(reads, 2);
      await act(async () => old.resolve([run]));
      assert.equal(env.document.querySelector(".routine-history-row"), null);
      assert.ok(env.document.querySelector(".routine-history-loading"));
      await act(async () => next.resolve([]));
      assert.equal(
        env.document.querySelector(".routine-history-empty p")!.textContent,
        "No runs yet",
      );
    } finally {
      await env.clean();
    }
  });
}

test("23: retained Run now and run navigation cannot borrow the replacement account or bridge", async () => {
  const calls: string[] = [];
  const env = await routineDom();
  const app = controller();
  const view = () =>
    wrap(
      h(RoutineHistory, {
        routine: task,
        onOpenConversation: () => calls.push("open"),
        emptyRunAction: {
          onRun: () => calls.push("run"),
          disabled: false,
          running: false,
        },
      }),
      app,
    );
  try {
    await env.render(view());
    const oldRun = retainedClick(
      env.document.querySelector(".routine-history-run")!,
    );
    app.currentController!.current = controller("b");
    await act(async () => oldRun());
    assert.deepEqual(calls, []);
    app.currentController!.current = app;
    await env.click(".routine-history-run");
    assert.deepEqual(calls, ["run"]);
    env.window.desktop = {
      ...env.window.desktop,
      routineRuns: async () => [run],
    };
    await env.render(view());
    const oldOpen = retainedClick(
      env.document.querySelector(".routine-history-row")!,
    );
    env.window.desktop = { ...env.window.desktop };
    await act(async () => oldOpen({ preventDefault() {}, button: 0 }));
    assert.deepEqual(calls, ["run"]);
  } finally {
    await env.clean();
  }
});

test("14: a retained project link cannot navigate after account authority changes", async () => {
  const env = await routineDom();
  const app = controller();
  app.snapshot.projects = [
    {
      id: "private-project",
      name: "Private project",
      description: "",
      instructions: "",
      createdAt: 1,
    },
  ];
  const pages: string[] = [];
  app.setPage = (page) => {
    if (typeof page === "string") pages.push(page);
  };
  clearProjectRequest();
  try {
    await env.render(
      wrap(
        h(RoutineDetailResources, {
          routine: { ...task, projectId: "private-project" },
          disabled: false,
        }),
        app,
      ),
    );
    const open = retainedClick(
      env.document.querySelector(".routine-detail-project a")!,
    );
    app.currentController!.current = controller("b");
    await act(async () => open({ preventDefault() {}, button: 0 }));
    assert.deepEqual(pages, []);
    assert.equal(projectRequest(), undefined);
  } finally {
    clearProjectRequest();
    await env.clean();
  }
});

test("23: Code history filters loaded rows, keeps older-history loading available, and clears real no-results without offering Run now", async () => {
  const height = Object.getOwnPropertyDescriptor(globalThis, "innerHeight");
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 900,
  });
  const env = await routineDom(
    {
      routineRunsPage: async (_id, query) =>
        query?.cursor
          ? { runs: [{ ...run, id: "older", trigger: "schedule" }] }
          : { runs: [run], nextCursor: "older-page" },
    },
    { jsdom: true },
  );
  const app = controller();
  try {
    await env.render(
      wrap(
        h(RoutineHistory, {
          routine: task,
          onOpenConversation() {},
          emptyRunAction: {
            onRun() {
              throw new Error("must not run");
            },
            disabled: false,
            running: false,
          },
        }),
        app,
      ),
    );
    await env.click('[aria-label="Filter runs"]');
    const trigger = [
      ...env.document.querySelectorAll('[role="menuitem"]'),
    ].find((node) => node.textContent?.includes("Trigger"))!;
    await env.event(trigger, "click");
    const scheduled = [
      ...env.document.querySelectorAll('[role="menuitemradio"]'),
    ].find((node) => node.textContent?.includes("Scheduled"))!;
    await env.event(scheduled, "click");
    assert.match(
      env.document.querySelector(".routine-history-no-results")!.textContent!,
      /No loaded runs match/,
    );
    assert.equal(env.document.querySelector(".routine-history-empty"), null);
    assert.equal(env.document.querySelector(".routine-history-run"), null);
    await env.click(".routine-history-more");
    assert.equal(
      env.document.querySelectorAll(".routine-history-row").length,
      1,
    );
    assert.equal(
      env.document.querySelector(".routine-history-no-results"),
      null,
    );
    await env.click('[aria-label="Filter runs"]');
    const status = [...env.document.querySelectorAll('[role="menuitem"]')].find(
      (node) => node.textContent?.includes("Status"),
    )!;
    await env.event(status, "click");
    const failed = [
      ...env.document.querySelectorAll('[role="menuitemradio"]'),
    ].find((node) => node.textContent?.includes("Failed"))!;
    await env.event(failed, "click");
    await env.click(".routine-history-no-results button");
    assert.equal(
      env.document.querySelectorAll(".routine-history-row").length,
      2,
    );
    assert.equal(
      env.document
        .querySelector('[aria-label="Filter runs"]')!
        .getAttribute("aria-pressed"),
      "false",
    );
    await env.render(
      wrap(
        h(RoutineHistory, {
          routine: { ...task, mode: "cowork" },
          onOpenConversation() {},
        }),
        app,
      ),
    );
    assert.equal(
      env.document.querySelector('[aria-label="Filter runs"]'),
      null,
    );
  } finally {
    await env.clean();
    if (height) Object.defineProperty(globalThis, "innerHeight", height);
    else Reflect.deleteProperty(globalThis, "innerHeight");
  }
});

test("17: auto-disabled one-time tasks whose scheduled time passed recover by editing; a future task can still re-enable", async () => {
  const env = await routineDom();
  const app = controller();
  const calls: string[] = [];
  const view = (at: number) =>
    wrap(
      h(AutoDisabledRoutineNotice, {
        routine: {
          ...task,
          enabled: false,
          cwd: "/owned/workspace",
          endedReason: "auto_disabled_repo_access",
          repeat: { kind: "once", at },
        },
        disabled: false,
        onEdit: () => calls.push("edit"),
        onRecover: async () => {
          calls.push("recover");
        },
      }),
      app,
    );
  try {
    await env.render(view(Date.now() - 60_000));
    assert.match(env.document.body.textContent!, /workspace folder is missing/);
    assert.match(
      env.document.body.textContent!,
      /Edit the schedule to turn this scheduled task back on/,
    );
    assert.equal(
      env.document.querySelectorAll(".routine-auto-disabled button").length,
      1,
    );
    await env.click(".routine-auto-disabled button");
    assert.deepEqual(calls, ["edit"]);
    await env.render(view(Date.now() + 60_000));
    assert.equal(
      env.document.querySelectorAll(".routine-auto-disabled button").length,
      2,
    );
    await env.click(".routine-auto-disabled button:last-child");
    assert.deepEqual(calls, ["edit", "recover"]);
  } finally {
    await env.clean();
  }
});

test("23: a run callback retained before permission/busy changes cannot bypass the current refusal", async () => {
  const env = await routineDom();
  const app = controller();
  let calls = 0;
  const view = (disabled: boolean, running: boolean) =>
    wrap(
      h(RoutineHistory, {
        routine: task,
        onOpenConversation() {},
        emptyRunAction: {
          onRun: () => calls++,
          disabled,
          running,
          reason: disabled ? "Actual permission refused" : undefined,
        },
      }),
      app,
    );
  try {
    await env.render(view(false, false));
    const eligible = retainedClick(
      env.document.querySelector(".routine-history-run")!,
    );
    for (const [disabled, running] of [
      [true, false],
      [false, true],
    ]) {
      await env.render(view(disabled, running));
      const button = env.document.querySelector<HTMLButtonElement>(
        ".routine-history-run",
      )!;
      assert.equal(button.disabled, true);
      if (running) assert.equal(button.getAttribute("aria-busy"), "true");
      if (disabled) assert.equal(button.title, "Actual permission refused");
      await act(async () => eligible());
      assert.equal(calls, 0);
    }
  } finally {
    await env.clean();
  }
});

test("23: an actual history permission refusal never becomes a no-runs card or run action", async () => {
  const env = await routineDom({
    routineRuns: async () => {
      throw Object.assign(new Error("Permission denied for these runs"), {
        code: "FORBIDDEN",
      });
    },
  });
  try {
    await env.render(
      wrap(
        h(RoutineHistory, {
          routine: task,
          onOpenConversation() {},
          emptyRunAction: {
            onRun() {
              throw new Error("must not run");
            },
            disabled: false,
            running: false,
          },
        }),
        controller(),
      ),
    );
    assert.match(
      env.document.querySelector('[role="alert"]')!.textContent!,
      /Permission denied for these runs/,
    );
    assert.equal(env.document.querySelector(".routine-history-empty"), null);
    assert.equal(env.document.querySelector(".routine-history-run"), null);
  } finally {
    await env.clean();
  }
});
