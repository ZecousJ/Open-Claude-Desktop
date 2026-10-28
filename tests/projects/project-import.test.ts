import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "../../shared/types";
import { importChatProjects } from "../../electron/projects/project-create";
import { ProjectKnowledgeStore } from "../../electron/projects/project-knowledge";
import { importableChatProjects } from "../../shared/project-import";
import { guardCall } from "../../runner/src/method-guard";
import { useElectronShim } from "../runner/runner-core-support.test.ts";

useElectronShim();
const { registerWorkspaceHandlers } =
  await import("../../electron/ipc/workspace");

const project: Project = {
  id: "chat-a",
  name: "Research",
  description: "Original",
  instructions: "  Be concise.  ",
  createdAt: 1,
};

function fixture(context: import("node:test").TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-project-import-"),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = path.join(root, "destination");
  fs.mkdirSync(location);
  const projects = [
    project,
    { ...project, id: "chat-b", name: "Garden", instructions: "Water weekly." },
  ];
  const knowledge = new ProjectKnowledgeStore(root, () => projects);
  knowledge.add(project.id, [
    { name: "notes.txt", data: Buffer.from("research") },
  ]);
  knowledge.add("chat-b", [{ name: "notes.txt", data: Buffer.from("garden") }]);
  return { root, location, projects, knowledge };
}

test("only active Chat context projects are offered, not Cowork or SSH folders", () => {
  assert.deepEqual(
    importableChatProjects([
      project,
      { ...project, id: "cowork", cwd: "/work" },
      { ...project, id: "archived", archivedAt: 1 },
      { ...project, id: "example", isStarterProject: true },
      { ...project, id: "ssh", environment: { kind: "ssh", hostId: "host" } },
    ]),
    [project],
  );
});

test("imports independent knowledge bytes and instructions into a new folder", (context) => {
  const { root, location, projects, knowledge } = fixture(context);
  const imported = importChatProjects(
    root,
    projects,
    [project.id],
    location,
    "Imported",
  );
  assert.equal(imported.cwd, path.join(location, "Imported"));
  assert.equal(imported.instructions, "Be concise.");
  assert.deepEqual(fs.readdirSync(imported.cwd), ["notes.txt"]);
  assert.equal(
    fs.readFileSync(path.join(imported.cwd, "notes.txt"), "utf8"),
    "research",
  );
  fs.writeFileSync(path.join(imported.cwd, "notes.txt"), "changed");
  assert.equal(
    fs.readFileSync(
      path.join(knowledge.folder(project.id), "notes.txt"),
      "utf8",
    ),
    "research",
  );
  assert.equal(project.instructions, "  Be concise.  ");
  assert.throws(() =>
    importChatProjects(root, projects, [project.id], location, "Imported"),
  );
  assert.equal(
    fs.readFileSync(path.join(imported.cwd, "notes.txt"), "utf8"),
    "changed",
  );
});

test("multiple sources retain conflicting file names and both instruction snapshots", (context) => {
  const { root, location, projects } = fixture(context);
  const imported = importChatProjects(
    root,
    projects,
    [project.id, "chat-b"],
    location,
    "Combined",
  );
  assert.equal(
    imported.instructions,
    "# Research\n\nBe concise.\n\n# Garden\n\nWater weekly.",
  );
  assert.equal(
    fs.readFileSync(path.join(imported.cwd, project.id, "notes.txt"), "utf8"),
    "research",
  );
  assert.equal(
    fs.readFileSync(path.join(imported.cwd, "chat-b", "notes.txt"), "utf8"),
    "garden",
  );
});

test("rejects invalid, stale, duplicate or oversized imports before creating a folder", (context) => {
  const { root, location, projects } = fixture(context);
  for (const ids of [[], [project.id, project.id], ["gone"], ["../outside"]])
    assert.throws(() =>
      importChatProjects(root, projects, ids, location, "Invalid"),
    );
  assert.throws(() =>
    importChatProjects(root, projects, [project.id], location, "../outside"),
  );
  assert.throws(() =>
    importChatProjects(
      root,
      [{ ...project, cwd: "/work" }],
      [project.id],
      location,
      "Invalid",
    ),
  );
  assert.throws(() =>
    importChatProjects(
      root,
      [{ ...project, instructions: "x".repeat(100001) }],
      [project.id],
      location,
      "Invalid",
    ),
  );
  assert.deepEqual(fs.readdirSync(location), []);
});

test("symlink knowledge directories are refused and partially copied imports roll back", (context) => {
  const { root, location, projects, knowledge } = fixture(context);
  const source = knowledge.folder("chat-b");
  fs.renameSync(source, `${source}-moved`);
  fs.symlinkSync(`${source}-moved`, source, "dir");
  assert.throws(() =>
    importChatProjects(
      root,
      projects,
      [project.id, "chat-b"],
      location,
      "Broken",
    ),
  );
  assert.deepEqual(fs.readdirSync(location), []);
  assert.equal(
    fs.readFileSync(
      path.join(knowledge.folder(project.id), "notes.txt"),
      "utf8",
    ),
    "research",
  );
});

test("saveProject IPC imports trusted profile context, pins the project, and never moves chats", (context) => {
  const { root, location, projects } = fixture(context);
  const conversations = [{ id: "chat", projectId: project.id }];
  let flushed = 0;
  const store = {
    root,
    projects: [...projects],
    conversations,
    flush() {
      flushed++;
    },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const selectedFolders = new Set([location]);
  registerWorkspaceHandlers((name, handler) => handlers.set(name, handler), {
    store,
    selectedFolders,
    selectedAttachments: new Map(),
    allowedFolder(folder?: string) {
      if (folder && !selectedFolders.has(folder)) throw new Error("Not chosen");
    },
  } as unknown as Parameters<typeof registerWorkspaceHandlers>[1]);
  const save = handlers.get("saveProject")!;
  const configured = save({
    ...project,
    name: "N".repeat(200),
    icon: "Beaker",
    color: "blue-deep",
    defaultModel: "test-model",
    defaultProviderId: "provider",
    defaultEffort: "medium",
    isStarterProject: true,
  });
  assert.equal(configured.icon, "Beaker");
  assert.equal(configured.name, "N".repeat(200));
  assert.throws(() => save({ ...project, name: "N".repeat(201) }));
  assert.equal(configured.color, "blue-deep");
  assert.equal(configured.defaultModel, "test-model");
  assert.equal(configured.defaultProviderId, "provider");
  assert.equal(configured.defaultEffort, "medium");
  assert.equal(configured.isStarterProject, true);
  assert.throws(() => save({ ...project, defaultEffort: "unknown" }));
  assert.throws(() =>
    save(
      { ...project, id: "example-import" },
      { location, files: [], projectIds: [project.id] },
    ),
  );
  save({ ...configured, isStarterProject: false });
  const imported = save(
    { ...project, id: "new", name: "Imported", instructions: "untrusted" },
    {
      location,
      files: [],
      projectIds: [project.id],
    },
  );
  assert.equal(imported.instructions, "Be concise.");
  assert.equal(imported.pinned, true);
  assert.equal(store.projects.length, 3);
  assert.equal(flushed, 3);
  assert.ok(selectedFolders.has(imported.cwd));
  assert.deepEqual(conversations, [{ id: "chat", projectId: project.id }]);
  assert.throws(() =>
    save(imported, { location, files: [], projectIds: [project.id] }),
  );
  assert.throws(() =>
    save(
      { ...project, id: "bad" },
      { location: root, files: [], projectIds: [project.id] },
    ),
  );
  assert.throws(() =>
    save({ ...project, id: "bad" }, { files: [], projectIds: [project.id] }),
  );
});

test("web runner refuses browser-supplied import destinations", () => {
  assert.throws(
    () =>
      guardCall("saveProject", [
        project,
        {
          location: "/tmp/host",
          files: [],
          projectIds: [project.id],
        },
      ]),
    /Folders on the server/,
  );
});
