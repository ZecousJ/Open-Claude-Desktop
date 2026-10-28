import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { routineDom } from "../support/routine-dom";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import { defaultSettings } from "../../electron/store/store";
import { ScheduledTaskDialog } from "../../src/collections/routines/ScheduledTaskDialog";
import { RoutineHistory } from "../../src/collections/routines/RoutineHistory";
import { validRoutineRunPage } from "../../src/collections/routines/RoutineRunRow";
import { RoutineSchedulePreview } from "../../src/collections/routines/RoutineSchedulePreview";
import { AutoDisabledRoutineNotice } from "../../src/collections/routines/AutoDisabledRoutineNotice";
import {
  editDraft,
  draftInput,
  type RoutineDraft,
} from "../../src/collections/routines/routine-draft";
import type {
  Routine,
  RoutineRunPage,
  RoutineSchedulePreview as Preview,
} from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";
import { currentLocale, setLocale } from "../../src/i18n";

const now = Date.UTC(2026, 9, 17, 0);
const routine: Routine = {
  id: "synthetic-r4",
  name: "夸我",
  prompt: "Synthetic instruction",
  mode: "cowork",
  providerId: "p",
  model: "Opus",
  defaultModel: true,
  enabled: true,
  frequency: "daily",
  repeat: { kind: "cron", expression: "0 7 * * 2,3,4,5,6" },
  nextRunAt: now + 86_400_000,
  createdAt: now,
  updatedAt: now,
  executionLocation: "remote",
};
const settings = {
  ...defaultSettings,
  activeProviderId: "p",
  providers: [
    {
      id: "p",
      name: "Synthetic",
      baseUrl: "",
      protocol: "responses" as const,
      model: "Opus",
      models: [],
    },
  ],
};
const run = (id: string, readAt?: number): RoutineRun => ({
  id,
  startedAt: now,
  status: "completed",
  trigger: "manual",
  conversationId: `chat-${id}`,
  ...(readAt ? { readAt } : {}),
});
const web = (child: ReturnType<typeof createElement>) =>
  createElement(HostContext.Provider, { value: webHost }, child);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("custom cron stays Custom through an unrelated edit, validates its real expression and preserves Unicode names", async () => {
  const requests: unknown[] = [];
  const page = await routineDom({
    routineSchedulePreview: async (repeat, location) => {
      requests.push([repeat, location]);
      return { nextRunAt: now + 32_400_000, timeZone: "UTC" };
    },
  });
  let value = editDraft(routine, routine.repeat!);
  let sent: ReturnType<typeof draftInput> | undefined;
  const render = () =>
    page.render(
      web(
        createElement(ScheduledTaskDialog, {
          draft: value,
          settings,
          others: [routine],
          onChange(next) {
            value = next;
            void render();
          },
          onCancel() {},
          onSave: async () => {
            sent = draftInput(value, settings, now);
          },
        }),
      ),
    );
  try {
    await render();
    assert.equal(page.document.querySelector("select")!.value, "custom");
    assert.equal(
      page.document.querySelector<HTMLInputElement>(
        '[aria-label="Cron expression"]',
      )!.value,
      "0 7 * * 2,3,4,5,6",
    );
    assert.match(
      page.document.querySelector(".routine-schedule-preview")!.textContent!,
      /UTC/,
    );
    assert.deepEqual(requests, [
      [{ kind: "cron", expression: "0 7 * * 2,3,4,5,6" }, "remote"],
    ]);
    await page.change('[aria-label="Name"]', "夸我（保留）");
    await page.event(page.document.querySelector("form")!, "submit");
    assert.equal(sent?.name, "夸我（保留）");
    assert.deepEqual(sent?.repeat, routine.repeat);
  } finally {
    await page.clean();
  }

  const invalidPage = await routineDom();
  value = {
    ...editDraft(routine, routine.repeat!),
    id: undefined,
    cron: "*/5 * * * *",
  };
  try {
    await invalidPage.render(
      web(
        createElement(ScheduledTaskDialog, {
          draft: value,
          settings,
          onChange() {},
          onCancel() {},
          onSave: async () => {
            throw new Error("must not save");
          },
        }),
      ),
    );
    assert.equal(
      invalidPage.document.querySelector<HTMLButtonElement>(".task-save")!
        .disabled,
      true,
    );
    assert.match(
      invalidPage.document.querySelector('[role="alert"]')!.textContent!,
      /at most once per hour/,
    );
  } finally {
    await invalidPage.clean();
  }
});

test("name collisions include other loaded sources, keep the editor name editable and permit its own unchanged name", async () => {
  const page = await routineDom();
  let saves = 0,
    value: RoutineDraft = {
      ...editDraft(routine, { kind: "daily", time: "09:00" }),
      id: undefined,
      name: "  DAILY-review  ",
    };
  const others = [{ id: "local-other-source", name: "daily-REVIEW" }];
  const show = () =>
    page.render(
      web(
        createElement(ScheduledTaskDialog, {
          draft: value,
          others,
          settings,
          onChange(next) {
            value = next;
            void show();
          },
          onCancel() {},
          onSave: async () => {
            saves++;
            throw new Error("Synthetic backend name was just taken");
          },
        }),
      ),
    );
  try {
    await show();
    assert.equal(
      page.document.querySelector<HTMLButtonElement>(".task-save")!.disabled,
      true,
    );
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /DAILY-review/,
    );
    await page.event(page.document.querySelector("form")!, "submit");
    assert.equal(saves, 0);
    await page.change('[aria-label="Name"]', "中文名称");
    assert.equal(
      page.document.querySelector<HTMLButtonElement>(".task-save")!.disabled,
      false,
    );
    await page.event(page.document.querySelector("form")!, "submit");
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /just taken/,
    );
    assert.equal(
      page.document.querySelector<HTMLInputElement>('[aria-label="Name"]')!
        .value,
      "中文名称",
    );
    assert.equal(
      page.document.querySelector<HTMLInputElement>('[aria-label="Name"]')!
        .disabled,
      false,
    );
    assert.equal(saves, 1);
  } finally {
    await page.clean();
  }
});

test("execution-side preview rejects malformed data, retries failures and ignores a prior location's late result", async () => {
  const old = deferred<Preview>();
  let calls = 0;
  const page = await routineDom({
    routineSchedulePreview: async () => {
      calls++;
      if (calls === 1) return old.promise;
      if (calls === 2) throw new Error("Synthetic preview offline");
      return { nextRunAt: now + 1000, timeZone: "UTC" };
    },
  });
  const show = (location: "local" | "remote") =>
    page.render(
      createElement(RoutineSchedulePreview, {
        expression: "0 9 * * *",
        executionLocation: location,
        disabled: false,
      }),
    );
  try {
    await show("local");
    await show("remote");
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /preview offline/,
    );
    await page.click(".routine-schedule-preview button");
    assert.match(
      page.document.querySelector('[role="status"]')!.textContent!,
      /UTC/,
    );
    await act(async () =>
      old.resolve({ nextRunAt: now, timeZone: "Asia/Tokyo" }),
    );
    assert.doesNotMatch(page.document.body.textContent!, /Tokyo/);
  } finally {
    await page.clean();
  }
  const malformed = await routineDom({
    routineSchedulePreview: async () =>
      ({ nextRunAt: "not a date", timeZone: "Imaginary/Zone" }) as never,
  });
  try {
    await malformed.render(
      createElement(RoutineSchedulePreview, {
        expression: "0 9 * * *",
        disabled: false,
      }),
    );
    assert.match(
      malformed.document.querySelector('[role="alert"]')!.textContent!,
      /Couldn’t load the schedule preview/,
    );
  } finally {
    await malformed.clean();
  }
});

test("history Show more fetches the real cursor, retains rows on failure and reconciles read state across pages", async () => {
  const queries: unknown[] = [];
  const second = deferred<RoutineRunPage>();
  let attempts = 0,
    reads = 0;
  const page = await routineDom({
    routineRuns: async () => {
      throw new Error("must not fetch the legacy full array");
    },
    routineRunsPage: async (_id, query) => {
      queries.push(query);
      if (!query?.cursor)
        return { runs: [run("first", now)], nextCursor: "server-cursor-first" };
      if (++attempts === 1) throw new Error("Synthetic page failed");
      return second.promise;
    },
    markRoutineRunRead: async () => {
      reads++;
    },
  });
  try {
    await page.render(
      web(createElement(RoutineHistory, { routine, onOpenConversation() {} })),
    );
    assert.equal(
      page.document.querySelectorAll(".routine-history-row").length,
      1,
    );
    await page.click(".routine-history-more");
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /page failed/,
    );
    assert.equal(
      page.document.querySelectorAll(".routine-history-row").length,
      1,
    );
    await page.click(".routine-history-more");
    assert.equal(
      page.document.querySelector<HTMLButtonElement>(".routine-history-more")!
        .disabled,
      true,
    );
    await page.click(".routine-history-more");
    assert.equal(
      queries.length,
      3,
      "double-click cannot issue another in-flight page",
    );
    await act(async () =>
      second.resolve({ runs: [run("first"), run("second")] }),
    );
    assert.equal(
      page.document.querySelectorAll(".routine-history-row").length,
      2,
    );
    assert.equal(
      page.document.querySelector(
        ".routine-history-list li:first-child .routine-run-unread",
      ),
      null,
    );
    assert.equal(page.document.querySelector(".routine-history-more"), null);
    assert.deepEqual(queries, [
      { cursor: undefined, limit: 100 },
      { cursor: "server-cursor-first", limit: 100 },
      { cursor: "server-cursor-first", limit: 100 },
    ]);
    assert.equal(reads, 0);
  } finally {
    await page.clean();
  }
});

test("a prior task's late page cannot append into a newly selected task, and a malformed page stays retryable", async () => {
  const late = deferred<RoutineRunPage>();
  const page = await routineDom({
    routineRunsPage: async (id, query) =>
      id === "A"
        ? query?.cursor
          ? late.promise
          : { runs: [run("a")], nextCursor: "A-cursor" }
        : { runs: [run("b", now)] },
  });
  const show = (id: string) =>
    page.render(
      web(
        createElement(RoutineHistory, {
          routine: { ...routine, id },
          onOpenConversation() {},
        }),
      ),
    );
  try {
    await show("A");
    await page.click(".routine-history-more");
    await show("B");
    await act(async () => late.resolve({ runs: [run("late-a")] }));
    assert.equal(
      page.document.querySelectorAll(".routine-history-row").length,
      1,
    );
    assert.equal(
      page.document.querySelector(".routine-history-row")!.getAttribute("href"),
      "/chat/chat-b",
    );
    assert.equal(page.document.querySelector('[role="alert"]'), null);
  } finally {
    await page.clean();
  }
  for (const value of [
    { runs: [], nextCursor: "never-advances" },
    { runs: [run("same"), run("same")] },
    { runs: [{ ...run("bad"), error: { not: "text" } }] },
    { runs: [{ ...run("bad-start"), startedAt: 9e99 }] },
    { runs: [{ ...run("bad-finish"), finishedAt: 9e99 }] },
    { runs: [], nextCursor: 1 },
  ])
    assert.equal(validRoutineRunPage(value), false);
});

test("real auto-disabled folder recovery is distinct from normal pause and does not update another page after unmount", async () => {
  const result = deferred<void>();
  let attempts = 0,
    edits = 0;
  const page = await routineDom();
  const disabled = {
    ...routine,
    mode: "code" as const,
    executionLocation: "local" as const,
    cwd: "/synthetic/workspace",
    enabled: false,
    endedReason: "auto_disabled_repo_access" as const,
    lastError: "Synthetic missing cwd",
  };
  try {
    await page.render(
      createElement(AutoDisabledRoutineNotice, {
        routine: disabled,
        disabled: false,
        onEdit: () => {
          edits++;
        },
        onRecover: () => {
          attempts++;
          return result.promise;
        },
      }),
    );
    assert.match(page.document.body.textContent!, /workspace folder/);
    assert.doesNotMatch(page.document.body.textContent!, /GitHub/);
    const buttons = page.document.querySelectorAll("button");
    await page.event(buttons[1], "click");
    await page.event(buttons[1], "click");
    assert.equal(attempts, 1);
    assert.equal((buttons[0] as HTMLButtonElement).disabled, true);
    await page.render(
      createElement("p", { "data-new-page": true }, "New page"),
    );
    await act(async () => result.reject(new Error("Late failure")));
    assert.equal(page.document.body.textContent, "New page");
    assert.equal(edits, 0);
    await page.render(
      createElement(AutoDisabledRoutineNotice, {
        routine: { ...disabled, endedReason: undefined },
        disabled: false,
        onEdit() {},
      }),
    );
    assert.equal(page.document.querySelector('[role="alert"]'), null);
  } finally {
    await page.clean();
  }
});

test("unchanged legacy names remain editable, while a fresh source rename exposes the new collision", async () => {
  const page = await routineDom();
  let value = {
    ...editDraft(
      { ...routine, name: "Legacy" },
      { kind: "daily", time: "09:00" },
    ),
  };
  let others = [
    { id: routine.id, name: "Legacy" },
    { id: "other-source", name: "Legacy" },
  ];
  const show = () =>
    page.render(
      web(
        createElement(ScheduledTaskDialog, {
          draft: value,
          others,
          settings,
          onChange(next) {
            value = next;
            void show();
          },
          onCancel() {},
          onSave: async () => {},
        }),
      ),
    );
  try {
    await show();
    await page.change('[aria-label="Instructions"]', "Changed instructions");
    assert.equal(
      page.document.querySelector<HTMLButtonElement>(".task-save")!.disabled,
      false,
    );
    others = [
      { id: routine.id, name: "Server renamed this task" },
      { id: "other-source", name: "Legacy" },
    ];
    await show();
    assert.equal(
      page.document.querySelector<HTMLButtonElement>(".task-save")!.disabled,
      true,
    );
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /Legacy.*already exists/,
    );
  } finally {
    await page.clean();
  }
});

test("missing execution time zones stay unknown and preserve the unambiguous server instant", async () => {
  const page = await routineDom({
    routineSchedulePreview: async () => ({ nextRunAt: now }),
  });
  try {
    await page.render(
      createElement(RoutineSchedulePreview, {
        expression: "0 9 * * *",
        disabled: false,
      }),
    );
    assert.match(
      page.document.querySelector('[role="status"]')!.textContent!,
      /2026-10-17T00:00:00.000Z/,
    );
    assert.match(page.document.body.textContent!, /Time zone unavailable/);
    assert.doesNotMatch(
      page.document.body.textContent!,
      /Asia\/Shanghai|Asia\/Tokyo|Time zone: UTC/,
    );
  } finally {
    await page.clean();
  }
});

test("cyclic page cursors never append a false page and Refresh recovers from the server's first page", async () => {
  let refreshed = false;
  const page = await routineDom({
    routineRunsPage: async (_id, query) => {
      if (refreshed) {
        assert.equal(query?.cursor, undefined);
        return { runs: [run("fresh")] };
      }
      if (!query?.cursor)
        return { runs: [run("first")], nextCursor: "cursor-1" };
      if (query.cursor === "cursor-1")
        return { runs: [run("second")], nextCursor: "cursor-2" };
      return { runs: [run("invalid-cycle")], nextCursor: "cursor-1" };
    },
  });
  try {
    await page.render(
      web(createElement(RoutineHistory, { routine, onOpenConversation() {} })),
    );
    await page.click(".routine-history-more");
    await page.click(".routine-history-more");
    assert.equal(
      page.document.querySelectorAll(".routine-history-row").length,
      2,
    );
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /Couldn’t load runs/,
    );
    refreshed = true;
    await page.click('[role="alert"] button');
    assert.equal(page.document.querySelector('[role="alert"]'), null);
    assert.equal(
      page.document.querySelectorAll(".routine-history-row").length,
      1,
    );
    assert.equal(
      page.document.querySelector(".routine-history-row")!.getAttribute("href"),
      "/chat/chat-fresh",
    );
  } finally {
    await page.clean();
  }
});

test("a translated backend name collision preserves a user name that is also an interface word", async () => {
  const before = currentLocale();
  const page = await routineDom();
  try {
    await setLocale("zh-CN");
    const draft = {
      ...editDraft(routine, { kind: "daily", time: "09:00" }),
      id: undefined,
      name: "Settings",
    };
    await page.render(
      web(
        createElement(ScheduledTaskDialog, {
          draft,
          settings,
          onChange() {},
          onCancel() {},
          onSave: async () => {
            throw new Error("A routine named “Settings” already exists.");
          },
        }),
      ),
    );
    await page.event(page.document.querySelector("form")!, "submit");
    const error = page.document.querySelector('[role="alert"]')!;
    assert.ok(error.hasAttribute("data-no-translate"));
    assert.match(error.textContent!, /Settings/);
    assert.doesNotMatch(error.textContent!, /设置/);
    assert.match(error.textContent!, /已存在/);
    assert.equal(
      page.document.querySelector<HTMLInputElement>(".task-field input")!.value,
      "Settings",
    );
  } finally {
    await page.clean();
    await setLocale(before);
  }
});
