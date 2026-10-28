import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Scheduler } from "../../electron/routines/scheduler";
import { openPolicy } from "../../shared/client-policy";
import type { RoutineAllowed, RoutineInput } from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";
import type { Conversation } from "../../shared/types";
import {
  parseOperatorPolicy,
  resolveClientPolicy,
} from "../../server/operator-policy";
import { AlwaysAllowed } from "../../src/collections/routines/RoutinePermission";
import { skippedRunReason } from "../../src/collections/routines/RoutineHistory";
import { RoutineRunRow } from "../../src/collections/routines/RoutineRunRow";
import { webMethodKind } from "../../shared/web-bridge-methods";

const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 86_400_000;
const approval: RoutineAllowed = {
  kind: "command",
  tool: "Run command",
  pattern: "npm test",
};
const input: RoutineInput = {
  name: "Review",
  prompt: "Review changes",
  mode: "code",
  providerId: "p",
  model: "m",
  frequency: "hourly",
  nextRunAt: NOW,
  enabled: true,
  disableJitter: true,
};

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = NOW;
  let busy = false;
  let days: number | undefined = 1;
  const options = {
    now: () => now,
    isBusy: () => busy,
    policy: () => ({
      ...openPolicy,
      scheduledTasks: {
        ...openPolicy.scheduledTasks,
        approvalLifetimeDays: days,
      },
    }),
    run: async () =>
      ({
        id: "conversation",
        title: "Review",
        mode: "code",
        providerId: "p",
        model: "m",
        createdAt: now,
        updatedAt: now,
        pinned: false,
        archived: false,
        turns: [
          {
            id: "turn",
            prompt: input.prompt,
            attachments: [],
            items: [],
            status: "completed",
            createdAt: now,
          },
        ],
      }) as Conversation,
  };
  const scheduler = new Scheduler(root, options);
  const task = scheduler.save(input);
  return {
    root,
    options,
    scheduler,
    task,
    clock: (value: number) => {
      now = value;
    },
    busy: (value: boolean) => {
      busy = value;
    },
    lifetime: (value?: number) => {
      days = value;
    },
  };
}

test("approvals expire at the policy boundary, persist their grant time, and can be granted again", (t) => {
  const f = fixture(t);
  f.scheduler.allow(f.task.id, approval);
  assert.equal(f.scheduler.allowedFor(f.task.id)[0].approvedAt, NOW);
  f.clock(NOW + DAY - 1);
  assert.equal(f.scheduler.allowedFor(f.task.id).length, 1);
  f.clock(NOW + DAY);
  assert.deepEqual(f.scheduler.allowedFor(f.task.id), []);
  assert.equal(f.scheduler.list()[0].alwaysAllowed?.[0].expired, true);
  f.scheduler.allow(f.task.id, approval);
  assert.equal(f.scheduler.allowedFor(f.task.id)[0].approvedAt, NOW + DAY);
  assert.equal(
    new Scheduler(f.root, f.options).allowedFor(f.task.id)[0].approvedAt,
    NOW + DAY,
  );
  f.lifetime(0);
  assert.equal(f.scheduler.allowedFor(f.task.id).length, 0);
  f.lifetime();
  assert.equal(f.scheduler.allowedFor(f.task.id).length, 1);
});

test("legacy approvals use task creation time and tolerate only five minutes of clock skew", (t) => {
  const f = fixture(t);
  f.scheduler.save({ ...f.task, alwaysAllowed: [approval] });
  f.clock(NOW - 300_000);
  assert.equal(f.scheduler.allowedFor(f.task.id).length, 1);
  f.clock(NOW - 300_001);
  assert.equal(f.scheduler.allowedFor(f.task.id).length, 0);
  f.clock(NOW + DAY);
  assert.equal(f.scheduler.list()[0].alwaysAllowed?.[0].expired, true);
});

test("dedicated removal persists exact rules or all rules for a tool, with re-allow after removal", (t) => {
  const f = fixture(t);
  const other = { ...approval, pattern: "npm run build" };
  f.scheduler.allow(f.task.id, approval);
  f.scheduler.allow(f.task.id, other);
  assert.equal(f.scheduler.removeAllowed(f.task.id, approval), true);
  assert.equal(f.scheduler.removeAllowed(f.task.id, approval), false);
  assert.equal(
    new Scheduler(f.root, f.options).allowedFor(f.task.id)[0].pattern,
    other.pattern,
  );
  f.scheduler.allow(f.task.id, approval);
  const saved = f.scheduler.save({ ...f.task, alwaysAllowed: undefined });
  assert.equal(saved.alwaysAllowed?.length, 2);
  assert.equal(
    f.scheduler.removeAllowed(f.task.id, {
      kind: "command",
      tool: approval.tool,
    }),
    true,
  );
  assert.equal(f.scheduler.allowedFor(f.task.id).length, 0);
});

test("removal persistence failures reject and do not discard the approval", (t) => {
  const f = fixture(t);
  f.scheduler.allow(f.task.id, approval);
  fs.mkdirSync(path.join(f.root, "schedules.json.tmp"));
  assert.throws(() => f.scheduler.removeAllowed(f.task.id, approval));
  assert.equal(f.scheduler.allowedFor(f.task.id).length, 1);
});

test("revocations on save retain independently granted approvals", (t) => {
  const f = fixture(t);
  f.scheduler.allow(f.task.id, approval);
  const other = { ...approval, pattern: "npm run build" };
  f.scheduler.allow(f.task.id, other);
  f.scheduler.save({ ...f.task, revokedApprovals: [approval] });
  assert.deepEqual(
    f.scheduler.allowedFor(f.task.id).map((entry) => entry.pattern),
    [other.pattern],
  );
});

test("missed and busy runs are recorded without dispatching, and resume advances the schedule", async (t) => {
  const f = fixture(t);
  f.clock(NOW + 2 * DAY);
  await f.scheduler.tick();
  assert.equal(f.scheduler.runs(f.task.id)[0].skipReason, "missed");
  const next = f.scheduler.list()[0].nextRunAt;
  f.busy(true);
  f.clock(next);
  await f.scheduler.tick();
  assert.equal(f.scheduler.runs(f.task.id)[0].skipReason, "busy");
  assert.equal(f.scheduler.runs(f.task.id).length, 2);
});

test("finished runs stay unread until opened, including opening outside history", async (t) => {
  const f = fixture(t);
  await f.scheduler.runNow(f.task.id);
  const run = f.scheduler.runs(f.task.id)[0];
  assert.equal(run.status, "completed");
  assert.equal(run.readAt, undefined);
  f.scheduler.markConversationRead(run.conversationId!);
  assert.equal(f.scheduler.runs(f.task.id)[0].readAt, NOW);
  assert.equal(new Scheduler(f.root, f.options).runs(f.task.id)[0].readAt, NOW);
  f.clock(NOW + 1000);
  f.scheduler.markRunRead(f.task.id, run.id);
  assert.equal(f.scheduler.runs(f.task.id)[0].readAt, NOW + 1000);
});

test("opening an active run does not mark its later completion as read", async (t) => {
  const f = fixture(t);
  const conversation = await f.options.run();
  conversation.turns[0].status = "inProgress";
  f.options.run = async () => conversation;
  await f.scheduler.runNow(f.task.id);
  const run = f.scheduler.runs(f.task.id)[0];
  assert.equal(run.status, "running");
  f.scheduler.markRunRead(f.task.id, run.id);
  f.scheduler.markConversationRead(conversation.id);
  assert.equal(f.scheduler.runs(f.task.id)[0].readAt, undefined);
  conversation.turns[0].status = "completed";
  f.scheduler.observeConversation(conversation);
  assert.equal(f.scheduler.runs(f.task.id)[0].status, "completed");
  assert.equal(f.scheduler.runs(f.task.id)[0].readAt, undefined);
});

test("approval removal and read tracking use the web runner", () => {
  assert.equal(webMethodKind("removeRoutineApproval"), "remote-runner");
  assert.equal(webMethodKind("markRoutineRunRead"), "remote-runner");
});

test("the administrator editor preserves approval expiry settings and validates their bounds", async () => {
  const formPath =
    "../../backend/frontend/src/components/admin/claudex/policy/policyForm.ts";
  const { cleanPatch, normalizeLoadedPatch, validatePatch } = await import(
    formPath
  );
  for (const days of [null, 0, 7, 36500]) {
    const patch = { scheduled_tasks: { approval_lifetime_days: days } };
    assert.deepEqual(cleanPatch(normalizeLoadedPatch(patch)), patch);
    assert.deepEqual(validatePatch(patch), []);
  }
  for (const days of [-1, 0.5, 36501])
    assert.ok(
      validatePatch({ scheduled_tasks: { approval_lifetime_days: days } })
        .length,
    );
});

test("inline history shows official statuses, skipped reasons and unread markers; approvals show Expired", () => {
  const base: RoutineRun = {
    id: "run",
    startedAt: NOW,
    trigger: "schedule",
    status: "completed",
    conversationId: "c",
  };
  const render = (patch: Partial<RoutineRun>) =>
    renderToStaticMarkup(
      createElement(RoutineRunRow, {
        run: { ...base, ...patch },
        local: true,
        onOpen() {},
      }),
    );
  assert.match(render({}), /Unread completed run/);
  assert.match(render({}), /Only this computer/);
  assert.doesNotMatch(render({ readAt: NOW }), /Unread completed run/);
  assert.match(render({ status: "starting" }), /Running/);
  assert.match(render({ status: "interrupted" }), /Failed/);
  assert.match(
    render({ status: "skipped", skipReason: "in_progress" }),
    /The previous run was still in progress\./,
  );
  assert.equal(
    skippedRunReason({ ...base, skipReason: "sign_in" }),
    "You needed to sign in again.",
  );
  assert.doesNotMatch(render({}), /<table|Trigger|Duration|Completed/);
  const html = renderToStaticMarkup(
    createElement(AlwaysAllowed, {
      items: [{ ...approval, expired: true }],
      onRemove() {},
      className: "test",
    }),
  );
  assert.match(html, /Expired/);
  assert.match(html, /Remove approval/);
});

test("operator approval lifetime policy validates and merges fieldwise", () => {
  const file = parseOperatorPolicy({
    version: 1,
    defaults: { scheduledTasks: { approvalLifetimeDays: 7, maxTasks: 3 } },
    accounts: { account: { scheduledTasks: { approvalLifetimeDays: 0 } } },
  });
  const policy = resolveClientPolicy(file, {
    accountId: "account",
    platform: "darwin",
    appVersion: "1.0.0",
  });
  assert.equal(policy.scheduledTasks.approvalLifetimeDays, 0);
  assert.equal(policy.scheduledTasks.maxTasks, 3);
  for (const days of [-1, 1.5, 36501, "7"])
    assert.throws(() =>
      parseOperatorPolicy({
        version: 1,
        defaults: { scheduledTasks: { approvalLifetimeDays: days } },
      }),
    );
});
