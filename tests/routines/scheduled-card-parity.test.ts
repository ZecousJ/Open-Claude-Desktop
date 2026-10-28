import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoutineCard } from "../../src/collections/routines/RoutineCard";
import { cardRunTime } from "../../src/collections/routines/routine-list";
import { Scheduler } from "../../electron/routines/scheduler";
import type { Routine } from "../../shared/routines";
import { readSource } from "../support/read-source";

const routine: Routine = {
  id: "task",
  name: "Review",
  prompt: "Review changes",
  mode: "code",
  providerId: "test",
  model: "test",
  enabled: true,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:00" },
  nextRunAt: Date.now() + 86_400_000,
  createdAt: 1,
  updatedAt: 1,
};
function card(
  extra: Partial<Routine> = {},
  flags: { unread?: boolean; needsAttention?: boolean; off?: boolean } = {},
) {
  return renderToStaticMarkup(
    createElement(RoutineCard, {
      routine: { ...routine, ...extra },
      off: false,
      starting: false,
      menuOpen: false,
      onEdit() {},
      onMenu() {},
      ...flags,
    }),
  );
}

test("scheduled naming uses New task and preserves the official Scheduled sidebar", () => {
  const page = readSource("src/collections/routines/RoutinesPage.tsx");
  const navigation = fs.readFileSync("src/sidebar/navItems.ts", "utf8");
  assert.match(page, /<h1 className="routines-title">Scheduled tasks<\/h1>/);
  assert.match(page, />\s*New task\s*</);
  assert.match(page, /placeholder="Search scheduled tasks…"/);
  assert.doesNotMatch(page, />\s*New routine\s*</);
  assert.match(navigation, /id: "scheduled", label: "Scheduled"/);
});

test("scheduled cards put timing and icon states in the footer", () => {
  assert.match(card(), /routine-card-footer.*Next run: /);
  assert.doesNotMatch(card(), / · Next |Last run failed|Ran once/);
  assert.match(
    card({ repeat: { kind: "once", at: routine.nextRunAt } }),
    /Runs at: /,
  );
  const paused = card({ enabled: false });
  assert.match(paused, /routine-card-footer.*data-icon="Pause".*Paused/);
  assert.doesNotMatch(paused, /Next run: /);
  assert.match(
    card({ enabled: false, repeat: { kind: "once", at: 1 }, lastRunAt: 2 }),
    /data-icon="Check".*Ran/,
  );
  assert.match(
    card({ enabled: false, endedReason: "auto_disabled_repo_access" }),
    /routine-state failed.*Auto-disabled/,
  );
  assert.match(card({}, { off: true }), /On hold/);
  assert.match(
    card({ repeat: { kind: "manual" }, lastRunAt: Date.now() }),
    /Last run: /,
  );
});

test("run indicators follow failure, approval, working and unread precedence", () => {
  const failed = card(
    { lastRunStatus: "failed", lastError: "private failure" },
    { unread: true },
  );
  assert.match(failed, /data-dot="failed".*Needs attention/);
  assert.doesNotMatch(failed, /private failure|routine-attention/);
  assert.match(
    card({ lastRunStatus: "running" }, { needsAttention: true }),
    /routine-attention.*Needs attention.*data-dot="needs_attention"/,
  );
  assert.match(
    card({ lastRunStatus: "starting" }, { unread: true }),
    /data-dot="running"/,
  );
  assert.match(card({}, { unread: true }), /data-dot="new_run"/);
  assert.doesNotMatch(card(), /data-dot/);
});

test("footer dates use the official relative calendar wording without ICU", () => {
  const now = new Date(2026, 9, 16, 10).getTime();
  assert.match(cardRunTime(now, now), /^today at /);
  assert.match(cardRunTime(now + 86_400_000, now), /^tomorrow at /);
  assert.match(
    cardRunTime(now - 86_400_000, now, false, "past"),
    /^yesterday at /,
  );
  assert.doesNotMatch(cardRunTime(now - 86_400_000, now), /^yesterday/);
  assert.doesNotMatch(
    cardRunTime(now + 86_400_000, now, false, "past"),
    /^tomorrow/,
  );
  assert.match(cardRunTime(now, now, true), /at ~/);
});

test("missing repository auto-disables and persists; re-enabling clears the reason", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-card-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let dispatched = false;
  const options = {
    now: () => Date.now(),
    isBusy: () => false,
    run: async () => {
      dispatched = true;
      throw new Error("Repository unavailable");
    },
  };
  const scheduler = new Scheduler(root, options);
  const { id, ...input } = routine;
  const saved = scheduler.save({ ...input, cwd: path.join(root, "missing") });
  await assert.rejects(scheduler.runNow(saved.id), /Repository unavailable/);
  assert.equal(dispatched, true);
  const reopened = new Scheduler(root, options);
  const disabled = reopened.list()[0];
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.endedReason, "auto_disabled_repo_access");
  fs.mkdirSync(disabled.cwd!);
  const enabled = reopened.save({ ...disabled, enabled: true });
  assert.equal(enabled.endedReason, undefined);
});

test("ordinary failures and non-Code tasks do not auto-disable", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-card-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scheduler = new Scheduler(root, {
    now: () => Date.now(),
    isBusy: () => false,
    run: async () => {
      throw new Error("Dispatch failed");
    },
  });
  const { id, ...input } = routine;
  for (const fields of [
    { name: "Local failure", cwd: root },
    {
      name: "Cowork failure",
      mode: "cowork" as const,
      cwd: path.join(root, "missing"),
    },
  ]) {
    const saved = scheduler.save({ ...input, ...fields });
    await assert.rejects(scheduler.runNow(saved.id));
    const failed = scheduler.list().find((item) => item.id === saved.id)!;
    assert.equal(failed.enabled, true);
    assert.equal(failed.endedReason, undefined);
    assert.equal(failed.lastRunStatus, "failed");
  }
});

test("a card says where its task runs and names its project", async () => {
  const { RoutineCard } =
    await import("../../src/collections/routines/RoutineCard");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const routine = {
    id: "r",
    name: "Daily",
    prompt: "x",
    enabled: true,
    repeat: { kind: "manual" },
    executionLocation: "remote",
    projectId: "p",
  } as never;
  const html = renderToStaticMarkup(
    createElement(RoutineCard, {
      routine,
      project: { id: "p", name: "Launch" } as never,
      off: false,
      starting: false,
      menuOpen: false,
      onEdit() {},
      onMenu() {},
    }),
  );
  assert.match(html, /class="routine-location-chip">[^]*?Cloud<\/span>/);
  assert.match(
    html,
    /class="routine-card-project">[^]*?<span dir="auto" data-no-translate="true">Launch<\/span>/,
  );
});
