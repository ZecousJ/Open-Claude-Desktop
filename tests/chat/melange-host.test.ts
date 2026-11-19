import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppContext } from "../../electron/app/app-context";
import { CloudRouter } from "../../electron/cloud/cloud-router";
import { LocalMemoryStore } from "../../electron/memory/local-store";
import { classicSourcesForMelange, readyMelangeForAccount } from "../../electron/memory/melange-host";
import { melangeStateSchema, type MelangeSnapshot } from "../../electron/memory/melange";
import { MemoryService } from "../../electron/memory/service";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import type { Project, Snapshot } from "../../shared/types";
import { fail, MockSub2Api, ok } from "../support/sub2api-mock";

test("desktop memory settings, files and Classic migration use the signed-in project catalog", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "claudex-melange-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const makeProject = (id: string): Project => ({ id, name: id, description: "", instructions: "", createdAt: 1 });
  const local = makeProject("fcb8ebc8-358b-4300-823d-33a9e093180d");
  const cloud = makeProject("28977543-6d83-42fd-9cce-0df02ce3ce80");
  const deleted = makeProject("48ed3e97-5c36-4d62-a001-a1c3ae6f3e5f");
  const unknown = makeProject("ff5b7431-3381-4c45-bad6-8132216630a8");
  store.projects.push(local, deleted);
  const release = store.reserveProjectDeletion(deleted.id);
  t.after(release);

  const snapshot = (projects: Project[]): Snapshot => ({
    projects, conversations: [], approvals: [], settings: store.settings,
    artifactLibrary: { version: 1, copies: [], pinned: [] },
    artifactShares: [], dismissedBackgroundTasks: [], engine: { state: "stopped" },
    platform: process.platform, replyFeedback: {},
  });
  const client = {
    snapshot: async () => ({ snapshot: snapshot([cloud, makeProject(local.id.toUpperCase())]) }),
    call: async () => undefined,
  };
  const router = new CloudRouter({
    client: () => client,
    push() {},
    attachmentBytes: async () => undefined,
  });
  await router.merge(snapshot(store.projects));

  const memoryStore = new LocalMemoryStore(root);
  const classic = new MemoryService({ store: memoryStore, policy: () => openPolicy, changed() {} });
  for (const project of [local, cloud, deleted, unknown]) {
    await memoryStore.saveDoc(`project:${project.id}`, { content: project.id, source: "user", baseRevision: 0 });
  }

  let saved: MelangeSnapshot = { revision: 1, state: { mode: "melange", files: [cloud, unknown].map(project => ({
    path: `projects/${project.id}.md`, content: project.id, updated_at: new Date(0).toISOString(),
  })) } };
  const backend = new MockSub2Api();
  const endpoint = "/api/v1/claudex/memory/melange";
  backend.route("GET", endpoint, () => ok(saved), { auth: "none" });
  backend.route("PUT", endpoint, ({ body }) => {
    if (body.base_revision !== saved.revision) return fail(409, "Revision changed.", "CONFLICT");
    saved = { revision: saved.revision + 1, state: melangeStateSchema.parse(body.state) };
    return ok(saved);
  }, { auth: "none" });
  const baseUrl = await backend.start();
  t.after(() => backend.close());

  let activation = {};
  const ctx = {
    store,
    cloudProjectIds: () => router.projects,
    engine: {},
    activeAccount: { id: "signed-in" },
    remote: {
      claudex: true,
      accounts: { baseUrl },
      backend: { deviceId: "desktop" },
      session: { authorized: <T>(call: (token: string) => Promise<T>) => call("token") },
    },
    services: { memory: { service: classic } },
    policy: () => openPolicy,
    onAccountDeactivating: () => () => {},
    get accountActivationIdentity() { return activation; },
  } as unknown as AppContext;

  const memory = await readyMelangeForAccount(ctx);
  assert.ok(memory);
  assert.equal(await memory.projectUsesAccountMemory(cloud.id), false);
  assert.equal(await memory.setProjectUsesAccountMemory(cloud.id, true), true);
  assert.equal(await memory.projectUsesAccountMemory(cloud.id), true);
  assert.equal(await memory.projectUsesAccountMemory(deleted.id), undefined);
  assert.equal(await memory.projectUsesAccountMemory(unknown.id), undefined);
  assert.deepEqual((await memory.list()).map(file => file.path), [`projects/${cloud.id}.md`]);
  assert.deepEqual(await classicSourcesForMelange(ctx), [local, cloud].map(project => ({
    scope: `project:${project.id}`, content: project.id,
  })));

  router.reset();
  assert.equal(await memory.projectUsesAccountMemory(cloud.id), undefined);
  assert.deepEqual(await memory.list(), []);
  activation = {};
  await assert.rejects(memory.projectUsesAccountMemory(local.id), /Memory account changed/);
});
