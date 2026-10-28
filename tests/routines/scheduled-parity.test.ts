import type { ComponentType } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Scheduler } from "../../electron/routines/scheduler";
import { defaultSettings, Store } from "../../electron/store/store";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import { groupedScheduleNotices } from "../../electron/engine/attention-rules";
import type { AppContext } from "../../electron/app/app-context";
import type { Conversation } from "../../shared/types";
import {
  nextRun,
  routineModelUnavailable,
  routineRunModel,
  unavailableRoutineModel,
  validRepeat,
  type Routine,
  type RoutineInput,
} from "../../shared/routines";
import { repeatLabel } from "../../shared/routine-labels";
import { proposeSchedule } from "../../shared/routine-proposals";
import {
  draftInput,
  draftRule,
  editDraft,
  newDraft,
} from "../../src/collections/routines/routine-draft";
import { RoutineEditor } from "../../src/collections/routines/RoutineEditor";
import { ScheduledTaskDialog } from "../../src/collections/routines/ScheduledTaskDialog";

const now = new Date(2026, 0, 31, 10).getTime();
const input: RoutineInput = {
  name: "Monthly review",
  description: "Review progress",
  prompt: "Review the month",
  mode: "code",
  providerId: "p",
  model: "old",
  frequency: "daily",
  nextRunAt: now,
  enabled: true,
  repeat: { kind: "monthly", time: "09:00", dayOfMonth: 31 },
};
const task: Routine = { ...input, id: "task", createdAt: now, updatedAt: now };
const settings = {
  ...defaultSettings,
  providers: [
    {
      id: "p",
      name: "Models",
      model: "new",
      models: ["new", "other"],
      baseUrl: "",
      protocol: "responses" as const,
    },
  ],
  activeProviderId: "p",
};

function fixture(context: any) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-scheduled-parity-"),
  );
  const store = new Store(root);
  const dispatched: Routine[] = [];
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    now: () => now,
    run: async (routine) => {
      dispatched.push(routine);
      return { id: "run", turns: [] } as unknown as Conversation;
    },
  });
  context.after(() => {
    scheduler.stop();
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, scheduler, dispatched };
}

test("monthly schedules skip missing days, include leap days, and use a strictly future local slot", () => {
  const monthly = validRepeat(input.repeat);
  assert.equal(nextRun(monthly, now), new Date(2026, 2, 31, 9).getTime());
  assert.equal(
    nextRun(monthly, new Date(2026, 11, 31, 9).getTime()),
    new Date(2027, 0, 31, 9).getTime(),
  );
  assert.equal(
    nextRun(
      { kind: "monthly", time: "09:00", dayOfMonth: 29 },
      new Date(2028, 0, 30).getTime(),
    ),
    new Date(2028, 1, 29, 9).getTime(),
  );
  for (const dayOfMonth of [0, 32, 1.5, "1"])
    assert.throws(
      () => validRepeat({ kind: "monthly", time: "09:00", dayOfMonth }),
      /Choose a valid day/,
    );
  assert.equal(repeatLabel(monthly), "At 09:00 AM, on day 31 of the month");
  assert.deepEqual(
    proposeSchedule("Review monthly on the 31st at 9am", now).repeat,
    input.repeat,
  );
});

test("monthly schedules persist and dispatch with manual approval by default", async (context) => {
  const { scheduler, root, dispatched } = fixture(context);
  const saved = scheduler.save(input);
  assert.equal(saved.permission, "default");
  assert.equal(saved.nextRunAt, new Date(2026, 2, 31, 9).getTime());
  const reloaded = new Scheduler(root, {
    isBusy: () => false,
    run: async () => ({}) as Conversation,
  });
  assert.deepEqual(reloaded.list()[0].repeat, input.repeat);
  await scheduler.runNow(saved.id);
  assert.equal(dispatched[0].permission, "default");
  assert.deepEqual(dispatched[0].repeat, input.repeat);
  const explicit = scheduler.save({
    ...input,
    name: "Explicit skip",
    permission: "bypass",
  });
  assert.equal(explicit.permission, "bypass");
});

test("both editors offer monthly dates and explain unavailable models", () => {
  const draft = editDraft(task, input.repeat!);
  assert.deepEqual(draftRule(draft), input.repeat);
  const editors: ComponentType<Parameters<typeof RoutineEditor>[0]>[] = [
    RoutineEditor,
    ScheduledTaskDialog,
  ];
  for (const component of editors) {
    const html = renderToStaticMarkup(
      createElement(component, {
        draft,
        settings,
        onChange() {},
        onCancel() {},
        onSave: async () => {},
        onChooseFolder: async () => null,
      }),
    );
    assert.match(html, /Monthly/);
    assert.match(html, /starts on/);
    assert.match(html, /type="date"/);
    assert.ok(
      html.includes(
        component === RoutineEditor
          ? unavailableRoutineModel.local
          : unavailableRoutineModel.remote,
      ),
    );
  }
  const fresh = newDraft(now);
  assert.equal(fresh.permission, "auto");
  const saved = draftInput(draft, settings, now);
  assert.equal(saved.defaultModel, true);
  assert.equal(saved.model, "new");
});

test("local stale models fall back without rewriting the saved choice; remote tasks require a new model", () => {
  assert.equal(routineModelUnavailable(task, settings.providers), true);
  assert.equal(routineRunModel(task, settings, "local").model, "new");
  assert.equal(task.model, "old");
  assert.throws(() => routineRunModel(task, settings, "remote"), {
    message: unavailableRoutineModel.remote,
  });
  const selected = { ...task, model: "other" };
  assert.equal(routineModelUnavailable(selected, settings.providers), false);
  assert.equal(routineRunModel(selected, settings, "remote").model, "other");
  assert.equal(
    routineRunModel({ ...task, defaultModel: true }, settings, "remote").model,
    "new",
  );
  assert.equal(
    routineRunModel({ ...task, providerId: "removed" }, settings, "local")
      .providerId,
    "p",
  );
});

test("attention grouping starts above two runs and has an empty body and scheduled-tasks target", () => {
  const notices = [1, 2, 3].map((count) => ({
    title: "Scheduled task failed",
    body: `Task ${count}`,
    conversationId: `run-${count}`,
  }));
  assert.deepEqual(
    groupedScheduleNotices(notices.slice(0, 2)),
    notices.slice(0, 2),
  );
  assert.deepEqual(groupedScheduleNotices(notices), [
    {
      title: "3 scheduled tasks need your attention",
      body: "",
      tag: "scheduled-cloud-runs",
      scheduledTasks: true,
    },
  ]);
});

test("deleting a scheduled task archives inactive runs outside retained history and preserves active Code work", async (context) => {
  const { store, scheduler } = fixture(context);
  const saved = scheduler.save(input);
  store.conversations = [
    { id: "older-run", scheduledTaskId: saved.id, archived: false, turns: [] },
    { id: "unrelated", archived: false, turns: [] },
    {
      id: "active",
      mode: "code",
      scheduledTaskId: saved.id,
      archived: false,
      turns: [{ status: "inProgress", items: [] }],
    },
  ] as unknown as Conversation[];
  const events: any[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCollectionHandlers((name, handler) => handlers.set(name, handler), {
    store,
    scheduler,
    push: (event: any) => events.push(event),
    onSettingsChanged: () => () => {},
    onAccountActivated() {},
    onAccountDeactivating() {},
  } as unknown as AppContext);
  await handlers.get("deleteSchedule")!(saved.id);
  assert.equal(scheduler.list().length, 0);
  assert.equal(store.conversations[0].archived, true);
  assert.equal(store.conversations[1].archived, false);
  assert.equal(store.conversations[2].archived, false);
  assert.equal(events[0].conversation.id, "older-run");
  assert.equal(new Store(store.root).conversations[0].archived, true);
});
