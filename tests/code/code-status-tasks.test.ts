import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CodeTurnStatus,
  codeStatus,
  codeStatusMeta,
  taskSummary,
} from "../../src/transcript/CodeTurnStatus";
import type { Turn } from "../../shared/types";

const running = (extra: Partial<Turn> = {}): Turn => ({
  id: "t",
  prompt: "Run it",
  attachments: [],
  createdAt: 1000,
  status: "inProgress",
  items: [],
  ...extra,
});

test("the task segment counts background tasks the original's way", () => {
  assert.equal(taskSummary(1, 0), "1 background task running");
  assert.equal(taskSummary(3, 2), "2 background tasks completed, 3 running");
  assert.equal(taskSummary(0, 1), "1 background task completed");
  assert.equal(
    taskSummary(1, { completed: 0, failed: 2, stopped: 1 }),
    "2 background tasks failed, 1 stopped, 1 running",
  );
  assert.equal(taskSummary(0, 0), undefined);
  assert.equal(
    codeStatusMeta(running(), 5000, 0, 2).tasks,
    "2 background tasks completed",
  );
});

test("the task segment stays while stopping and while an approval waits", () => {
  const turn = running();
  assert.deepEqual(codeStatus(turn, 1000 + 5000, true, 0, {}, 2).meta, [
    "2 background tasks completed",
  ]);
  assert.deepEqual(codeStatus(turn, 1000 + 5000, true, 0).meta, []);
  const stopping = codeStatus(turn, 1000 + 5000, false, 1, { stopping: true });
  assert.equal(stopping.label, "Stopping…");
  assert.ok(stopping.meta.includes("1 background task running"));
});

test("a running turn's task segment is a button that toggles the panel", () => {
  const html = (open: boolean, onOpen?: () => void) =>
    renderToStaticMarkup(
      createElement(CodeTurnStatus, {
        turn: running(),
        awaitingApproval: false,
        runningTasks: 2,
        backgroundOpen: open,
        onOpenBackground: onOpen,
      }),
    );
  assert.match(
    html(true, () => {}),
    /<button[^>]*class="code-status-tasks"[^>]*aria-pressed="true"[^>]*>2 background tasks running<\/button>/,
  );
  // Without a panel to open it stays text.
  assert.doesNotMatch(html(false), /code-status-tasks/);
  assert.match(html(false), /2 background tasks running/);
});

test("after the reply, settled tasks read as a plain line and running ones keep the badge", () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(CodeTurnStatus, {
        turn: running({ status: "completed" }),
        awaitingApproval: false,
        onOpenBackground: () => {},
        ...props,
      }),
    );
  const settled = render({ finishedTasks: { completed: 3, failed: 1 } });
  assert.doesNotMatch(settled, /code-running-badge/);
  assert.match(
    settled,
    /class="code-settled-tasks"[^>]*><span>3 background tasks completed<\/span>, <span class="is-failed">1 failed<\/span><\/button>/,
  );
  const live = render({ backgroundTasks: 1, finishedTasks: 3 });
  assert.match(live, /class="code-running-badge"/);
  assert.doesNotMatch(live, /code-settled-tasks/);
});
