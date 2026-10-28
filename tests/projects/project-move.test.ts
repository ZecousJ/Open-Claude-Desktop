import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation, Project, Snapshot } from "../../shared/types";
import {
  moveProjectChats,
  projectMoveMessage,
  createMoveProject,
} from "../../src/collections/projects/project-move";
import {
  moveTargets,
  ProjectMoveList,
  MoveToProjectModal,
} from "../../src/collections/projects/MoveToProjectModal";
import { bulkEntries } from "../../src/sidebar/BulkRowMenu";
import { projectEntries } from "../../src/sidebar/project-entries";

const row = (id: string, extra: Partial<Conversation> = {}) =>
  ({
    id,
    title: id,
    mode: "chat",
    turns: [],
    ...extra,
  }) as Conversation;
const project = (id: string, extra: Partial<Project> = {}) =>
  ({
    id,
    name: id,
    description: "",
    instructions: "",
    createdAt: 1,
    ...extra,
  }) as Project;
const projects = [project("Alpha"), project("Beta")];
const list = (extra: Partial<Parameters<typeof ProjectMoveList>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ProjectMoveList, {
      projects,
      query: "",
      onPick() {},
      onCreate() {},
      ...extra,
    }),
  );

test("move targets exclude the current and archived projects, search case-insensitively and limit to 30", () => {
  assert.deepEqual(
    moveTargets(
      [...projects, project("Old", { archivedAt: 2 })],
      "",
      "Alpha",
    ).map((value) => value.id),
    ["Beta"],
  );
  assert.deepEqual(
    moveTargets(projects, "ALP").map((value) => value.id),
    ["Alpha"],
  );
  assert.equal(
    moveTargets(
      Array.from({ length: 40 }, (_, index) => project(String(index))),
      "",
    ).length,
    30,
  );
});

test("the picker renders empty, loading and error states instead of selectable projects", () => {
  assert.match(list({ projects: [] }), /No projects yet/);
  assert.match(
    list({ projects: [], currentProjectId: "Alpha" }),
    /No other projects/,
  );
  const loading = list({ loading: true });
  assert.equal((loading.match(/height:26px/g) ?? []).length, 4);
  assert.doesNotMatch(loading, /role="option"/);
  assert.match(list({ hasError: true }), /Failed to load projects/);
});

test("search offers direct creation, shared projects carry the tag and accessible name", () => {
  const html = list({ query: "Gamma" });
  assert.match(html, /aria-label="Create project Gamma"/);
  assert.doesNotMatch(html, /Alpha|Beta|New project/);
  assert.match(html, />Create /);
  const shared = list({ projects: [{ ...project("Team"), isPrivate: false }] });
  assert.match(shared, /aria-label="Team, Shared"/);
  assert.match(shared, /Shared<\/small>/);
  assert.doesNotMatch(list({ creating: true }), /<button(?![^>]*disabled)/);
});

test("modal copy uses the surface's noun and explains current membership", () => {
  const modal = (rows: Conversation[]) =>
    renderToStaticMarkup(
      createElement(MoveToProjectModal, {
        rows,
        projects,
        onClose() {},
        onPick() {},
        onError() {},
        onCreate: async () => project("Created"),
      }),
    );
  assert.match(modal([row("a")]), /Move to project/);
  assert.match(modal([row("a")]), /Select a project\./);
  assert.match(
    modal([row("a", { projectId: "Alpha" })]),
    /This chat is in <span class="project-move-current">Alpha<\/span>\. Select a different project/,
  );
  assert.match(modal([row("a"), row("b")]), /Move 2 chats/);
  assert.match(
    modal([row("a", { mode: "code" }), row("b", { mode: "code" })]),
    /Move 2 sessions/,
  );
});

test("move notifications count successes and distinguish chats from sessions", () => {
  assert.equal(projectMoveMessage([row("a")], 1, "Alpha"), "Moved to Alpha");
  assert.equal(
    projectMoveMessage([row("a"), row("b")], 2, "Alpha"),
    "2 chats moved to Alpha",
  );
  assert.equal(
    projectMoveMessage([row("a"), row("b")], 1, "Alpha"),
    "1 chat moved to Alpha",
  );
  assert.equal(
    projectMoveMessage(
      [row("a", { mode: "code" }), row("b", { mode: "code" })],
      2,
      "Alpha",
    ),
    "2 sessions moved to Alpha",
  );
});

test("moving keeps partial successes, reports failures and updates the active composer's project and folder", async () => {
  const updated: string[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  const context: string[] = [];
  const failed = await moveProjectChats(
    {
      activeId: "a",
      upsert: (value) => {
        updated.push(value.id);
      },
      report: (error) => {
        errors.push((error as Error).message);
      },
      setProjectId: (value) => {
        context.push(String(value));
      },
      setCwd: (value) => {
        context.push(String(value));
      },
    },
    [row("a"), row("b"), row("c")],
    project("Alpha", { cwd: "/workspace" }),
    async (id, patch) => {
      assert.equal(patch.projectId, "Alpha");
      if (id === "b") throw Error("offline");
      return row(id, { projectId: "Alpha" });
    },
    (message) => {
      notices.push(message);
      return 0;
    },
  );
  assert.deepEqual(failed, ["b"]);
  assert.deepEqual(updated, ["a", "c"]);
  assert.deepEqual(context, ["Alpha", "/workspace"]);
  assert.deepEqual(notices, ["2 chats moved to Alpha"]);
  assert.deepEqual(errors, ["Couldn’t move 1 chat. You can try again."]);
});

test("a completely failed move does not show a success notification", async () => {
  let notices = 0;
  const failed = await moveProjectChats(
    {
      activeId: undefined,
      upsert() {},
      report() {},
      setProjectId() {},
      setCwd() {},
    },
    [row("a")],
    project("Alpha"),
    async () => {
      throw Error("offline");
    },
    () => ++notices,
  );
  assert.deepEqual(failed, ["a"]);
  assert.equal(notices, 0);
});

test("creation saves the typed name directly with blank details before moving the selected chats", async () => {
  let snapshot = { projects: [] } as unknown as Snapshot;
  const calls: string[] = [];
  const saved = await createMoveProject(
    {
      setSnapshot(change) {
        snapshot = (typeof change === "function" ? change(snapshot) : change)!;
      },
    },
    "Typed project",
    async (value) => {
      assert.equal(value.name, "Typed project");
      assert.equal(value.description, "");
      assert.equal(value.instructions, "");
      assert.ok(value.id);
      calls.push("create");
      return value;
    },
  );
  assert.deepEqual(snapshot.projects, [saved]);
  await moveProjectChats(
    {
      activeId: undefined,
      upsert() {},
      report() {},
      setProjectId() {},
      setCwd() {},
    },
    [row("a"), row("b")],
    saved,
    async (id, patch) => {
      assert.equal(patch.projectId, saved.id);
      calls.push(id);
      return row(id, { projectId: saved.id });
    },
    () => 0,
  );
  assert.deepEqual(calls, ["create", "a", "b"]);
});

test("sidebar bulk Add/Change opens the shared picker without clearing selection until the move", () => {
  const picked: string[] = [];
  let done = false;
  const build = (rows: Conversation[]) =>
    bulkEntries(
      rows,
      {
        onTogglePin() {},
        onToggleUnread() {},
        onToggleArchive() {},
        onMoveMany: (values) => picked.push(...values.map((value) => value.id)),
      },
      () => {
        done = true;
      },
    );
  const add = build([row("a"), row("b")]).find(
    (entry) => "label" in entry && entry.label === "Add to project",
  );
  assert.ok(add && "label" in add);
  add.onSelect?.();
  assert.deepEqual(picked, ["a", "b"]);
  assert.equal(done, false);
  assert.ok(
    build([
      row("a", { projectId: "Alpha" }),
      row("b", { projectId: "Alpha" }),
    ]).some((entry) => "label" in entry && entry.label === "Change project"),
  );
  assert.ok(
    build([
      row("a", { projectId: "Alpha" }),
      row("b", { projectId: "Beta" }),
    ]).some((entry) => "label" in entry && entry.label === "Add to project"),
  );
  assert.ok(
    !build([row("a", { incognito: true })]).some(
      (entry) => "label" in entry && entry.label === "Add to project",
    ),
  );
});

test("official chat-row Add/Change/search/create/Remove are preserved, not confused with the local-session submenu", () => {
  const entries = projectEntries(row("a", { projectId: "Alpha" }), projects, {
    moveToProject() {},
    newProject() {},
  });
  assert.equal(entries.length, 2);
  assert.ok("label" in entries[0]);
  assert.equal(entries[0].label, "Change project");
  assert.equal(entries[0].searchable, "Search or create a project");
  assert.equal(entries[0].searchCreate?.idle, "New project");
  assert.ok("label" in entries[1]);
  assert.equal(entries[1].label, "Remove from project");
});
