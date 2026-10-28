import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement, createRef } from "react";
import type { Project } from "../../shared/types";
import type { ProjectKnowledge } from "../../shared/collections-api";
import type { Routine } from "../../shared/routines";
import { ProjectHubCards } from "../../src/collections/projects/ProjectHubCards";
import { atomicChatDom } from "../support/atomic-chat-dom";

const project: Project = {
  id: "project",
  name: "Actual project",
  description: "",
  instructions: "",
  createdAt: 1,
};
const knowledge = (count: number): ProjectKnowledge => ({
  files: Array.from({ length: count }, (_, index) => ({
    name: `note-${index}.txt`,
    bytes: 1,
    addedAt: 1,
  })),
  bytes: count,
  limit: 10000,
  fileLimit: 10000,
});
async function environment(count = 0) {
  const env = await atomicChatDom({
    listProjectKnowledge: async () => knowledge(count),
    memoryStatus: async () => ({
      available: false,
      reason: "unsupported",
      synthesizing: false,
      allowed: { searchChats: true, generate: true },
      prefs: { searchChats: true, generate: true },
    }),
  });
  const style = env.document.createElement("style");
  style.textContent = `${readFileSync("src/collections/projects/project-hub-cards.css", "utf8")}
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  `;
  env.document.head.append(style);
  return env;
}
const props = () => ({
  project,
  tasks: [] as Routine[],
  onInstructions() {},
  onAddTask(_anchor: HTMLButtonElement) {},
  onUnlinkTask: async (_routine: Routine) => {},
  onError: assert.fail,
  memoryAction: createRef<((anchor?: HTMLButtonElement) => void) | undefined>(),
  scheduling: true,
});
async function click(
  env: Awaited<ReturnType<typeof environment>>,
  node: Element,
) {
  await act(async () => {
    (node as HTMLElement).click();
  });
}

test("shell 52 empty quiet rail uses full-row controls and keeps descriptive copy out of its visible rows", async () => {
  const env = await environment();
  let edits = 0;
  try {
    await env.render(
      createElement(ProjectHubCards, {
        ...props(),
        onInstructions() {
          edits++;
        },
      }),
    );
    const rows = Array.from(
      env.document.querySelectorAll<HTMLElement>(".prj-hub-card"),
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.querySelector(".prj-hub-card-title")?.textContent),
      ["Instructions", "Context", "Scheduled"],
    );
    for (const row of rows) {
      assert.equal(env.window.getComputedStyle(row).height, "53px");
      assert.equal(env.window.getComputedStyle(row).marginInline, "-12px");
      const opener =
        row.querySelector<HTMLButtonElement>(".prj-hub-card-main")!;
      assert.equal(env.window.getComputedStyle(opener).position, "absolute");
      assert.equal(env.window.getComputedStyle(opener).width, "100%");
      const detail = row.querySelector<HTMLElement>(".prj-hub-card-meta")!;
      assert.ok(detail.classList.contains("sr-only"));
      assert.equal(env.window.getComputedStyle(detail).position, "absolute");
      const add = row.querySelector<HTMLButtonElement>(".prj-hub-add")!;
      assert.equal(add.textContent, "Add");
      assert.equal(
        env.window.getComputedStyle(add).backgroundColor,
        "rgba(0, 0, 0, 0)",
      );
    }
    await click(env, rows[0].querySelector(".prj-hub-card-main")!);
    await click(env, rows[0].querySelector(".prj-hub-add")!);
    assert.equal(edits, 2);
  } finally {
    await env.clean();
  }
});

test("shell 52 populated counts stay inline and actions use actual project data", async () => {
  const env = await environment(2);
  let edits = 0;
  const anchors: HTMLButtonElement[] = [];
  try {
    await env.render(
      createElement(ProjectHubCards, {
        ...props(),
        project: { ...project, instructions: "Keep this actual instruction" },
        tasks: [{ id: "routine", name: "Actual recurring task" }] as Routine[],
        onInstructions() {
          edits++;
        },
        onAddTask(anchor) {
          anchors.push(anchor);
        },
      }),
    );
    const rows = Array.from(
      env.document.querySelectorAll<HTMLElement>(".prj-hub-card"),
    );
    const edit = rows[0].querySelector<HTMLButtonElement>(".prj-hub-add")!;
    assert.equal(edit.textContent, "Edit");
    assert.equal(
      rows[0].querySelector(".prj-hub-card-meta")?.textContent,
      "Keep this actual instruction",
    );
    const count = rows[1].querySelector<HTMLElement>(".prj-hub-card-meta")!;
    assert.equal(count.textContent, "2 files");
    assert.equal(count.classList.contains("sr-only"), false);
    assert.equal(
      env.window.getComputedStyle(count.parentElement!).display,
      "flex",
    );
    const tasks = rows[2].querySelector<HTMLElement>(".prj-hub-card-meta")!;
    assert.equal(tasks.textContent, "1 scheduled task");
    assert.equal(tasks.classList.contains("sr-only"), false);
    await click(env, edit);
    const addTask = rows[2].querySelector<HTMLButtonElement>(".prj-hub-add")!;
    await click(env, addTask);
    assert.equal(edits, 1);
    assert.equal(anchors.length, 1);
    assert.ok(anchors[0] === addTask);
    await click(env, rows[2].querySelector(".prj-hub-card-main")!);
    assert.equal(
      env.document.querySelector('[role="dialog"] h2')?.textContent,
      "Scheduled tasks",
    );
    assert.ok(
      env.document
        .querySelector(".prj-hub-task-list")
        ?.textContent?.includes("Actual recurring task"),
    );
  } finally {
    await env.clean();
  }
});
