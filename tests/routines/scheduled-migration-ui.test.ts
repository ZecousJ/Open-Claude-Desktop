import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement as h } from "react";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { RoutineMigration } from "../../src/collections/routines/RoutineMigration";
import { takeScheduleRequest } from "../../src/collections/routines/schedule-request";
import { desktopHost, webHost } from "../../shared/host";
import { openPolicy } from "../../shared/client-policy";
import type { Routine, RoutineCapabilities } from "../../shared/routines";
import type {
  RoutineMigrationEligibility,
  RoutineMigrationRequest,
  RoutineMigrationResult,
} from "../../shared/routine-migration";
import { atomicChatDom } from "../support/atomic-chat-dom";

const task = (
  id = "local-task",
  location: "local" | "remote" = "local",
): Routine => ({
  id,
  name: "Task “safe” <name>",
  prompt: "Instructions",
  mode: "cowork",
  executionLocation: location,
  enabled: true,
  providerId: "p",
  model: "m",
  frequency: "daily",
  nextRunAt: Date.now() + 86_400_000,
  createdAt: 1,
  updatedAt: 1,
});
const capabilities: RoutineCapabilities = {
  remote: true,
  email: false,
  slack: false,
  ...{
    migration: {
      originLock: true,
      import: true,
      deleteHistory: true,
      models: [{ providerId: "p", model: "m" }],
      timeZone: "Asia/Shanghai",
    },
  },
};
const eligible = (
  source: "local" | "remote" = "local",
): RoutineMigrationEligibility => ({
  source,
  toCloud: {
    ok: source === "local",
    reasons: source === "local" ? [] : ["unavailable"],
  },
  toLocal: {
    ok: source === "remote",
    reasons: source === "remote" ? [] : ["not_origin"],
  },
});
const result = (
  direction: RoutineMigrationRequest["direction"] = "to-cloud",
): RoutineMigrationResult => ({
  task: task(
    direction === "to-cloud" ? "canonical-cloud" : "canonical-local",
    direction === "to-cloud" ? "remote" : "local",
  ),
  fromId: "local-task",
  toId: direction === "to-cloud" ? "canonical-cloud" : "canonical-local",
  history: direction === "to-cloud" ? "local-retained" : "cloud-deleted",
});

test("a real rendered move rejects an otherwise valid result belonging to a different task", async () => {
  const env = await setup({
    move: async () => ({ ...result(), fromId: "another-task" }),
  });
  try {
    await env.render();
    await env.open();
    await env.click('[role="alertdialog"] .button-row > button:last-child');
    await env.settle();
    assert.equal(takeScheduleRequest(), undefined);
    assert.deepEqual(env.pages, []);
    assert.ok(
      env.document.querySelector('[role="alertdialog"] [role="alert"]'),
    );
  } finally {
    takeScheduleRequest();
    await env.clean();
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(
  options: {
    source?: "local" | "remote";
    read?: () => Promise<RoutineMigrationEligibility>;
    move?: (input: RoutineMigrationRequest) => Promise<RoutineMigrationResult>;
    caps?: () => Promise<RoutineCapabilities>;
  } = {},
) {
  const reads: string[] = [],
    moves: RoutineMigrationRequest[] = [],
    capsReads: string[] = [],
    pages: string[] = [];
  const bridge = {
    routineCapabilities: async (source?: string) => {
      capsReads.push(source ?? "default");
      return options.caps ? options.caps() : capabilities;
    },
    routineMigration: async (id: string) => {
      reads.push(id);
      return options.read ? options.read() : eligible(options.source);
    },
    migrateRoutine: async (input: RoutineMigrationRequest) => {
      moves.push(input);
      return options.move ? options.move(input) : result(input.direction);
    },
  };
  const env = await atomicChatDom(bridge as never);
  const app = {
    accountId: "A",
    page: "scheduled",
    controllerScope: {},
    currentController: { current: undefined },
    host: desktopHost,
    policy: openPolicy,
    windowRole: { kind: "main" },
    setPage: (page: string) => {
      pages.push(page);
      app.page = page;
    },
  } as unknown as AppController;
  let routine = task(
    options.source === "remote" ? "cloud-task" : "local-task",
    options.source,
  );
  const render = async (
    patch: Partial<Parameters<typeof RoutineMigration>[0]> = {},
  ) => {
    if (patch.routine) routine = patch.routine;
    app.currentController!.current = app;
    await env.render(
      h(
        HostContext.Provider,
        { value: app.host! },
        h(
          AppContext.Provider,
          { value: app },
          h(RoutineMigration, { routine, ...patch }),
        ),
      ),
    );
  };
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const found = env.document.querySelector<T>(selector);
    assert.ok(found, selector);
    return found;
  };
  const until = async (selector: string) => {
    for (
      let count = 0;
      count < 30 && !env.document.querySelector(selector);
      count++
    )
      await env.settle();
    return query(selector);
  };
  const click = async (selector: string) => {
    await act(async () => query<HTMLElement>(selector).click());
  };
  const open = async () => {
    await until(".routine-migration-row > button");
    await click(".routine-migration-row > button");
    await until('[role="alertdialog"] .routine-migration-confirm');
  };
  return {
    ...env,
    app,
    render,
    query,
    until,
    click,
    open,
    reads,
    moves,
    capsReads,
    pages,
    bridge,
  };
}

test("migration leaf probes genuine capability only on supported desktop and never queries unadvertised migration", async () => {
  const env = await setup({
    caps: async () => ({ remote: true, email: false, slack: false }),
  });
  try {
    env.app.host = webHost;
    await env.render();
    assert.deepEqual(env.capsReads, []);
    assert.deepEqual(env.reads, []);
    assert.equal(env.document.querySelector(".routine-migration"), null);
    env.app.host = desktopHost;
    await env.render();
    await env.settle();
    assert.deepEqual(env.capsReads, ["local"]);
    assert.deepEqual(env.reads, []);
    assert.equal(env.document.querySelector(".routine-migration"), null);
    Reflect.deleteProperty(
      (env.window as unknown as Window).desktop,
      "migrateRoutine",
    );
    await env.render({ routine: task("other") });
    assert.equal(env.capsReads.length, 1);
  } finally {
    await env.clean();
  }
});

test("forward confirmation cancels without mutation, then opens the canonical new detail after actual API result", async () => {
  const env = await setup();
  takeScheduleRequest();
  try {
    await env.render({ capabilities });
    await env.open();
    assert.deepEqual(
      env.capsReads,
      [],
      "provided actual capability avoids another read",
    );
    assert.match(
      env.query('[role="alertdialog"]').textContent!,
      /The local copy will be paused/,
    );
    assert.match(
      env.query('[role="alertdialog"]').textContent!,
      /<name>/,
      "task names remain literal text",
    );
    await env.click('[role="alertdialog"] .button-row > button:first-child');
    assert.deepEqual(env.moves, []);
    await env.open();
    await env.click('[role="alertdialog"] .button-row > button:last-child');
    assert.deepEqual(env.moves, [{ id: "local-task", direction: "to-cloud" }]);
    assert.deepEqual(takeScheduleRequest(), {
      description: "",
      openRoutineId: "canonical-cloud",
    });
    assert.deepEqual(env.pages, ["scheduled"]);
  } finally {
    takeScheduleRequest();
    await env.clean();
  }
});

test("move-back uses the source deletion warning and busy move blocks cancel, Escape, backdrop and double submission", async () => {
  const pending = deferred<RoutineMigrationResult>();
  const env = await setup({ source: "remote", move: () => pending.promise });
  try {
    await env.render();
    await env.open();
    const dialog = env.query('[role="alertdialog"]');
    assert.match(
      dialog.textContent!,
      /The cloud version will be deleted, along with its run history and any changes made to it except the instructions\./,
    );
    assert.match(dialog.textContent!, /Keep in cloud/);
    await env.click('[role="alertdialog"] .button-row > button:last-child');
    assert.equal(
      env.query<HTMLButtonElement>(
        '[role="alertdialog"] .button-row > button:first-child',
      ).disabled,
      true,
    );
    await env.key(dialog, "Escape");
    await act(async () =>
      env
        .query(".overlay")
        .dispatchEvent(
          new env.window.MouseEvent("mousedown", { bubbles: true }),
        ),
    );
    await env.click('[role="alertdialog"] .button-row > button:last-child');
    assert.equal(env.moves.length, 1);
    assert.ok(env.document.querySelector('[role="alertdialog"]'));
    await act(async () => pending.resolve(result("to-local")));
  } finally {
    takeScheduleRequest();
    await env.clean();
  }
});

test("failed move stays in confirmation, rereads persisted pending state, and Retry reuses the same task API request", async () => {
  let count = 0,
    pending = false;
  const env = await setup({
    read: async () => ({ ...eligible(), pending }),
    move: async () => {
      count++;
      if (count === 1) {
        pending = true;
        throw new Error("Connection lost after import");
      }
      return result();
    },
  });
  try {
    await env.render();
    await env.open();
    await env.click('[role="alertdialog"] .button-row > button:last-child');
    await env.settle();
    assert.ok(
      env.document.querySelector('[role="alertdialog"] [role="alert"]'),
    );
    assert.match(
      env.query(".routine-migration-row").textContent!,
      /previous move is unfinished/,
    );
    assert.equal(
      env.query<HTMLButtonElement>(
        '[role="alertdialog"] .button-row > button:last-child',
      ).textContent,
      "Retry move",
    );
    await env.click('[role="alertdialog"] .button-row > button:last-child');
    assert.equal(env.moves.length, 2);
    assert.deepEqual(env.moves[0], env.moves[1]);
  } finally {
    takeScheduleRequest();
    await env.clean();
  }
});

test("read failure has real Retry and backend refusal disables mutation with its reason", async () => {
  let count = 0;
  const env = await setup({
    read: async () => {
      if (++count === 1) throw new Error("Offline");
      return { ...eligible(), toCloud: { ok: false, reasons: ["timezone"] } };
    },
  });
  try {
    await env.render();
    await env.until('.routine-migration > [role="alert"] button');
    await env.click('.routine-migration > [role="alert"] button');
    await env.until(".routine-migration-row > button");
    assert.equal(
      env.query<HTMLButtonElement>(".routine-migration-row > button").disabled,
      true,
    );
    assert.match(env.document.body.textContent!, /different time zones/);
    await env.click(".routine-migration-row > button");
    assert.deepEqual(env.moves, []);
  } finally {
    await env.clean();
  }
});

test("late mutation results retire on account, bridge, controller, task and route replacement", async () => {
  for (const replacement of [
    "account",
    "bridge",
    "controller",
    "task",
    "route",
  ] as const) {
    const pending = deferred<RoutineMigrationResult>();
    const env = await setup({ move: () => pending.promise });
    takeScheduleRequest();
    try {
      await env.render();
      await env.open();
      await env.click('[role="alertdialog"] .button-row > button:last-child');
      if (replacement === "account") env.app.accountId = "B";
      if (replacement === "bridge")
        (env.window as unknown as Window).desktop = { ...env.bridge } as never;
      if (replacement === "controller") env.app.controllerScope = {};
      if (replacement === "route") env.app.page = "chat";
      await env.render(
        replacement === "task" ? { routine: task("replacement-task") } : {},
      );
      await act(async () => pending.resolve(result()));
      assert.equal(takeScheduleRequest(), undefined, replacement);
      assert.deepEqual(env.pages, [], replacement);
      assert.equal(
        env.document.querySelector('[role="alertdialog"]'),
        null,
        replacement,
      );
    } finally {
      takeScheduleRequest();
      await env.clean();
    }
  }
});

test("late eligibility cannot enable the replacement task and ordinary cloud tasks have no move-back control", async () => {
  const previous = deferred<RoutineMigrationEligibility>();
  let first = true;
  const env = await setup({
    read: () =>
      first
        ? ((first = false), previous.promise)
        : Promise.resolve({
            ...eligible(),
            toCloud: { ok: false, reasons: ["local_folders"] },
          }),
  });
  try {
    await env.render();
    await env.render({ routine: task("new-task") });
    await act(async () => previous.resolve(eligible()));
    await env.until(".routine-migration-row > button");
    assert.equal(
      env.query<HTMLButtonElement>(".routine-migration-row > button").disabled,
      true,
    );
    assert.match(env.document.body.textContent!, /local folders or files/);
  } finally {
    await env.clean();
  }
  const cloud = await setup({
    source: "remote",
    read: async () => ({
      ...eligible("remote"),
      toLocal: { ok: false, reasons: ["not_origin"] },
    }),
  });
  try {
    await cloud.render();
    await cloud.settle();
    assert.equal(cloud.document.querySelector(".routine-migration"), null);
  } finally {
    await cloud.clean();
  }
});

test("a fresh mounted leaf recovers the persisted move-back state without claiming the deleted cloud copy still runs", async () => {
  const env = await setup({
    read: async () => ({
      source: "local",
      pending: true,
      toCloud: { ok: false, reasons: ["unavailable"] },
      toLocal: { ok: true, reasons: [] },
    }),
  });
  try {
    await env.render();
    await env.open();
    assert.equal(env.query(".routine-migration h3").textContent, "Retry move");
    assert.match(
      env.query('[role="alertdialog"]').textContent!,
      /Move back to this computer/,
    );
    await env.click('[role="alertdialog"] .button-row > button:last-child');
    assert.deepEqual(env.moves, [{ id: "local-task", direction: "to-local" }]);
  } finally {
    takeScheduleRequest();
    await env.clean();
  }
});
