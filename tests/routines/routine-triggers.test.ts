import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import {
  chooseGitHubEvent,
  cleanRoutineTriggers,
  githubEventChoice,
  githubFilterFields,
  githubWebhooks,
  mergedPreset,
  newRoutineFilter,
  newRoutineTriggerId,
  routineGitHubMatches,
  routineFirePath,
  routineTriggerIdPattern,
} from "../../shared/routine-triggers";
import type { RoutineInput } from "../../shared/routines";
import type { Conversation } from "../../shared/types";

const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
const HOUR = 60 * 60_000;
function temporary(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-triggers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const conversation = (prompt: string): Conversation =>
  ({
    id: "conversation-1",
    title: "Run",
    mode: "code",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    turns: [
      {
        id: "turn-1",
        prompt,
        attachments: [],
        items: [],
        status: "completed",
        createdAt: NOW,
      },
    ],
  }) as Conversation;
const input = (overrides: Partial<RoutineInput> = {}): RoutineInput => ({
  name: "Triage",
  prompt: "Triage the new issues.",
  mode: "code",
  providerId: "p",
  model: "m",
  frequency: "daily",
  nextRunAt: NOW,
  enabled: true,
  ...overrides,
});

test("trigger ids are unguessable and the fire address is fixed", () => {
  const id = newRoutineTriggerId();
  assert.match(id, routineTriggerIdPattern);
  assert.notEqual(id, newRoutineTriggerId());
  assert.equal(routineFirePath(id), `/api/v1/claudex/routines/${id}/fire`);
});

test("a saved task's triggers are cleaned and the service's token hint is kept", () => {
  const api = newRoutineTriggerId();
  const cleaned = cleanRoutineTriggers(
    {
      schedule: false,
      api: { id: api, tokenHint: "forged" },
      github: {
        id: newRoutineTriggerId(),
        repository: "acme/tool",
        events: ["pull_request.opened"],
        filters: [
          { field: "pull_request.base.ref", op: "eq", value: "main" },
          { field: "bad field!", op: "eq", value: "x" },
          { field: "x", op: "nope", value: "x" },
        ],
      },
    },
    { schedule: true, api: { id: api, tokenHint: "a1B2" } },
  )!;
  assert.equal(cleaned.schedule, false);
  assert.deepEqual(cleaned.api, { id: api, tokenHint: "a1B2" });
  assert.deepEqual(cleaned.github?.filters, [
    { field: "pull_request.base.ref", op: "eq", value: "main" },
  ]);
  assert.equal(
    cleanRoutineTriggers({ api: { id: "trg_short" } })?.api,
    undefined,
  );
});

test("a task whose schedule is off runs only by its API trigger, with the call's text after its instructions", async (t) => {
  const prompts: string[] = [];
  let now = NOW;
  const scheduler = new Scheduler(temporary(t), {
    isBusy: () => false,
    now: () => now,
    run: async (task) => {
      prompts.push(task.prompt);
      return conversation(task.prompt);
    },
  });
  const api = newRoutineTriggerId();
  assert.throws(
    () => scheduler.save(input({ triggers: { schedule: false } })),
    /Select a trigger\./,
  );
  const saved = scheduler.save(
    input({ triggers: { schedule: false, api: { id: api } } }),
  );
  now = NOW + 2 * HOUR;
  await scheduler.tick();
  assert.deepEqual(prompts, []);
  await scheduler.fireTrigger(api, "api", "  Look at issue 42.  ");
  assert.deepEqual(prompts, ["Triage the new issues.\n\nLook at issue 42."]);
  const runs = scheduler.runs(saved.id);
  assert.equal(runs[0].trigger, "api");
  await assert.rejects(
    scheduler.fireTrigger(newRoutineTriggerId(), "api"),
    /no longer exists/,
  );
  // The hint is the service's: set by it, kept across saves, dropped with
  // the trigger.
  scheduler.setApiTokenHint(api, "Zx9_");
  const resaved = scheduler.save({ ...scheduler.list()[0], name: "Triage 2" });
  assert.equal(resaved.triggers?.api?.tokenHint, "Zx9_");
  const off = scheduler.save({
    ...scheduler.list()[0],
    triggers: { schedule: true },
  });
  assert.equal(off.triggers?.api, undefined);
  scheduler.save({ ...scheduler.list()[0], enabled: false });
  await assert.rejects(scheduler.fireTrigger(api, "api"), /no longer exists/);
});

test("a paused task's trigger does not start it; a Code task keeps its repository and environment", async (t) => {
  const scheduler = new Scheduler(temporary(t), {
    isBusy: () => false,
    now: () => NOW,
    run: async (task) => conversation(task.prompt),
  });
  const api = newRoutineTriggerId();
  const saved = scheduler.save(
    input({
      enabled: false,
      triggers: { schedule: true, api: { id: api } },
      repository: { url: "https://github.com/acme/tool", ref: "main" },
      cloudEnvironmentId: "default",
    }),
  );
  assert.deepEqual(saved.repository, {
    url: "https://github.com/acme/tool",
    ref: "main",
  });
  assert.equal(saved.cloudEnvironmentId, "default");
  await assert.rejects(scheduler.fireTrigger(api, "api"), /paused/);
  assert.throws(
    () =>
      scheduler.save(input({ repository: { url: "file:///etc" } as never })),
    /Choose a repository/,
  );
});

test("a GitHub trigger's event choice: whole webhooks, the merged preset, and conditions cleared with the webhook", () => {
  const opened = { events: ["pull_request.opened"], filters: [] };
  assert.equal(githubEventChoice(opened), "pull_request.opened");
  const all = chooseGitHubEvent(opened, "pull_request");
  assert.equal(all.events.length, 21);
  assert.equal(githubEventChoice(all), "pull_request");
  assert.deepEqual(githubWebhooks(all.events), ["pull_request"]);
  const merged = chooseGitHubEvent(opened, mergedPreset);
  assert.equal(githubEventChoice(merged), mergedPreset);
  assert.deepEqual(merged.events, ["pull_request.closed"]);
  // Leaving the preset drops its condition; another webhook drops the rest.
  assert.deepEqual(
    chooseGitHubEvent(merged, "pull_request.closed").filters,
    [],
  );
  const author = { ...opened, filters: [newRoutineFilter("pr.author")] };
  assert.deepEqual(author.filters[0], {
    field: "pr.author",
    op: "in",
    value: "",
  });
  assert.equal(
    chooseGitHubEvent(author, "pull_request.edited").filters.length,
    1,
  );
  const release = chooseGitHubEvent(author, "release.published");
  assert.deepEqual(release.filters, []);
  assert.equal(githubFilterFields(release.events)[0].value, "release.tag_name");
  assert.deepEqual(newRoutineFilter("pr.draft"), {
    field: "pr.draft",
    op: "eq",
    value: "true",
  });
  assert.equal(
    githubEventChoice({
      events: ["pull_request.opened", "pull_request.closed"],
      filters: [],
    }),
    undefined,
  );
});

test("a GitHub trigger runs on its events when every condition holds", () => {
  const trigger = {
    id: newRoutineTriggerId(),
    repository: "acme/app",
    ...chooseGitHubEvent({ events: [], filters: [] }, mergedPreset),
  };
  assert.equal(
    routineGitHubMatches(trigger, "pull_request.closed", { "pr.merged": true }),
    true,
  );
  assert.equal(
    routineGitHubMatches(trigger, "pull_request.closed", {
      "pr.merged": false,
    }),
    false,
  );
  assert.equal(
    routineGitHubMatches(trigger, "pull_request.opened", { "pr.merged": true }),
    false,
  );
});

test("Auto-fix pull requests is kept for a Code task and dropped for a Chat one", (t) => {
  const scheduler = new Scheduler(temporary(t), {
    isBusy: () => false,
    now: () => NOW,
    run: async (task) => conversation(task.prompt),
  });
  const code = scheduler.save(input({ autoFixPullRequests: true }));
  assert.equal(code.autoFixPullRequests, true);
  const off = scheduler.save({ ...input(), id: code.id });
  assert.equal("autoFixPullRequests" in off, false);
  const chat = scheduler.save(
    input({ name: "Digest", mode: "cowork", autoFixPullRequests: true }),
  );
  assert.equal(chat.autoFixPullRequests, undefined);
});
