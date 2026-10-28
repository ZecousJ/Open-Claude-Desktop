import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement as h } from "react";
import { Store } from "../../electron/store/store";
import type { Project } from "../../shared/types";
import { CloudStore } from "../../runner/src/cloud-store";
import { ProjectVisibility } from "../../src/collections/projects/ProjectVisibility";
import {
  memoryWebstore,
  useElectronShim,
} from "../runner/runner-core-support.test.ts";
import { routineDom } from "../support/routine-dom";

useElectronShim();
const { registerWorkspaceHandlers } =
  await import("../../electron/ipc/workspace");
const project = (id = "p1", extra: object = {}): Project => ({
  id,
  name: "Research",
  description: "Description",
  instructions: "Instructions",
  createdAt: 1,
  ...extra,
});
function root(t: TestContext) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b23-visibility-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function workspace(store: Store) {
  const handlers = new Map<string, (...args: any[]) => any>();
  registerWorkspaceHandlers((name, handler) => handlers.set(name, handler), {
    store,
    selectedFolders: new Set(),
    selectedAttachments: new Map(),
    allowedFolder() {},
    policy: () => ({}),
  } as unknown as Parameters<typeof registerWorkspaceHandlers>[1]);
  return handlers.get("saveProject")!;
}
function saved(directory: string): Project[] {
  return JSON.parse(
    fs.readFileSync(path.join(directory, "projects.json"), "utf8"),
  );
}
const foreignValues: unknown[] = [
  null,
  "public",
  "shared",
  "unknown",
  "",
  false,
  0,
  { kind: "future-access", audience: ["person"] },
];

test("legacy account-owned local projects gain explicit private metadata on load and persist it immediately", (t) => {
  const directory = root(t),
    legacy = project();
  fs.writeFileSync(
    path.join(directory, "projects.json"),
    JSON.stringify([legacy]),
  );
  const store = new Store(directory);
  assert.equal(store.projects[0].visibility, "private");
  assert.equal(saved(directory)[0].visibility, "private");
  assert.deepEqual(new Store(directory).projects, [
    { ...legacy, visibility: "private" },
  ]);
  const other = new Store(path.join(directory, "different-account"));
  assert.deepEqual(other.projects, []);
});

test("existing unknown and non-private metadata survives local load, save, archive, pin and reload without a private claim", (t) => {
  const directory = root(t),
    originals = foreignValues.map((visibility, index) =>
      project(`p${index}`, { visibility }),
    );
  fs.writeFileSync(
    path.join(directory, "projects.json"),
    JSON.stringify(originals),
  );
  const store = new Store(directory),
    save = workspace(store);
  for (const original of originals) {
    const result = save({
      ...original,
      name: `Edited ${original.id}`,
      pinned: true,
      archivedAt: 123,
      visibility: "private",
    });
    assert.deepEqual(result.visibility, original.visibility);
    assert.equal(result.pinned, true);
    assert.equal(result.archivedAt, 123);
  }
  const loaded = new Store(directory);
  assert.deepEqual(
    loaded.projects.map((item) => item.visibility),
    foreignValues,
  );
  assert.deepEqual(
    saved(directory).map((item) => item.visibility),
    foreignValues,
  );
});

test("the real creation handler records private ownership and ordinary edits cannot invent visibility changes", (t) => {
  const store = new Store(root(t)),
    save = workspace(store);
  const created = save(project("new", { visibility: "public" }));
  assert.equal(created.visibility, "private");
  const edited = save({ ...created, name: "Edited", visibility: "shared" });
  assert.equal(edited.visibility, "private");
  const withoutMetadata = { ...edited };
  delete withoutMetadata.visibility;
  assert.equal(save(withoutMetadata).visibility, "private");
  assert.equal(new Store(store.root).projects[0].visibility, "private");
  store.projects.push(project("imported-without-access-metadata"));
  store.flush();
  assert.equal(new Store(store.root).projects[1].visibility, "private");
});

test("the rendered visibility row reads only explicit persisted private and has no sharing mutation controls", async (t) => {
  const directory = root(t);
  fs.writeFileSync(
    path.join(directory, "projects.json"),
    JSON.stringify([project()]),
  );
  const store = new Store(directory),
    env = await routineDom();
  try {
    await env.render(h(ProjectVisibility, { project: store.projects[0] }));
    assert.equal(
      env.document.querySelector(".prj-visibility")?.textContent,
      "Private",
    );
    assert.equal(env.document.querySelector(".prj-visibility")?.tagName, "P");
    assert.equal(env.document.querySelector(".prj-visibility svg"), null);
    assert.equal(env.document.querySelector("button"), null);
    for (const visibility of [undefined, ...foreignValues]) {
      await env.render(h(ProjectVisibility, { project: { visibility } }));
      assert.equal(env.document.querySelector(".prj-visibility"), null);
      assert.ok(!env.document.body.textContent.includes("Private"));
    }
    await env.render(h(ProjectVisibility, { project: project() }));
    assert.equal(env.document.querySelector(".prj-visibility"), null);
  } finally {
    await env.clean();
  }
});

test("CloudStore persists migration through the owning user's project operations and preserves foreign metadata across edits/reopen", async (t) => {
  const web = memoryWebstore(),
    directory = root(t),
    owner = 71,
    other = 72;
  const rows = [
    project("legacy"),
    ...foreignValues.map((visibility, index) =>
      project(`foreign${index}`, { visibility }),
    ),
  ];
  for (const [position, item] of rows.entries())
    await web.request("store.projects.put", owner, { project: item, position });
  await web.request("store.projects.put", other, {
    project: project("legacy", { visibility: "public", name: "Other owner" }),
    position: 0,
  });
  web.log.length = 0;
  const store = await CloudStore.open({
    root: directory,
    userId: owner,
    transport: web,
  });
  try {
    assert.equal(store.projects[0].visibility, "private");
    assert.equal(
      web.users.get(owner)!.projects.get("legacy")!.project.visibility,
      "private",
    );
    assert.equal(
      web.users.get(other)!.projects.get("legacy")!.project.visibility,
      "public",
    );
    assert.ok(web.log.every((call) => call.userId === owner));
    assert.deepEqual(
      web.log
        .filter((call) => call.op === "store.projects.put")
        .map((call) => call.body.project.id),
      ["legacy"],
    );
    const save = workspace(store);
    for (const item of store.projects)
      save({ ...item, pinned: true, visibility: "shared" });
    await store.settled();
    assert.equal(
      web.users.get(owner)!.projects.get("legacy")!.project.visibility,
      "private",
    );
    assert.deepEqual(
      store.projects.slice(1).map((item) => item.visibility),
      foreignValues,
    );
    store.projects.push(project("imported"));
    store.flush();
    await store.settled();
    assert.equal(
      web.users.get(owner)!.projects.get("imported")!.project.visibility,
      "private",
    );
    assert.equal(fs.existsSync(path.join(directory, "projects.json")), false);
    const reopened = await CloudStore.open({
      root: root(t),
      userId: owner,
      transport: web,
    });
    try {
      assert.deepEqual(
        reopened.projects.map((item) => item.visibility),
        ["private", ...foreignValues, "private"],
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close();
  }
});

test("a failed cloud visibility migration retains its dirty project and persists on the supported retry path", async (t) => {
  const web = memoryWebstore(),
    directory = root(t);
  await web.request("store.projects.put", 81, {
    project: project("legacy"),
    position: 0,
  });
  web.failNext("store.projects.put");
  const store = await CloudStore.open({
    root: directory,
    userId: 81,
    transport: web,
    log() {},
  });
  try {
    assert.equal(store.failedWrites, 1);
    assert.equal(store.projects[0].visibility, "private");
    assert.equal(
      web.users.get(81)!.projects.get("legacy")!.project.visibility,
      undefined,
    );
    await store.sync();
    assert.equal(store.failedWrites, 0);
    assert.equal(
      web.users.get(81)!.projects.get("legacy")!.project.visibility,
      "private",
    );
    assert.equal(fs.existsSync(path.join(directory, "projects.json")), false);
  } finally {
    await store.close();
  }
});
