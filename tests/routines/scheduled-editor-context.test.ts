import test from "node:test";
import assert from "node:assert/strict";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import {
  draftInput,
  editDraft,
  newDraft,
  duplicateDraft,
} from "../../src/collections/routines/routine-draft";
import type { Routine } from "../../shared/routines";
const now = Date.UTC(2026, 9, 18, 14);
const settings = fixtureSnapshot({}).settings;
const make = (description?: string): Routine => ({
  ...draftInput(
    { ...newDraft(now), name: "Neutral", prompt: "Neutral instructions" },
    settings,
    now,
  ),
  id: "context",
  createdAt: now,
  updatedAt: now,
  ...(description === undefined ? {} : { description }),
});
test("a hidden absent description is not replaced by instruction prose", () => {
  const draft = {
    ...newDraft(now),
    name: "Neutral",
    prompt: "Do not copy this into description",
  };
  assert.equal(
    Object.hasOwn(draftInput(draft, settings, now), "description"),
    false,
  );
});
test("existing missing, explicitly blank, and nonempty descriptions retain their identity", () => {
  for (const value of [undefined, "", "An actual description"]) {
    const input = draftInput(
      editDraft(make(value), { kind: "manual" }, settings),
      settings,
      now,
    );
    assert.equal(Object.hasOwn(input, "description"), value !== undefined);
    if (value !== undefined) assert.equal(input.description, value);
  }
});
test("a user-cleared description remains an explicit empty update", () => {
  const original = editDraft(
    make("Old description"),
    { kind: "manual" },
    settings,
  );
  const saved = draftInput(
    { ...original, description: "", descriptionProvided: true },
    settings,
    now,
  );
  assert.equal(saved.description, "");
  assert.equal(Object.hasOwn(saved, "description"), true);
  assert.equal(Object.hasOwn(saved, "descriptionProvided"), false);
});
test("partial context work retains the stored execution mode, actual project and folder on edit and duplication", () => {
  for (const mode of ["code", "cowork"] as const) {
    const draft = editDraft(
      { ...make(), mode, cwd: "/workspace", projectId: "p-owned" },
      { kind: "manual" },
      settings,
    );
    for (const current of [draft, duplicateDraft(draft, "Copy")]) {
      const input = draftInput(current, settings, now);
      assert.equal(input.mode, mode);
      assert.equal(input.cwd, "/workspace");
      assert.equal(input.projectId, "p-owned");
      assert.equal(Object.hasOwn(input, "description"), false);
    }
  }
});
