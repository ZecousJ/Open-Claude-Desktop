import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduledTaskDialog } from "../../src/collections/routines/ScheduledTaskDialog";
import {
  RoutineSettings,
  routineHasExactTime,
} from "../../src/collections/routines/RoutineSettings";
import {
  draftInput,
  newDraft,
} from "../../src/collections/routines/routine-draft";
import type { RoutineDraft } from "../../src/collections/routines/routine-draft";
import type { Settings } from "../../shared/types";

const now = new Date(2026, 9, 16, 20).getTime();
const settings = {
  providers: [{ id: "p", name: "Connection", model: "Opus", models: [] }],
  activeProviderId: "p",
} as unknown as Settings;
const draft = {
  ...newDraft(now, undefined, "cowork"),
  id: "task",
  name: "Review",
  prompt: "Review the changes.",
  permission: "auto",
  executionLocation: "remote",
} satisfies RoutineDraft;

function editor(patch: Partial<RoutineDraft> = {}) {
  return renderToStaticMarkup(
    createElement(ScheduledTaskDialog, {
      draft: { ...draft, ...patch },
      settings,
      onChange() {},
      onCancel() {},
      onSave: async () => {},
    }),
  );
}

test("the captured Auto editor has its compact footer and a pristine Save changes", () => {
  const html = editor();
  assert.match(html, /aria-label="Edit scheduled task"/);
  assert.match(html, /aria-label="Name" data-no-translate="true"/);
  assert.match(html, /aria-label="Instructions" data-no-translate="true"/);
  assert.match(
    html,
    /task-instructions-bar[^]*?Permissions: Auto[^]*?Model: Default model/,
  );
  assert.match(html, /aria-label="Trigger type: Schedule"/);
  assert.match(html, /<select aria-label="Frequency: Daily"/);
  assert.match(html, /class="task-save" disabled="">Save changes/);
  assert.doesNotMatch(html, /Always allowed|Run at exact time/);
  assert.match(editor({ id: undefined }), /class="task-save">Create</);
  assert.match(
    editor({ id: undefined, duplicateOf: "other" }),
    /class="task-save">Duplicate</,
  );
});

test("nonempty approval inventories remain actionable in all permission modes", () => {
  const alwaysAllowed = [
    { kind: "command" as const, tool: "Run command", pattern: "git status" },
  ];
  for (const permission of ["default", "auto", "bypass"] as const) {
    const html = editor({ permission, alwaysAllowed });
    assert.match(html, /Always allowed/);
    assert.match(html, /Run command \(git status\)/);
    assert.match(html, /aria-label="Remove approval"/);
    const empty = editor({ permission });
    if (permission === "default")
      assert.match(empty, /Approvals you grant during a run appear here/);
    else
      assert.doesNotMatch(
        empty,
        /Always allowed|Approvals you grant during a run appear here/,
      );
  }
});

test("exact time is limited to local desktop recurring schedules", () => {
  for (const kind of [
    "daily",
    "weekdays",
    "weekly",
    "monthly",
    "hourly",
    "custom",
  ] as const) {
    for (const executionLocation of [undefined, "local", "remote"] as const) {
      const candidate = { ...draft, kind, executionLocation };
      assert.equal(routineHasExactTime(candidate, "web"), false);
      assert.equal(
        routineHasExactTime(candidate, "desktop"),
        executionLocation !== "remote",
      );
      const html = renderToStaticMarkup(
        createElement(RoutineSettings, { draft: candidate, onChange() {} }),
      );
      assert.equal(
        html.includes('aria-label="Run at exact time"'),
        executionLocation !== "remote",
      );
    }
  }
  for (const kind of ["manual", "once"] as const) {
    assert.equal(
      routineHasExactTime({ kind, executionLocation: "local" }, "desktop"),
      false,
    );
  }
});

test("hidden remote timing controls retain the stored jitter setting", () => {
  for (const disableJitter of [true, false]) {
    const remote = { ...draft, disableJitter };
    assert.equal(routineHasExactTime(remote, "web"), false);
    assert.equal(
      draftInput(remote, settings, now).disableJitter,
      disableJitter,
    );
  }
});
