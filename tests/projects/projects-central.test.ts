import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import type { Project } from "../../shared/types";
import { useElectronShim } from "../runner/runner-core-support.test.ts";
useElectronShim();
const { registerWorkspaceHandlers } =
  await import("../../electron/ipc/workspace");
const { saveProjectCreation } =
  await import("../../src/app/save-project-creation");
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b33-central-"));
  const store = new Store(root);
  const handlers = new Map<string, (...args: any[]) => any>();
  registerWorkspaceHandlers((name, fn) => handlers.set(name, fn), {
    store,
    window: undefined,
    selectedFolders: new Set(),
    selectedAttachments: new Map(),
    allowedFolder() {},
    policy: () => openPolicy,
  });
  t.after(() => {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    call: (name: string, ...args: any[]) => {
      const fn = handlers.get(name);
      assert.ok(fn);
      return fn(...args);
    },
  };
}
const project = (id = "project"): Project => ({
  id,
  name: "Project",
  description: "",
  instructions: "Keep",
  createdAt: 1,
});
const input = () => ({
  files: [],
  operationId: "operation-1",
  context: {
    files: [
      { name: "notes.txt", data: new TextEncoder().encode("Real context") },
    ],
  },
});
test("authoritative private project reads and instruction rights cannot be forged by the renderer", (t) => {
  const s = setup(t);
  s.store.projects = [
    {
      ...project(),
      capabilities: { canEditInstructions: false, canEditKnowledgeBase: false },
    },
  ];
  assert.equal(
    s.call("readProject", "project").project.capabilities.canEditInstructions,
    false,
  );
  assert.equal(s.call("readProject", "another-account").status, "missing");
  assert.throws(
    () =>
      s.call("saveProject", {
        ...project(),
        instructions: "overwrite",
        capabilities: { canEditInstructions: true, canEditKnowledgeBase: true },
      }),
    /read-only/,
  );
  const saved = s.call("saveProject", {
    ...project(),
    name: "New name",
    capabilities: { canEditInstructions: true, canEditKnowledgeBase: true },
  });
  assert.equal(saved.capabilities.canEditInstructions, false);
  assert.equal(s.call("projectCreationCapabilities").routing, "classic");
  assert.equal(s.call("projectCreationCapabilities").contextFiles, true);
  assert.equal(s.call("projectCreationCapabilities").contextText, false);
  assert.equal(
    s.call("projectCreationCapabilities").educationSuggestions,
    false,
  );
});
test("real registered creation publishes validated context once, persists it and safely replays the same operation", (t) => {
  const s = setup(t);
  const saved = s.call("saveProject", project(), input());
  assert.notEqual(saved.kind, "local");
  assert.equal(s.store.projects.length, 1);
  const target = path.join(
    s.root,
    "projects",
    "project",
    "knowledge",
    "notes.txt",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "Real context");
  assert.equal(new Store(s.root).projects[0].id, "project");
  assert.deepEqual(s.call("saveProject", project(), input()), saved);
  assert.equal(s.store.projects.length, 1);
  assert.throws(
    () =>
      s.call("saveProject", project(), {
        ...input(),
        context: {
          files: [
            {
              name: "notes.txt",
              data: new TextEncoder().encode("Changed bytes"),
            },
          ],
        },
      }),
    /already exists/,
  );
});
test("invalid context and failed metadata persistence leave no published project or context", (t) => {
  const s = setup(t);
  assert.throws(
    () =>
      s.call("saveProject", project(), {
        ...input(),
        context: { files: [{ name: "bad.txt", data: new Uint8Array([255]) }] },
      }),
    /UTF-8/,
  );
  assert.equal(s.store.projects.length, 0);
  assert.equal(fs.existsSync(path.join(s.root, "projects", "project")), false);
  const original = s.store.flush.bind(s.store);
  s.store.flush = () => {
    throw Error("disk unavailable");
  };
  try {
    assert.throws(
      () => s.call("saveProject", project(), input()),
      /disk unavailable/,
    );
  } finally {
    s.store.flush = original;
  }
  assert.equal(s.store.projects.length, 0);
  assert.equal(fs.existsSync(path.join(s.root, "projects", "project")), false);
});
test("mixed local creation cannot partially write classic context or replace an existing project", (t) => {
  const s = setup(t);
  assert.throws(
    () => s.call("saveProject", project(), { ...input(), location: s.root }),
    /prepare/,
  );
  assert.equal(s.store.projects.length, 0);
  s.call("saveProject", project());
  assert.throws(
    () => s.call("saveProject", project(), input()),
    /already exists/,
  );
});
test("actual submission serializes the latest files once and retires before sending after an asynchronous file read", async () => {
  let current = true,
    finish!: (buffer: ArrayBuffer) => void,
    calls = 0;
  const file = {
    name: "notes.txt",
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  } as File;
  const bridge = {
    saveProject: async () => {
      calls++;
      return project();
    },
  };
  const pending = saveProjectCreation(
    bridge,
    project(),
    { files: [], contextFiles: [file], operationId: "op" },
    () => current,
  );
  current = false;
  finish(new TextEncoder().encode("latest").buffer);
  await assert.rejects(pending, /account changed/);
  assert.equal(calls, 0);
});
test("actual submission forwards exact context bytes and rejects a retired response before publication", async () => {
  let current = true,
    finish!: (value: Project) => void,
    request: any;
  const bridge = {
    saveProject: async (_: Project, creation: any) => {
      request = creation;
      return new Promise<Project>((resolve) => {
        finish = resolve;
      });
    },
  };
  const file = {
    name: "notes.txt",
    arrayBuffer: async () => new TextEncoder().encode("exact bytes").buffer,
  } as File;
  const pending = saveProjectCreation(
    bridge,
    project(),
    { files: [], contextFiles: [file], operationId: "op" },
    () => current,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    new TextDecoder().decode(request.context.files[0].data),
    "exact bytes",
  );
  assert.equal(request.operationId, "op");
  current = false;
  finish(project());
  await assert.rejects(pending, /account changed/);
});

const { registerCollectionHandlers } =
  await import("../../electron/ipc/collections");
test("actual knowledge IPC retains pending uploads/capabilities after legacy mutations and converts exact selected bytes", async (t) => {
  const s = setup(t),
    handlers = new Map<string, (...args: any[]) => any>(),
    retire: Array<() => unknown> = [];
  s.store.projects = [project()];
  const ctx = {
    store: s.store,
    engine: { approvals: [] },
    services: {},
    policy: () => openPolicy,
    onAccountActivated() {},
    onAccountDeactivating(fn: () => unknown) {
      retire.push(fn);
    },
    onSettingsChanged() {},
  } as any;
  registerCollectionHandlers((name, fn) => handlers.set(name, fn), ctx);
  const call = (name: string, ...args: any[]) => {
    const fn = handlers.get(name);
    assert.ok(fn);
    return fn(...args);
  };
  const staged = await call("stageProjectKnowledgeFiles", "project", [
    { name: "legacy.txt", data: new Uint8Array([0xe9]) },
  ]);
  assert.equal(staged.pending.length, 1);
  assert.equal(staged.pending[0].status, "encoding");
  const withText = await call("addProjectKnowledgeText", "project", {
    name: "extra",
    text: "UTF8",
  });
  assert.equal(withText.pending.length, 1);
  assert.equal(withText.uploadCapabilities.encodingSelection, true);
  const preview = await call(
    "previewProjectKnowledgeEncoding",
    "project",
    staged.pending[0].id,
    "windows-1252",
  );
  assert.equal(preview.text, "é");
  const converted = await call(
    "confirmProjectKnowledgeEncoding",
    "project",
    staged.pending[0].id,
    "windows-1252",
  );
  assert.equal(converted.pending.length, 0);
  assert.equal(
    fs.readFileSync(
      path.join(s.root, "projects/project/knowledge/legacy.txt"),
      "utf8",
    ),
    "é",
  );
  s.store.projects[0].capabilities = {
    canEditInstructions: false,
    canEditKnowledgeBase: false,
  };
  await assert.rejects(
    async () =>
      call("addProjectKnowledgeText", "project", {
        name: "denied",
        text: "No",
      }),
    /permission/,
  );
  const read = await call("listProjectKnowledge", "project");
  assert.equal(read.capabilities.canEditKnowledgeBase, false);
  assert.ok(read.files.length > 0);
});
