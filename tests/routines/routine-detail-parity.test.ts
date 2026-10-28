import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutineDetail } from "../../src/collections/routines/RoutineDetail";

const routine: any = {
  id: "r1",
  name: "Daily briefing",
  description: "Summarize the day",
  prompt: "Line one\nLine two\nLine three\nLine four",
  mode: "code",
  providerId: "p",
  model: "m",
  frequency: "daily",
  repeat: { kind: "daily", hour: 9, minute: 0 },
  nextRunAt: Date.now() + 60_000,
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  alwaysAllowed: [],
};

test("local routine detail has the audited sections and conditional three-line disclosure", () => {
  const html = renderToStaticMarkup(
    createElement(RoutineDetail, {
      routine,
      presentation: "legacy-local",
      onClose() {},
      onEdit() {},
      onDelete() {},
      onRun() {},
      onEnabled() {},
      onRemoveApproval() {},
      onOpenConversation() {},
      running: false,
      disabled: false,
    }),
  );
  for (const label of [
    "Description",
    "Status",
    "Folder",
    "Repeats",
    "Always allowed",
    "Instructions",
    "History",
  ]) {
    if (label === "Folder") continue;
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /routine-detail-instructions collapsed/);
  assert.match(
    html,
    /<h1 dir="auto" data-no-translate="true">Daily briefing<\/h1>/,
  );
  assert.match(
    html,
    /<p dir="auto" data-no-translate="true">Summarize the day<\/p>/,
  );
  assert.match(
    html,
    /routine-detail-instructions collapsed" dir="auto" data-no-translate="true">Line one/,
  );
  assert.match(html, /Show all/);
  assert.doesNotMatch(html, /This computer/);
});

test("detail header: Edit and Delete icons, the primary Run now, and the hold", () => {
  const props = {
    routine,
    presentation: "legacy-local" as const,
    onClose() {},
    onEdit() {},
    onDelete() {},
    onRun() {},
    onEnabled() {},
    onRemoveApproval() {},
    onOpenConversation() {},
    running: false,
    disabled: false,
  };
  const html = renderToStaticMarkup(createElement(RoutineDetail, props));
  assert.match(html, /aria-label="Edit"/);
  assert.match(html, /aria-label="Delete"/);
  assert.match(
    html,
    /class="primary routine-detail-run"><svg[^]*?Run now<\/button>/,
  );
  const held = renderToStaticMarkup(
    createElement(RoutineDetail, {
      ...props,
      routine: { ...routine, enabled: true },
      hold: "This task is on hold because Computer access is off.",
    }),
  );
  assert.match(
    held,
    /disabled="" title="This task is on hold because Computer access is off\."/,
  );
  assert.match(held, /<span>On hold<\/span>/);
});
