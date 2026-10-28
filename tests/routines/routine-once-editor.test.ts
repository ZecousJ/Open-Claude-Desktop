import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutineEditor } from "../../src/collections/routines/RoutineEditor";
import { ScheduledTaskDialog } from "../../src/collections/routines/ScheduledTaskDialog";
import { AlwaysAllowed } from "../../src/collections/routines/RoutinePermission";
import { newDraft } from "../../src/collections/routines/routine-draft";
import {
  draftInput,
  editDraft,
} from "../../src/collections/routines/routine-draft";

const settings: any = {
  providers: [{ id: "p", model: "m", name: "P" }],
  activeProviderId: "p",
};
const NOW = Date.now();

function render(component: any, props: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(component, {
      settings,
      onChange() {},
      onCancel() {},
      onSave: async () => {},
      onChooseFolder: async () => null,
      ...props,
    }),
  );
}

test("the desktop editor offers One-time with a Run at date-time field and a Permissions row", () => {
  const draft = {
    ...newDraft(NOW, undefined, "code"),
    name: "Remind",
    kind: "once" as const,
  };
  const html = render(RoutineEditor, { draft });
  assert.match(html, /One-time/);
  assert.match(html, /type="datetime-local"/);
  assert.match(html, /aria-label="Run at"/);
  assert.match(html, /Runs once on /);
  assert.match(html, /Permissions/);
  // A new task starts on Auto.
  assert.match(html, /Automatically approve/);
  // A moment that has passed shows the original's note.
  const past = render(RoutineEditor, {
    draft: { ...draft, at: NOW - 3600_000 },
  });
  assert.match(past, /Choose a time in the future\./);
});

test("the web dialog lists One-time and shows the chosen permission with its Always allowed list", () => {
  const draft = {
    ...newDraft(NOW, undefined, "cowork"),
    name: "Remind",
    prompt: "Say hi",
    kind: "once" as const,
    permission: "default" as const,
    alwaysAllowed: [
      { kind: "command" as const, tool: "Run command", pattern: "npm test" },
    ],
  };
  const html = render(ScheduledTaskDialog, { draft });
  assert.match(html, /type="datetime-local"/);
  assert.match(html, /Permissions/);
  assert.match(html, /Manually approve/);
  assert.match(html, /Claudex pauses so you can approve each action\./);
  assert.match(html, /Always allowed/);
  assert.match(html, /Run command \(npm test\)/);
  assert.match(html, /Remove approval/);
});

test("Always allowed shows three entries, then Show all, and an empty note", () => {
  const items = ["a", "b", "c", "d"].map((pattern) => ({
    kind: "command" as const,
    tool: "Run command",
    pattern,
  }));
  const html = renderToStaticMarkup(
    createElement(AlwaysAllowed, { items, onRemove() {}, className: "x" }),
  );
  assert.match(html, /Show all/);
  assert.ok(!html.includes("Run command (d)"));
  const empty = renderToStaticMarkup(
    createElement(AlwaysAllowed, { items: [], onRemove() {}, className: "x" }),
  );
  assert.match(empty, /Approvals you grant during a run appear here\./);
});

test("the local editor matches scheduled-task parity copy and frequency choices", () => {
  const html = render(RoutineEditor, {
    draft: {
      ...newDraft(NOW, undefined, "code"),
      name: "Daily Briefing",
      description: "A briefing",
      prompt: "Read my inbox",
    },
  });
  assert.match(html, /placeholder="daily-briefing"/);
  assert.match(html, /Will be saved as/);
  assert.match(html, /Frequency/);
});

test("both editors warn immediately for Auto and Skip all approvals", () => {
  for (const component of [RoutineEditor, ScheduledTaskDialog]) {
    const draft = newDraft(NOW);
    const auto = render(component, { draft: { ...draft, permission: "auto" } });
    assert.match(auto, /routine-auto-notice/);
    assert.match(
      auto,
      /Claudex will work and use connectors without pausing for approval/,
    );
    assert.match(auto, /See safe use tips/);
    const bypass = render(component, {
      draft: { ...draft, permission: "bypass" },
    });
    assert.match(bypass, /routine-skip-notice/);
    assert.match(bypass, /permission-mode-notice warning/);
    assert.match(bypass, /Claudex never pauses, even for unsafe actions/);
    assert.doesNotMatch(bypass, /will work and use connectors/);
    assert.doesNotMatch(
      render(component, { draft: { ...draft, permission: "default" } }),
      /routine-(auto|skip)-notice/,
    );
  }
});

test("exact-time is offered for recurring tasks and Advanced settings starts closed", () => {
  for (const component of [RoutineEditor, ScheduledTaskDialog]) {
    const draft = newDraft(NOW);
    const html = render(component, { draft });
    assert.match(
      html,
      /role="switch" aria-label="Run at exact time" aria-checked="false"/,
    );
    assert.match(
      html,
      /randomized delay of several minutes for server performance/,
    );
    assert.match(html, /aria-expanded="false"[^>]*>Advanced settings/);
    assert.doesNotMatch(html, /Notify me when this task finishes/);
    for (const kind of ["manual", "once"])
      assert.doesNotMatch(
        render(component, { draft: { ...draft, kind } }),
        /Run at exact time/,
      );
  }
});

test("routine drafts retain exact-time and finish-notification preferences", () => {
  const draft = {
    ...newDraft(NOW),
    name: "briefing",
    prompt: "Summarize",
    disableJitter: true,
    notifyOnCompletion: { push: true, email: false, slack: false },
  };
  const input = draftInput(draft, settings, NOW);
  assert.equal(input.disableJitter, true);
  assert.deepEqual(input.notifyOnCompletion, draft.notifyOnCompletion);
  const edited = editDraft(
    { ...input, id: "task", createdAt: NOW, updatedAt: NOW },
    input.repeat!,
    settings,
  );
  assert.equal(edited.disableJitter, true);
  assert.deepEqual(edited.notifyOnCompletion, draft.notifyOnCompletion);
});
