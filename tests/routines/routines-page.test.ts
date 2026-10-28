import test from "node:test";
import assert from "node:assert/strict";
import { cronProblem, nextCron } from "../../shared/cron";
import {
  routineNameProblem,
  validRepeat,
  type Routine,
} from "../../shared/routines";
import { repeatLabel, repeatOf } from "../../shared/routine-labels";
import type { Settings } from "../../shared/types";
import {
  defaultRoutineFilter,
  noMatchText,
  visibleRoutines,
} from "../../src/collections/routines/routine-list";
import {
  draftInput,
  editDraft,
  newDraft,
} from "../../src/collections/routines/routine-draft";
import { routineTemplates } from "../../src/collections/routines/routine-templates";
import {
  onScheduleRequest,
  requestScheduleConfirmation,
  takeScheduleRequest,
} from "../../src/collections/routines/schedule-request";

const NOW = new Date(2026, 8, 25, 12, 0).getTime(); // a Friday
const routine = (overrides: Partial<Routine>): Routine => ({
  id: overrides.name ?? "r",
  name: "r",
  prompt: "Do the thing.",
  mode: "code",
  providerId: "p",
  model: "m",
  frequency: "daily",
  nextRunAt: NOW + 60_000,
  enabled: true,
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  repeat: { kind: "daily", time: "12:01" },
  ...overrides,
});
const settings = {
  providers: [
    {
      id: "p1",
      name: "One",
      baseUrl: "",
      protocol: "responses",
      model: "a",
      models: ["a", "b"],
    },
    {
      id: "p2",
      name: "Two",
      baseUrl: "",
      protocol: "responses",
      model: "c",
      models: [],
    },
  ],
  activeProviderId: "p2",
} as unknown as Settings;

test("the Yours tab searches every word, filters by schedule and status, and sorts", () => {
  const list = [
    routine({
      name: "review",
      description: "Weekly code review",
      nextRunAt: NOW + 5,
    }),
    routine({ name: "notes", repeat: { kind: "manual" }, updatedAt: NOW }),
    routine({ name: "health", enabled: false, nextRunAt: NOW + 1 }),
    routine({ name: "deps", nextRunAt: NOW + 2, prompt: "Scan packages" }),
  ];
  const names = (rows: Routine[]) => rows.map((r) => r.name);
  assert.deepEqual(
    names(visibleRoutines(list, "", defaultRoutineFilter, "next")),
    ["deps", "review", "health", "notes"],
    "paused and manual routines have no next run and come last",
  );
  assert.deepEqual(
    names(visibleRoutines(list, "code week", defaultRoutineFilter, "next")),
    ["review"],
  );
  assert.deepEqual(
    names(visibleRoutines(list, "packages", defaultRoutineFilter, "next")),
    ["deps"],
  );
  // The original has no Manual filter: manual tasks show under All only.
  assert.deepEqual(
    names(
      visibleRoutines(
        list,
        "",
        { runsOn: "all", schedule: "recurring", status: "paused" },
        "name",
      ),
    ),
    ["health"],
  );
  assert.deepEqual(
    names(
      visibleRoutines(
        list,
        "",
        { runsOn: "all", schedule: "all", status: "active" },
        "name",
      ),
    ),
    ["deps", "notes", "review"],
  );
  assert.equal(
    visibleRoutines(list, "", defaultRoutineFilter, "edited")[0].name,
    "notes",
  );
});

test("a template opens as a draft and a draft becomes what the scheduler is sent", () => {
  const template = routineTemplates.find((t) => t.id === "pr-review-digest")!;
  const draft = newDraft(NOW, template);
  assert.equal(draft.name, "PR review digest");
  // The template's time: weekdays at 09:30.
  assert.equal(draft.kind, "weekdays");
  assert.equal(draft.mode, "code");
  const input = draftInput(draft, settings, NOW);
  assert.deepEqual(input.repeat, { kind: "weekdays", time: "09:30" });
  assert.match(repeatLabel(input.repeat!), /^Weekdays at /);
  assert.equal(
    input.defaultModel,
    true,
    "Default is resolved by the main process",
  );
  assert.equal(input.providerId, "p2");
  assert.equal(input.model, "c");
  // Friday noon: 09:30 has passed, so Monday morning.
  assert.equal(input.nextRunAt, new Date(2026, 8, 28, 9, 30).getTime());
  const chosen = draftInput(
    { ...draft, model: { providerId: "p1", model: "b" }, kind: "manual" },
    settings,
    NOW,
  );
  assert.equal(chosen.defaultModel, undefined);
  assert.equal(chosen.model, "b");
  assert.deepEqual(chosen.repeat, { kind: "manual" });
  // A blank draft: daily at 09:00, as the original.
  assert.equal(newDraft(NOW).time, "09:00");
  assert.equal(newDraft(NOW).kind, "daily");
});

test("a task saved before routines opens with its own time and day", () => {
  const legacy = routine({
    repeat: undefined,
    frequency: "weekly",
    nextRunAt: new Date(2026, 8, 29, 7, 30).getTime(), // a Tuesday
  });
  const draft = editDraft(legacy, repeatOf(legacy));
  assert.equal(draft.kind, "weekly");
  assert.equal(draft.day, 2);
  assert.equal(draft.time, "07:30");
  assert.deepEqual(draft.model, { providerId: "p", model: "m" });
  assert.equal(draftInput(draft, settings, NOW).id, legacy.id);
});

test("Custom takes a cron expression, checked with the original's four messages", () => {
  assert.equal(cronProblem("0 9 * * *"), undefined);
  assert.equal(cronProblem("30 8 * * 1-5"), undefined);
  assert.equal(cronProblem("0 */2 * * *"), undefined);
  assert.equal(cronProblem("0 9 * *"), "invalid");
  assert.equal(cronProblem("61 9 * * *"), "invalid");
  assert.equal(cronProblem("*/5 * * * *"), "subHourly");
  assert.equal(cronProblem("0,30 * * * *"), "subHourly");
  assert.equal(cronProblem("0 9 * * MON"), "numericOnly");
  assert.equal(cronProblem("0 9 ? * *"), "numericOnly");
  assert.equal(cronProblem("0 9 * * 7"), "sundayIsZero");
  assert.equal(cronProblem("0 9 * * */7"), undefined);
  // The next run is the first matching minute after now (a Friday noon).
  assert.equal(
    nextCron("0 9 * * *", NOW),
    new Date(2026, 8, 26, 9, 0).getTime(),
  );
  assert.equal(
    nextCron("30 14 * * 1-5", NOW),
    new Date(2026, 8, 25, 14, 30).getTime(),
  );
  assert.equal(
    nextCron("0 9 * * 1", NOW),
    new Date(2026, 8, 28, 9, 0).getTime(),
  );
  assert.equal(
    nextCron("0 0 1 * *", NOW),
    new Date(2026, 9, 1, 0, 0).getTime(),
  );
  // A simple expression reads like the other schedules; others show as written.
  assert.equal(
    repeatLabel({ kind: "cron", expression: "0 9 * * 1-5" }),
    "Weekdays at 9:00 AM",
  );
  assert.equal(
    repeatLabel({ kind: "cron", expression: "0 9 * * *" }),
    "Daily at 9:00 AM",
  );
  assert.equal(
    repeatLabel({ kind: "cron", expression: "0 9 1 * *" }),
    "Cron 0 9 1 * *",
  );
  assert.throws(
    () => validRepeat({ kind: "cron", expression: "*/5 * * * *" }),
    /at most once per hour/,
  );
  // An older Custom (days) opens as the expression it amounts to.
  const older = routine({
    repeat: { kind: "custom", time: "01:49", days: [2, 3, 4, 5, 6] },
  });
  const draft = editDraft(older, repeatOf(older));
  assert.equal(draft.kind, "custom");
  assert.equal(draft.cron, "49 1 * * 2,3,4,5,6");
});

test("the list says why nothing matches", () => {
  assert.equal(
    noMatchText(true, false, false),
    "No scheduled tasks match your search.",
  );
  assert.equal(
    noMatchText(false, true, false),
    "No scheduled tasks match these filters.",
  );
  assert.equal(
    noMatchText(true, true, false),
    "No scheduled tasks match your search and filters.",
  );
  assert.equal(
    noMatchText(true, true, true),
    "No scheduled tasks match your search and filters.",
  );
});

test("a routine's name is checked against the others and the reserved ones", () => {
  const others = [
    { id: "a", name: "Daily review" },
    { id: "b", name: "Weekly" },
  ];
  assert.equal(routineNameProblem("Fresh", others), undefined);
  assert.equal(
    routineNameProblem("  daily REVIEW ", others),
    "A routine named “daily REVIEW” already exists.",
  );
  assert.equal(routineNameProblem("Daily review", others, "a"), undefined);
  assert.equal(
    routineNameProblem("New", others),
    "This name is reserved. Choose a different name.",
  );
  assert.equal(
    routineNameProblem("new-local", others),
    "This name is reserved. Choose a different name.",
  );
});

test("a project's task row asks the Routines page to open that routine", () => {
  // Nothing listening yet: the request waits for the page, taken once.
  requestScheduleConfirmation({ description: "", routineId: "r1" });
  assert.deepEqual(takeScheduleRequest(), {
    description: "",
    routineId: "r1",
  });
  assert.equal(takeScheduleRequest(), undefined);
  // A mounted page hears it at once.
  const heard: (string | undefined)[] = [];
  const off = onScheduleRequest((request) => heard.push(request.routineId));
  requestScheduleConfirmation({ description: "", routineId: "r2" });
  off();
  assert.deepEqual(heard, ["r2"]);
  assert.equal(takeScheduleRequest(), undefined);
});

test("filters add Runs on, Auto-disabled and On hold, as the original's", () => {
  const base = {
    prompt: "x",
    createdAt: 0,
    updatedAt: 0,
    repeat: { kind: "daily", time: "09:00" },
  };
  const list = [
    { ...base, id: "a", name: "local", enabled: true },
    {
      ...base,
      id: "b",
      name: "cloud",
      enabled: true,
      executionLocation: "remote",
    },
    {
      ...base,
      id: "c",
      name: "off",
      enabled: false,
      endedReason: "auto_disabled_repo_access",
    },
    { ...base, id: "d", name: "held", enabled: true, mode: "cowork" },
  ] as never[];
  const filter = (f: object) =>
    visibleRoutines(
      list,
      "",
      { ...defaultRoutineFilter, ...f } as never,
      "name",
      (r: any) => r.id === "d",
    ).map((r: any) => r.name);
  assert.deepEqual(filter({ runsOn: "remote" }), ["cloud"]);
  assert.deepEqual(filter({ status: "auto-disabled" }), ["off"]);
  assert.deepEqual(filter({ status: "on-hold" }), ["held"]);
  assert.deepEqual(filter({ status: "active" }), ["cloud", "local"]);
});

test("Duplicate copies a task as Copy of its name, with tools to allow again", async () => {
  const { duplicateDraft } =
    await import("../../src/collections/routines/routine-draft");
  const copy = duplicateDraft(
    { id: "a", name: "Daily", alwaysAllowed: [{ kind: "tool" }] } as never,
    "Copy of Daily",
  );
  assert.equal(copy.id, undefined);
  assert.equal(copy.duplicateOf, "a");
  assert.equal(copy.name, "Copy of Daily");
  assert.deepEqual(copy.alwaysAllowed, []);
});
