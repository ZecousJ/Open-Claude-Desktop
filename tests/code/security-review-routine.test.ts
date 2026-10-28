import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import type { ScheduleInput } from "../../shared/types";
import {
  newDraft,
  draftInput,
  editDraft,
} from "../../src/collections/routines/routine-draft";
import { repeatOf } from "../../shared/routine-labels";
import {
  routineTemplates,
  securityReviewTemplate,
} from "../../src/collections/routines/routine-templates";
import { securityReviewInstructions } from "../../shared/security-review";
import type { Settings } from "../../shared/types";

const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();
const task = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  name: "Security review",
  prompt: "Review it.",
  mode: "code",
  providerId: "p",
  model: "m",
  frequency: "weekly",
  nextRunAt: NOW,
  enabled: true,
  cwd: os.tmpdir(),
  ...overrides,
});

test("a security review routine keeps its mark across edits and reloads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-review-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    isBusy: () => false,
    run: async () => {
      throw new Error("not run");
    },
    now: () => NOW,
  };
  const scheduler = new Scheduler(root, options);
  const saved = scheduler.save({ ...task(), securityReview: true });
  assert.equal(saved.securityReview, true);
  assert.equal(
    scheduler.save({ ...task(), id: saved.id, securityReview: true })
      .securityReview,
    true,
  );
  assert.equal(new Scheduler(root, options).list()[0]?.securityReview, true);
  // An edit that leaves the mark out clears it.
  assert.equal(
    scheduler.save({ ...task(), id: saved.id }).securityReview,
    undefined,
  );
  assert.throws(
    () => scheduler.save({ ...task(), securityReview: "yes" as never }),
    /Invalid security review/,
  );
  // It reviews a folder's branch, so the folder has to be named.
  assert.throws(
    () => scheduler.save({ ...task(), cwd: undefined, securityReview: true }),
    /Choose the folder/,
  );
});

test("the Security review template starts a weekly review of a folder", () => {
  assert.ok(routineTemplates.includes(securityReviewTemplate));
  assert.equal(securityReviewTemplate.securityReview, true);
  assert.equal(securityReviewTemplate.repeat.kind, "weekly");
  assert.equal(securityReviewTemplate.instructions, securityReviewInstructions);
  const draft = newDraft(NOW, securityReviewTemplate);
  assert.equal(draft.securityReview, true);
  assert.equal(draft.name, "Security review");
  assert.equal(draft.prompt, securityReviewInstructions);
  const settings = {
    providers: [{ id: "p", model: "m" }],
    activeProviderId: "p",
  } as unknown as Settings;
  assert.equal(draftInput(draft, settings, NOW).securityReview, true);
  // Other templates carry no mark, and neither do their drafts.
  const other = routineTemplates.find((value) => !value.securityReview)!;
  assert.equal(
    draftInput(newDraft(NOW, other), settings, NOW).securityReview,
    undefined,
  );
  // Editing a saved one keeps it.
  const routine = {
    ...task(),
    id: "r",
    createdAt: NOW,
    updatedAt: NOW,
    securityReview: true,
    repeat: securityReviewTemplate.repeat,
  };
  const edited = editDraft(routine, repeatOf(routine));
  assert.equal(edited.securityReview, true);
});
