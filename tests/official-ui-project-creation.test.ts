import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { projectsRoute } from "../electron/official-ui/api/projects";
import { organizationUuid } from "../electron/official-ui/api/context";
import { Store } from "../electron/store/store";
import { CloudStore } from "../runner/src/cloud-store";
import { LinkRequestError } from "../runner/src/control-link";
import { webErrorCodes } from "../shared/web-protocol";
import { memoryWebstore, useElectronShim } from "./runner/runner-core-support.test";
import type { Project } from "../shared/types";
useElectronShim();
const { registerWorkspaceHandlers } = await import("../electron/ipc/workspace");

test("original project creation preserves name, description, instructions and the initial star", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-create-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const events: unknown[] = [];
  registerWorkspaceHandlers((name, call) => handlers.set(name, call), {
    store, window: undefined, selectedFolders: new Set(), selectedAttachments: new Map(),
    allowedFolder() {}, policy: () => ({}) as never, push: event => events.push(event),
  });
  handlers.set("listProjectKnowledge", () => ({ files: [] }));
  let identity: unknown = {};
  let snapshotUnavailable = false;
  let snapshotStore = store;
  const ctx = {
    account: () => ({ id: "owner", name: "Fixture", email: "fixture@example.test" }),
    sessionIdentity: () => identity,
    snapshot: async () => { if (snapshotUnavailable) throw Error("Fixture list unavailable"); return { projects: snapshotStore.projects }; },
    call: async (name: string, ...args: unknown[]) => handlers.get(name)!(...args),
  };
  const route = `/api/organizations/${organizationUuid("owner")}/projects`;
  async function requestProject(method: string, pathname: string, body?: unknown, changeAccount = false) {
    const request = Readable.from((function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      if (changeAccount) identity = {};
    })());
    Object.assign(request, { method, headers: { "content-type": "application/json" } });
    let status = 0, result: any;
    await projectsRoute(request as never, {
      writeHead(code: number) { status = code; }, end(value: unknown) { result = JSON.parse(String(value)); },
    } as never, pathname, new URL(pathname, "http://localhost"), ctx as never);
    return { status, result };
  }
  const create = (body: unknown, changeAccount = false) => requestProject("POST", route, body, changeAccount);
  const created = await create({ name: "  中文项目  ", description: "Description", prompt_template: "Instructions", is_private: true, is_starred: true });
  assert.equal(created.status, 201);
  assert.equal(created.result.name, "中文项目");
  assert.equal(created.result.is_starred, true);
  assert.equal(created.result.is_private, true);
  assert.equal(created.result.type, null);
  assert.equal(created.result.subtype, null);
  const reopened = new Store(root).projects;
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].id, created.result.uuid);
  assert.equal(reopened[0].description, "Description");
  assert.equal(reopened[0].instructions, "Instructions");
  assert.equal(reopened[0].pinned, true);
  assert.deepEqual(events, [{ type: "resync" }]);
  for (const body of [{ name: "" }, { name: " " }, { name: "x".repeat(201) }, { name: "Valid", is_starred: "true" }, { name: "Valid", prompt_template: "x".repeat(100001) }])
    assert.equal((await create(body)).status, 400);
  assert.equal((await create({ name: "Shared", is_private: false })).status, 403);
  assert.equal((await create({ name: "Retired" }, true)).status, 409);
  assert.equal(store.projects.length, 1);
  snapshotUnavailable = true;
  assert.equal((await create({ name: "Saved despite list refresh failure" })).status, 201);
  assert.equal(new Store(root).projects.length, 2);
  snapshotUnavailable = false;
  const retryBody = { name: "Retry-safe creation", client_creation_id: "11111111-1111-4111-8111-111111111111" };
  const first = await create(retryBody);
  const retry = await create(retryBody);
  assert.equal(first.status, 201);
  assert.deepEqual(retry, first);
  assert.equal(new Store(root).projects.length, 3);
  assert.equal((await create({ ...retryBody, name: "Changed after creation" })).status, 409);
  assert.equal((await create({ ...retryBody, client_creation_id: "invalid" })).status, 400);
  assert.equal((await create({ ...retryBody, client_creation_id: "22222222-2222-4222-8222-222222222222" })).status, 201);
  assert.equal(new Store(root).projects.length, 4, "separate same-name projects remain supported");
  const failingWrite = t.mock.method(store, "write", () => { throw Error("EACCES: /private/fixture/settings.json.tmp"); });
  const storageRetry = { name: "Storage recovery", client_creation_id: "33333333-3333-4333-8333-333333333333" };
  const failed = await create(storageRetry);
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(failed.result), /EACCES|private|settings.json/);
  assert.equal(store.projects.length, 4);
  failingWrite.mock.restore();
  assert.equal((await create(storageRetry)).status, 201);
  assert.equal(new Store(root).projects.filter(project => project.id === storageRetry.client_creation_id).length, 1);

  const templateBody = {
    name: "Template project",
    description: "Template description",
    prompt_template: "Fixture instructions for Template project",
    type: "student",
    subtype: "study",
    client_creation_id: "44444444-4444-4444-8444-444444444444",
  };
  for (const rejected of [{ type: "invalid" }, { subtype: "zoom" }, { subtype: null }])
    assert.equal((await create({ ...templateBody, ...rejected })).status, 400);
  const template = await create(templateBody);
  assert.equal(template.status, 201);
  assert.equal(template.result.type, templateBody.type);
  assert.equal(template.result.subtype, templateBody.subtype);
  assert.deepEqual(await create(templateBody), template);
  assert.equal((await create({ ...templateBody, subtype: "career" })).status, 409);
  assert.equal((await create({ ...templateBody, type: null, subtype: null })).status, 409);

  const { template: _template, ...edit } = store.projects.find(project => project.id === template.result.uuid)!;
  await handlers.get("saveProject")!({ ...edit, name: "Renamed template project" });
  snapshotStore = new Store(root);
  const detail = await requestProject("GET", `${route}/${template.result.uuid}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.result.name, "Renamed template project");
  assert.equal(detail.result.description, templateBody.description);
  assert.equal(detail.result.prompt_template, templateBody.prompt_template);
  assert.equal(detail.result.type, templateBody.type);
  assert.equal(detail.result.subtype, templateBody.subtype);
  const listing = await requestProject("GET", `${route}_v2`);
  assert.equal(listing.status, 200);
  const row = listing.result.data.find((project: { uuid: string }) => project.uuid === template.result.uuid);
  assert.equal(row.type, templateBody.type);
  assert.equal(row.subtype, templateBody.subtype);
});

test("cloud project creation waits for the service acknowledgement and survives reopen", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-project-create-"));
  const web = memoryWebstore();
  let release!: () => void, writing!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { writing = resolve; });
  const transport = { request: async (...args: Parameters<typeof web.request>) => {
    if (args[0] === "store.projects.put") { writing(); await held; }
    return web.request(...args);
  } };
  const store = await CloudStore.open({ root, userId: 41, transport });
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project: Project = {
    id: "project", kind: "chat", name: "Created", description: "Keep", instructions: "Guide",
    template: { type: "student", subtype: "research" }, pinned: true, visibility: "private", createdAt: 1,
  };
  let completed = false;
  const pending = store.persistProjectCreation(project, () => true).then(value => { completed = true; return value; });
  await started;
  assert.equal(completed, false);
  assert.equal(store.projects.length, 0);
  release();
  assert.equal((await pending).name, "Created");
  assert.deepEqual(web.users.get(41)!.projects.get(project.id)!.project.template, project.template);
  assert.equal(web.users.get(41)!.projects.get(project.id)!.project.pinned, true);
  const reopened = await CloudStore.open({ root, userId: 41, transport: web });
  try {
    assert.deepEqual(reopened.projects, store.projects);
    assert.deepEqual(await reopened.persistProjectCreation(project, () => true), project);
    await assert.rejects(reopened.persistProjectCreation({
      ...project, template: { type: "student", subtype: "career" },
    }, () => true), /different details/);
  } finally { await reopened.close(); }
});

test("cloud project creation does not acknowledge a failed write or a retired activation", async t => {
  const web = memoryWebstore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-project-failure-"));
  let fail = true;
  const store = await CloudStore.open({ root, userId: 41, log() {}, transport: {
    request: async (...args: Parameters<typeof web.request>) => {
      if (args[0] === "store.projects.put" && fail) throw Error("Fixture write unavailable");
      return web.request(...args);
    },
  } });
  t.after(async () => { fail = false; await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project: Project = { id: "project", name: "Created", description: "", instructions: "", createdAt: 1 };
  await assert.rejects(store.persistProjectCreation(project, () => false), /account changed/);
  assert.equal(store.projects.length, 0);
  await assert.rejects(store.persistProjectCreation(project, () => true), /could not be confirmed/);
  assert.equal(web.users.get(41)?.projects.has(project.id), false);
  assert.equal(store.projects.length, 0);
  fail = false;
  await store.sync("full");
  assert.equal(web.users.get(41)?.projects.has(project.id), false, "a cancelled creation must not be committed by background save");
  assert.equal((await store.persistProjectCreation({ ...project, createdAt: 2 }, () => true)).createdAt, 2);
  assert.equal(store.projects.length, 1);
  assert.equal(web.users.get(41)!.projects.size, 1);
  await assert.rejects(store.persistProjectCreation({ ...project, name: "Changed" }, () => true), /different details/);
});

test("retrying after losing the project save response preserves the committed project", async t => {
  const web = memoryWebstore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-project-lost-ack-"));
  let disconnect = true;
  const store = await CloudStore.open({ root, userId: 41, transport: {
    request: async (...args: Parameters<typeof web.request>) => {
      const response = await web.request(...args);
      if (args[0] === "store.projects.put" && disconnect) {
        disconnect = false;
        throw new LinkRequestError({ code: webErrorCodes.runnerUnavailable, message: "Link disconnected" });
      }
      return response;
    },
  } });
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project: Project = { id: "project", name: "First name", description: "", instructions: "", createdAt: 1 };
  await assert.rejects(store.persistProjectCreation(project, () => true), /could not be confirmed/);
  assert.equal(store.projects.length, 0);
  await assert.rejects(store.persistProjectCreation({ ...project, name: "Changed" }, () => true), /different details/);
  const saved = await store.persistProjectCreation({ ...project, createdAt: 2 }, () => true);
  assert.equal(saved.createdAt, 1);
  assert.equal(saved.name, "First name");
  assert.equal(web.users.get(41)!.projects.size, 1);
});

test("desktop project IPC on the runner waits for persistence before returning or notifying windows", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-ipc-confirm-"));
  const web = memoryWebstore();
  let release!: () => void, writing!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { writing = resolve; });
  const store = await CloudStore.open({ root, userId: 41, transport: {
    request: async (...args: Parameters<typeof web.request>) => {
      if (args[0] === "store.projects.put") { writing(); await held; }
      return web.request(...args);
    },
  } });
  t.after(async () => { release(); await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map<string, (...args: any[]) => any>(), events: unknown[] = [];
  registerWorkspaceHandlers((name, call) => handlers.set(name, call), {
    store, window: undefined, selectedFolders: new Set(), selectedAttachments: new Map(),
    allowedFolder() {}, policy: () => ({}) as never, push: event => events.push(event),
  });
  let returned = false;
  const pending = Promise.resolve(handlers.get("saveProject")!({ id: "created", name: "Native cloud project", description: "", instructions: "Keep", createdAt: 1 }))
    .then(value => { returned = true; return value; });
  await started;
  assert.equal(returned, false);
  assert.deepEqual(events, []);
  release();
  assert.equal((await pending).name, "Native cloud project");
  assert.equal(web.users.get(41)!.projects.get("created")!.project.instructions, "Keep");
  assert.deepEqual(events, [{ type: "resync" }]);
});

test("desktop cloud creation failure leaves no project or initial files after background sync", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-ipc-cancel-"));
  const web = memoryWebstore();
  let fail = true;
  const store = await CloudStore.open({ root, userId: 41, log() {}, transport: {
    request: async (...args: Parameters<typeof web.request>) => {
      if (args[0] === "store.projects.put" && fail) throw Error("Fixture storage unavailable");
      return web.request(...args);
    },
  } });
  t.after(async () => { fail = false; await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerWorkspaceHandlers((name, call) => handlers.set(name, call), {
    store, window: undefined, selectedFolders: new Set(), selectedAttachments: new Map(),
    allowedFolder() {}, policy: () => ({}) as never,
  });
  const project = { id: "create", kind: "chat", name: "Draft", description: "", instructions: "", createdAt: 1 };
  const creation = {
    files: [], operationId: "create-01",
    context: { files: [{ name: "notes.txt", data: new Uint8Array(Buffer.from("Reference text")) }] },
  };
  const save = () => handlers.get("saveProject")!(project, creation);
  await assert.rejects(save, /could not be confirmed/);
  fail = false;
  await store.sync("full");
  assert.equal(web.users.get(41)?.projects.has(project.id), false);
  assert.equal(fs.existsSync(path.join(root, "projects", project.id, "knowledge", "notes.txt")), false);
  assert.equal((await save()).name, project.name);
  assert.equal(web.users.get(41)!.projects.size, 1);
  assert.equal(fs.readFileSync(path.join(root, "projects", project.id, "knowledge", "notes.txt"), "utf8"), "Reference text");
});

test("desktop contextual creation can retry after disconnect and Runner restart", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-ipc-reopen-"));
  const web = memoryWebstore();
  let offline = true;
  const transport = {
    request: async (...args: Parameters<typeof web.request>) => {
      if (args[0] === "store.projects.put" && offline)
        throw new LinkRequestError({ code: webErrorCodes.runnerUnavailable, message: "Link disconnected" });
      return web.request(...args);
    },
  };
  let store = await CloudStore.open({ root, userId: 41, transport });
  t.after(async () => { offline = false; await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerWorkspaceHandlers((name, call) => handlers.set(name, call), {
    get store() { return store; },
    window: undefined, selectedFolders: new Set(), selectedAttachments: new Map(),
    allowedFolder() {}, policy: () => ({}) as never,
  });
  const project = { id: "create", kind: "chat", name: "Draft", description: "", instructions: "", createdAt: 1 };
  const creation = {
    files: [], operationId: "create-01",
    context: { files: [{ name: "notes.txt", data: new Uint8Array(Buffer.from("Reference text")) }] },
  };
  const save = () => handlers.get("saveProject")!(project, creation);
  await assert.rejects(save, /could not be confirmed/);
  assert.equal(store.projects.length, 0);
  await store.close();
  offline = false;
  store = await CloudStore.open({ root, userId: 41, transport });
  await assert.rejects(() => handlers.get("saveProject")!(project), /original project files/);
  assert.equal(web.users.get(41)?.projects.has(project.id), false);
  assert.equal((await save()).name, project.name);
  assert.equal(web.users.get(41)!.projects.size, 1);
  assert.equal(fs.readFileSync(path.join(root, "projects", project.id, "knowledge", "notes.txt"), "utf8"), "Reference text");
});
