import assert from "node:assert/strict";
import test from "node:test";
import type { Approval, Conversation, Turn } from "../../shared/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CoworkTasksPanel,
  taskNextRun,
  taskPanelTime,
} from "../../src/cowork/CoworkTasksPanel";
import { TaskStatusTile, taskStatus } from "../../src/cowork/task-status";
import { coworkFolderRequest } from "../../shared/cowork-folder-request";
import {
  taskSections,
  tasksPanelLimit,
  tasksPanelWidth,
} from "../../src/cowork/task-sections";

const conversation = (
  id: string,
  patch: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: id,
  mode: "cowork",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  ...patch,
});

test("task panel groups attention, active, and done", () => {
  const sections = taskSections(
    [
      conversation("done"),
      conversation("attention", {
        turns: [
          {
            id: "attention-turn",
            prompt: "",
            attachments: [],
            items: [],
            status: "completed",
            createdAt: 0,
          },
        ],
      }),
      conversation("running", { turns: [{ status: "inProgress" } as Turn] }),
      conversation("pr", { pullRequests: [{ state: "open" }] as never }),
    ],
    [{ conversationId: "attention" }],
    [],
    new Set(),
  );
  assert.deepEqual(
    sections.attention.map((item) => item.id),
    ["attention"],
  );
  assert.deepEqual(
    sections.active.map((item) => item.id),
    ["running", "pr"],
  );
  assert.deepEqual(
    sections.done.map((item) => item.id),
    ["done"],
  );
});

test("status precedence and all six status tiles", () => {
  const failed = conversation("failed", {
    turns: [{ status: "failed" } as Turn],
  });
  assert.equal(taskStatus(failed, true), "needs_input");
  assert.equal(taskStatus(failed), "errored");
  assert.equal(
    taskStatus(
      conversation("running", { turns: [{ status: "inProgress" } as Turn] }),
    ),
    "running",
  );
  assert.equal(
    taskStatus(
      conversation("review", {
        turns: [{ status: "completed" } as Turn],
        unread: true,
      }),
    ),
    "ready_review",
  );
  assert.equal(
    taskStatus(
      conversation("done", { turns: [{ status: "completed" } as Turn] }),
    ),
    "done",
  );
  assert.equal(taskStatus(conversation("idle")), "idle");
  for (const status of [
    "needs_input",
    "errored",
    "running",
    "ready_review",
    "done",
    "idle",
  ] as const) {
    assert.match(
      renderToStaticMarkup(createElement(TaskStatusTile, { status })),
      new RegExp(`cowork-status-${status}`),
    );
  }
});

test("task panel empty state, filter, resize and View all", () => {
  const render = (conversations: Conversation[]) =>
    renderToStaticMarkup(
      createElement(CoworkTasksPanel, {
        conversations,
        approvals: [],
        onOpen: () => {},
        onRoutine: () => {},
        onClose: () => {},
        onError: () => {},
      }),
    );
  const empty = render([]);
  assert.match(empty, /Loading\.\.\./);
  assert.doesNotMatch(empty, /No tasks yet/);
  assert.match(empty, /Filter tasks/);
  assert.match(empty, /Resize tasks panel/);
  const populated = render(
    Array.from({ length: 8 }, (_, index) => conversation(`task${index}`)),
  );
  assert.match(populated, /View all/);
  assert.equal((populated.match(/class="cowork-panel-row"/g) ?? []).length, 6);
});

test("folder cards accept only folder-only permissions and reject malformed paths", () => {
  const request = (permissions: unknown): Approval =>
    ({
      method: "item/permissions/requestApproval",
      params: { permissions, reason: "Read reports" },
    }) as Approval;
  const context = { mode: "cowork" } as const;
  assert.deepEqual(
    coworkFolderRequest(
      request({
        fileSystem: { read: ["/reports"], write: ["/reports", "C:\\Work"] },
      }),
      context,
    ),
    { paths: ["/reports", "C:\\Work"], reason: "Read reports" },
  );
  assert.equal(
    coworkFolderRequest(request({ fileSystem: { read: "/reports" } }), context),
    undefined,
  );
  assert.equal(
    coworkFolderRequest(
      request({ fileSystem: { read: ["relative"] } }),
      context,
    ),
    undefined,
  );
  assert.equal(
    coworkFolderRequest(
      request({
        fileSystem: { read: ["/reports"] },
        network: { enabled: true },
      }),
      context,
    ),
    undefined,
  );
  assert.equal(
    coworkFolderRequest(request({ fileSystem: { read: ["/reports"] } }), {
      mode: "code",
    }),
    undefined,
  );
});

test("task panel filters kinds and caps visible rows", () => {
  const rows = Array.from({ length: tasksPanelLimit + 2 }, (_, index) =>
    conversation(`c${index}`, { mode: index === 0 ? "code" : "cowork" }),
  );
  const sections = taskSections(rows, [], [], new Set(["code"]));
  assert.equal(sections.done.length, 1);
  assert.equal(tasksPanelLimit, 6);
  assert.equal(tasksPanelWidth(100), 240);
  assert.equal(tasksPanelWidth(800), 560);
});

test("panel dates use minute and hour boundaries and ongoing dates use the six-hour boundary", () => {
  const now = Date.UTC(2026, 9, 16, 12);
  assert.equal(taskPanelTime(0, now, "en-US"), "");
  assert.equal(taskPanelTime(now - 119_000, now, "en-US"), "1m ago");
  assert.equal(taskNextRun(now + 5 * 60_000, now, "en-US"), "in 5m");
  assert.equal(taskNextRun(now + 2 * 3600_000, now, "en-US"), "in 2h");
  assert.equal(
    taskNextRun(now + 6 * 3600_000, now, "en-US"),
    new Date(now + 6 * 3600_000).toLocaleString("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }),
  );
});

test("scheduled runs stay in Ongoing except requests needing attention", () => {
  const scheduled = { id: "routine" } as never;
  const rows = [
    conversation("run", { scheduledTaskId: "routine", unread: true }),
    conversation("waiting", {
      scheduledTaskId: "routine",
      linkedToComputer: true,
    }),
  ];
  const sections = taskSections(
    rows,
    [{ conversationId: "waiting" }],
    [scheduled],
    new Set(),
  );
  assert.deepEqual(
    sections.attention.map((item) => item.id),
    ["waiting"],
  );
  assert.deepEqual(sections.done, []);
  assert.deepEqual(
    taskSections(
      rows,
      [{ conversationId: "waiting" }],
      [scheduled],
      new Set(["dispatch"]),
    ).attention.map((item) => item.id),
    ["waiting"],
  );
});
