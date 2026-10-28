import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import {
  allowedByList,
  allowedEntryFor,
  approvalResponse,
} from "../../shared/approval-response";
import {
  isCompletedOnce,
  nextRun,
  nextWakeAt,
  routineSections,
  taskPermissionOf,
  validAllowed,
  validRepeat,
  type RoutineAllowed,
  type RoutineInput,
} from "../../shared/routines";
import { repeatLabel, repeatOf } from "../../shared/routine-labels";
import {
  approvalsReviewerFor,
  scheduledCodeSandbox,
  taskSandboxFor,
} from "../../shared/sandbox-policy";
import type { Approval, Conversation, Turn } from "../../shared/types";
import {
  draftInput,
  draftRule,
  editDraft,
  fromLocalInput,
  newDraft,
  oncePast,
  toLocalInput,
} from "../../src/collections/routines/routine-draft";
import {
  defaultRoutineFilter,
  listSections,
  visibleRoutines,
} from "../../src/collections/routines/routine-list";

const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();
const AT = new Date(2026, 9, 14, 15, 0, 0).getTime();
const HOUR = 60 * 60_000;

function temporary(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-once-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function once(at = AT, overrides: Partial<RoutineInput> = {}): RoutineInput {
  return {
    name: "Remind me",
    prompt: "Say hello.",
    mode: "cowork",
    providerId: "p",
    model: "m",
    frequency: "daily",
    nextRunAt: at,
    enabled: true,
    repeat: { kind: "once", at },
    ...overrides,
  };
}
function conversation(status: Turn["status"] = "completed"): Conversation {
  return {
    id: "c1",
    title: "Run",
    mode: "cowork",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    turns: [
      {
        id: "t1",
        prompt: "Say hello.",
        attachments: [],
        items: [],
        status,
        createdAt: NOW,
      },
    ],
  };
}
function scheduler(
  t: any,
  now: { value: number },
  runs: any[] = [],
  status: Turn["status"] = "completed",
) {
  const root = temporary(t);
  const options = {
    isBusy: () => false,
    run: async (task: any) => {
      runs.push(task);
      return conversation(status);
    },
    now: () => now.value,
  };
  return { root, options, scheduler: new Scheduler(root, options) };
}

test("a one-time rule has one slot, in whole minutes, and reads as 'Once on …'", () => {
  assert.deepEqual(validRepeat({ kind: "once", at: AT + 30_000 }), {
    kind: "once",
    at: AT,
  });
  assert.throws(() => validRepeat({ kind: "once", at: "soon" }), /valid time/);
  assert.throws(() => validRepeat({ kind: "once" }), /valid time/);
  assert.equal(nextRun({ kind: "once", at: AT }, NOW), AT);
  assert.equal(nextRun({ kind: "once", at: AT }, AT), undefined);
  assert.equal(nextRun({ kind: "once", at: AT }, AT + 1), undefined);
  assert.equal(
    repeatLabel({ kind: "once", at: AT }, "en-US"),
    "Once on Oct 14, 3:00 PM",
  );
  // A paused or finished one-time routine never wakes the runner.
  assert.equal(
    nextWakeAt([
      { enabled: true, nextRunAt: AT, repeat: { kind: "once", at: AT } },
      { enabled: false, nextRunAt: AT - HOUR, repeat: { kind: "once", at: 1 } },
    ]),
    AT,
  );
  assert.equal(
    nextWakeAt([
      { enabled: false, nextRunAt: AT, repeat: { kind: "once", at: AT } },
    ]),
    undefined,
  );
});

test("a one-time routine runs once at its moment, switches itself off and lists as completed", async (t) => {
  const now = { value: NOW };
  const runs: any[] = [];
  const { scheduler: s } = scheduler(t, now, runs, "inProgress");
  const saved = s.save(once());
  assert.equal(saved.nextRunAt, AT);
  assert.equal(saved.frequency, "daily");
  // Not yet due.
  await s.tick();
  assert.equal(runs.length, 0);
  now.value = AT + 20_000;
  await s.tick();
  assert.equal(runs.length, 1);
  const ran = s.list()[0];
  assert.equal(ran.enabled, false);
  assert.equal(ran.nextRunAt, AT);
  assert.equal(ran.lastRunStatus, "running");
  // The run's conversation ends: now it is completed.
  assert.equal(isCompletedOnce(ran), false, "a running run is not completed");
  s.observeConversation(conversation("completed"));
  assert.equal(isCompletedOnce(s.list()[0]), true);
  // It never runs again, however long the app stays open.
  now.value = AT + 5 * HOUR;
  await s.tick();
  await s.tick();
  assert.equal(runs.length, 1);
});

test("a one-time routine whose moment passed while the app was closed is missed", async (t) => {
  const now = { value: NOW };
  const runs: any[] = [];
  const { root, options, scheduler: s } = scheduler(t, now, runs);
  s.save(once());
  // The app is closed past the moment, then opens.
  now.value = AT + 3 * HOUR;
  const opened = new Scheduler(root, { ...options, now: () => now.value });
  await opened.tick();
  assert.equal(runs.length, 0);
  assert.equal(opened.runs(opened.list()[0].id)[0].skipReason, "missed");
  assert.equal(opened.list()[0].enabled, false);
  // Editing the name of the waiting routine does not need a new moment.
  const second = scheduler(t, { value: NOW });
  const waiting = second.scheduler.save(once());
  const later = new Scheduler(second.root, {
    ...second.options,
    now: () => AT + HOUR,
  });
  assert.equal(
    later.save({ ...later.list()[0], name: waiting.name + " Renamed" }).repeat
      ?.kind,
    "once",
  );
});

test("a past moment is refused for a new routine, a changed moment and a routine that already ran", async (t) => {
  const now = { value: NOW };
  const { scheduler: s } = scheduler(t, now);
  assert.throws(
    () => s.save(once(NOW - HOUR)),
    /Choose a time in the future\./,
  );
  assert.throws(() => s.save(once(NOW)), /Choose a time in the future\./);
  // A paused routine may keep any moment.
  assert.doesNotThrow(() =>
    s.save(once(NOW - HOUR, { name: "Paused", enabled: false })),
  );
  // Switching a paused routine on whose moment has gone needs a new moment.
  const paused = s.list().find((task) => task.name === "Paused")!;
  assert.throws(
    () => s.save({ ...paused, enabled: true }),
    /Choose a time in the future\./,
  );
  const saved = s.save(once());
  assert.throws(
    () => s.save({ ...saved, repeat: { kind: "once", at: NOW - HOUR } }),
    /Choose a time in the future\./,
  );
  now.value = AT + 1000;
  await s.tick();
  const done = s.list().find((task) => task.id === saved.id)!;
  assert.equal(done.enabled, false);
  // Switching a finished routine on with the same moment is refused; a new moment works.
  assert.throws(
    () => s.save({ ...done, enabled: true }),
    /Choose a time in the future\./,
  );
  const again = new Date(2026, 9, 20, 9, 0).getTime();
  const rescheduled = s.save({
    ...done,
    enabled: true,
    repeat: { kind: "once", at: again },
  });
  assert.equal(rescheduled.nextRunAt, again);
  assert.equal(rescheduled.enabled, true);
  assert.equal(isCompletedOnce(rescheduled), false);
});

test("Run now on a one-time routine before its moment does not use it up; after, it does", async (t) => {
  const now = { value: NOW };
  const runs: any[] = [];
  const { scheduler: s } = scheduler(t, now, runs);
  const saved = s.save(once());
  await s.runNow(saved.id);
  s.observeConversation(conversation("completed"));
  const early = s.list()[0];
  assert.equal(early.enabled, true);
  assert.equal(early.nextRunAt, AT);
  assert.equal(isCompletedOnce(early), false);
  now.value = AT + 1000;
  await s.tick();
  assert.equal(runs.length, 2, "its moment still runs");
  assert.equal(s.list()[0].enabled, false);
});

test("sections: active, inactive and completed", () => {
  const base = { nextRunAt: AT } as any;
  const rows = [
    {
      ...base,
      id: "a",
      enabled: true,
      repeat: { kind: "daily", time: "09:00" },
    },
    {
      ...base,
      id: "b",
      enabled: false,
      repeat: { kind: "daily", time: "09:00" },
    },
    {
      ...base,
      id: "c",
      enabled: false,
      repeat: { kind: "once", at: AT },
      lastRunAt: AT + 5,
      lastRunStatus: "completed",
    },
    {
      ...base,
      id: "d",
      enabled: false,
      repeat: { kind: "once", at: AT },
      lastRunAt: AT + 5,
      lastRunStatus: "running",
    },
    { ...base, id: "e", enabled: false, repeat: { kind: "once", at: AT } },
  ];
  const sections = routineSections(rows);
  assert.deepEqual(
    sections.active.map((r: any) => r.id),
    ["a"],
  );
  assert.deepEqual(
    sections.inactive.map((r: any) => r.id),
    ["b", "d", "e"],
  );
  assert.deepEqual(
    sections.completed.map((r: any) => r.id),
    ["c"],
  );
  // The page's list: finished ones come after, and the Completed filter finds them.
  const list = rows.map((r) => ({
    ...r,
    name: r.id,
    prompt: "",
    mode: "cowork",
    providerId: "p",
    model: "m",
    frequency: "daily",
    createdAt: 0,
    updatedAt: 0,
  }));
  const shown = visibleRoutines(list, "", defaultRoutineFilter, "name");
  assert.deepEqual(
    listSections(shown).completed.map((r) => r.id),
    ["c"],
  );
  assert.deepEqual(
    visibleRoutines(
      list,
      "",
      { runsOn: "all", schedule: "all", status: "paused" },
      "name",
    ).map((r) => r.id),
    ["b", "d", "e"],
  );
  assert.deepEqual(
    visibleRoutines(
      list,
      "",
      { runsOn: "all", schedule: "once", status: "all" },
      "name",
    ).map((r) => r.id),
    ["c", "d", "e"],
  );
});

test("the editor's draft holds the moment and the permission, and gives them back", () => {
  const settings: any = {
    providers: [{ id: "p", model: "m" }],
    activeProviderId: "p",
  };
  const draft = newDraft(NOW, undefined, "cowork");
  // A new task starts on Auto.
  assert.equal(draft.permission, "auto");
  assert.equal(draft.kind, "daily");
  assert.equal(draft.at, new Date(2026, 9, 14, 13, 0).getTime());
  const chosen = {
    ...draft,
    kind: "once" as const,
    at: AT,
    permission: "auto" as const,
  };
  assert.deepEqual(draftRule(chosen), { kind: "once", at: AT });
  const input = draftInput(chosen, settings, NOW);
  assert.equal(input.nextRunAt, AT);
  assert.equal(input.permission, "auto");
  assert.deepEqual(input.repeat, { kind: "once", at: AT });
  assert.equal(oncePast(chosen, NOW), false);
  assert.equal(oncePast({ ...chosen, at: NOW }, NOW), true);
  assert.equal(oncePast({ ...chosen, at: null }, NOW), true);
  assert.equal(oncePast({ ...chosen, kind: "daily", at: null }, NOW), false);
  assert.equal(toLocalInput(AT), "2026-10-14T15:00");
  assert.equal(fromLocalInput("2026-10-14T15:00"), AT);
  assert.equal(fromLocalInput(""), null);
  assert.equal(fromLocalInput("tomorrow"), null);
  const stored: any = {
    ...input,
    id: "x",
    createdAt: 0,
    updatedAt: 0,
    alwaysAllowed: [{ kind: "command", tool: "Run command", pattern: "ls" }],
  };
  const opened = editDraft(stored, repeatOf(stored), settings);
  assert.equal(opened.kind, "once");
  assert.equal(opened.at, AT);
  assert.equal(opened.permission, "auto");
  assert.equal(opened.alwaysAllowed.length, 1);
  // A finished one-time routine opens switched on, wanting a new moment.
  const finished: any = {
    ...stored,
    enabled: false,
    lastRunAt: AT + 10,
    lastRunStatus: "completed",
  };
  assert.equal(editDraft(finished, repeatOf(finished), settings).enabled, true);
  // A routine saved before permission modes: full access for Cowork, the Code setting for Code.
  const legacy: any = { ...stored, permission: undefined };
  assert.equal(
    editDraft(legacy, repeatOf(legacy), settings).permission,
    "bypass",
  );
  const code: any = { ...legacy, mode: "code", cwd: "/work" };
  assert.equal(
    editDraft(code, repeatOf(code), {
      ...settings,
      codeSandbox: "workspace-write",
    }).permission,
    "default",
  );
  assert.equal(
    editDraft(code, repeatOf(code), {
      ...settings,
      codeSandbox: "danger-full-access",
      allowBypassPermissions: true,
      bypassFolders: ["/work"],
    }).permission,
    "bypass",
  );
});

test("a scheduled run follows the routine's permission; without one it has full access", () => {
  assert.equal(taskPermissionOf({}), "bypass");
  assert.equal(taskPermissionOf({ permission: "default" }), "default");
  // Cowork
  assert.equal(taskSandboxFor({}, true), "danger-full-access");
  assert.equal(taskSandboxFor({}, true, false, "bypass"), "danger-full-access");
  assert.equal(taskSandboxFor({}, true, false, "default"), "workspace-write");
  assert.equal(taskSandboxFor({}, true, false, "auto"), "workspace-write");
  assert.equal(
    approvalsReviewerFor("cowork", {}, true, false, "auto"),
    "auto_review",
  );
  assert.equal(
    approvalsReviewerFor("cowork", {}, true, false, "default"),
    "user",
  );
  assert.equal(approvalsReviewerFor("cowork", {}, true), "user");
  assert.equal(
    approvalsReviewerFor("code", {}, true, false, "auto"),
    "auto_review",
  );
  // The home's picker never leaks into a scheduled run.
  assert.equal(
    approvalsReviewerFor("cowork", { taskPermission: "auto" }, true),
    "user",
  );
  // Code: no mode keeps the Code setting; a mode is honoured where Bypass is allowed.
  assert.equal(scheduledCodeSandbox({}, undefined, "/work"), undefined);
  assert.equal(
    scheduledCodeSandbox(
      { allowBypassPermissions: true, bypassFolders: ["/work"] },
      "bypass",
      "/work",
    ),
    "danger-full-access",
  );
  assert.equal(
    scheduledCodeSandbox(
      { allowBypassPermissions: true, bypassFolders: ["*"] },
      "bypass",
      "/any",
    ),
    "danger-full-access",
  );
  // A folder nobody confirmed for Bypass keeps asking, as Code sessions do.
  assert.equal(scheduledCodeSandbox({}, "bypass", "/work"), "workspace-write");
  assert.equal(
    scheduledCodeSandbox(
      { allowBypassPermissions: false, bypassFolders: ["*"] },
      "bypass",
      "/work",
    ),
    "workspace-write",
  );
  assert.equal(
    scheduledCodeSandbox({ bypassFolders: ["*"] }, "default", "/work"),
    "workspace-write",
  );
});

test("the scheduler saves a permission, rejects a bad one and Auto when the administrator turned it off", (t) => {
  const now = { value: NOW };
  const root = temporary(t);
  let modes = ["auto", "manual", "acceptEdits", "plan"];
  const s = new Scheduler(root, {
    isBusy: () => false,
    run: async () => conversation(),
    now: () => now.value,
    policy: () =>
      ({
        scheduledTasks: { enabled: true, maxTasks: null },
        permissionModes: modes,
      }) as any,
  });
  const saved = s.save(once(AT, { permission: "default" }));
  assert.equal(saved.permission, "default");
  assert.throws(
    () => s.save(once(AT, { name: "Other", permission: "root" as any })),
    /permission mode/,
  );
  assert.equal(s.save({ ...saved, permission: "auto" }).permission, "auto");
  modes = ["manual"];
  assert.throws(
    () => s.save(once(AT, { name: "Third", permission: "auto" })),
    /doesn't allow Auto/,
  );
  // One saved on Auto before keeps it while being paused.
  assert.equal(s.save({ ...s.list()[0], enabled: false }).permission, "auto");
  assert.equal(s.save(once(AT, { name: "Plain" })).permission, "default");
});

test("Always allowed: kept per routine, shown to the editor, cleared when the folder changes", (t) => {
  const now = { value: NOW };
  const { scheduler: s, root, options } = scheduler(t, now);
  const saved = s.save(once(AT, { permission: "default", cwd: "/work" }));
  const entry: RoutineAllowed = {
    kind: "command",
    tool: "Run command",
    pattern: "npm test",
  };
  s.allow(saved.id, entry);
  s.allow(saved.id, entry);
  const granted = { ...entry, approvedAt: NOW };
  assert.deepEqual(s.allowedFor(saved.id), [granted]);
  assert.deepEqual(new Scheduler(root, options).allowedFor(saved.id), [
    granted,
  ]);
  // A form that sends no list keeps it; one that sends a shorter list removes.
  const kept = s.save({ ...s.list()[0], alwaysAllowed: undefined });
  assert.deepEqual(kept.alwaysAllowed, [granted]);
  const second: RoutineAllowed = {
    kind: "edit",
    tool: "Edit files",
    pattern: "/work/src",
  };
  s.allow(saved.id, second);
  assert.equal(s.allowedFor(saved.id).length, 2);
  const removed = s.save({ ...s.list()[0], alwaysAllowed: [second] });
  assert.deepEqual(removed.alwaysAllowed, [second]);
  // Changing where it runs clears the list.
  const moved = s.save({ ...s.list()[0], cwd: "/elsewhere" });
  assert.equal(moved.alwaysAllowed, undefined);
  assert.deepEqual(s.allowedFor(saved.id), []);
  assert.throws(
    () => validAllowed([{ kind: "nope", tool: "x" }]),
    /allowed actions/,
  );
  s.allow("missing", entry);
});

function approval(method: string, params: any): Approval {
  return { id: "1", conversationId: "c1", method, params };
}

test("approvals are described for the list and matched against it", () => {
  const command = approval("item/commandExecution/requestApproval", {
    command: " npm test ",
  });
  const entry = allowedEntryFor(command)!;
  assert.deepEqual(entry, {
    kind: "command",
    tool: "Run command",
    pattern: "npm test",
  });
  assert.equal(allowedByList([entry], command), true);
  assert.equal(
    allowedByList(
      [entry],
      approval("item/commandExecution/requestApproval", {
        command: "rm -rf /",
      }),
    ),
    false,
  );
  const network = approval("item/commandExecution/requestApproval", {
    command: "curl x",
    networkApprovalContext: { host: "example.com" },
  });
  assert.deepEqual(allowedEntryFor(network), {
    kind: "command",
    tool: "Network",
    pattern: "example.com",
  });
  // File edits are matched by the folder they are in.
  const conversationWithEdit = {
    turns: [
      {
        items: [
          {
            id: "i1",
            type: "fileChange",
            changes: [{ path: "/work/src/a.ts" }, { path: "/work/src/b.ts" }],
          },
        ],
      },
    ],
  } as any;
  const edit = approval("item/fileChange/requestApproval", { itemId: "i1" });
  assert.deepEqual(allowedEntryFor(edit, conversationWithEdit), {
    kind: "edit",
    tool: "Edit files",
    pattern: "/work/src",
  });
  assert.equal(
    allowedByList(
      [{ kind: "edit", tool: "Edit files", pattern: "/work" }],
      edit,
      conversationWithEdit,
    ),
    true,
  );
  assert.equal(
    allowedByList(
      [{ kind: "edit", tool: "Edit files", pattern: "/work/other" }],
      edit,
      conversationWithEdit,
    ),
    false,
  );
  // Without the item nothing is guessed.
  assert.equal(allowedByList([entry], edit), false);
  // Questions are asked every time.
  const question = approval("item/tool/requestUserInput", {});
  assert.equal(allowedEntryFor(question), undefined);
  assert.equal(allowedByList([entry], question), false);
  assert.deepEqual(approvalResponse(command, "once"), { decision: "accept" });
});

test("a routine's run asks, keeps an Always allow, and answers the same request on its next run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-routine-eng-"));
  const store = new Store(root);
  try {
    const responses: unknown[] = [];
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    engine.rpc = {
      respond: (_id: unknown, result: unknown) => responses.push(result),
    } as any;
    const kept: [string, RoutineAllowed][] = [];
    let list: RoutineAllowed[] = [];
    engine.routineApprovals = {
      allowed: () => list,
      allow: (id, entry) => {
        kept.push([id, entry]);
        list = [...list, entry];
      },
    };
    const run = (id: string, thread: string): Conversation => {
      const c: Conversation = {
        ...conversation("inProgress"),
        id,
        threadId: thread,
        scheduledRun: true,
        scheduledTaskId: "routine-1",
        scheduledPermission: "default",
      };
      store.conversations.push(c);
      (engine as any).routes.set(thread, id);
      return c;
    };
    const request = (id: number, thread: string, command = "npm test") =>
      (engine as any).request({
        id,
        method: "item/commandExecution/requestApproval",
        params: { threadId: thread, command },
      });
    run("run-1", "thread-1");
    // First run: the request waits for the person, who chooses Always allow.
    request(1, "thread-1");
    assert.equal((engine as any).ownApprovals.length, 1);
    const open = (engine as any).ownApprovals[0] as Approval;
    engine.approve(open.id, approvalResponse(open, "always"));
    assert.deepEqual(kept, [
      [
        "routine-1",
        { kind: "command", tool: "Run command", pattern: "npm test" },
      ],
    ]);
    // The next run is answered without asking; other commands still ask.
    run("run-2", "thread-2");
    responses.length = 0;
    request(2, "thread-2");
    assert.equal((engine as any).ownApprovals.length, 0);
    assert.deepEqual(responses, [{ decision: "accept" }]);
    request(3, "thread-2", "rm -rf build");
    assert.equal((engine as any).ownApprovals.length, 1);
    // The administrator turning Always allow off ends the shortcut.
    engine.policy = () => ({ ...openPolicy, approvalsAlwaysAllow: false });
    request(4, "thread-2");
    assert.equal((engine as any).ownApprovals.length, 2);
  } finally {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
