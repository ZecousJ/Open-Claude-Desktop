/** F050: real IPC registration and stores; synthetic accounts, no activation or model. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerMemoryHandlers } from "../../electron/ipc/memory";
import { LocalMemoryStore } from "../../electron/memory/local-store";
import { MemoryService } from "../../electron/memory/service";
import { projectScope } from "../../electron/memory/types";
import { openPolicy } from "../../shared/client-policy";
import type { AppContext } from "../../electron/app/app-context";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const project = { kind: "project", projectId };
const global = { kind: "global" };
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve };
}
function fixture(service: unknown) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    store: { root: "/inert-f050", projects: [{ id: projectId }], settings: {}, isProjectDeleting: () => false },
    services: { memory: { service } },
    activeAccount: { id: "synthetic-A" },
    accountActivationIdentity: 1,
    accountRetiring: false,
    remote: { session: {} },
    onAccountActivated() {},
    onAccountDeactivating() {},
    onEvent() {},
  };
  registerMemoryHandlers(
    (name, fn) => handlers.set(name, fn),
    ctx as unknown as AppContext,
  );
  return {
    ctx,
    call: (name: string, ...args: unknown[]) =>
      Promise.resolve(handlers.get(name)!(...args)),
  };
}
function pending(phase: "ready" | "refresh") {
  const wait = deferred();
  const entered = deferred();
  let documents = 0,
    refreshes = 0;
  const service = {
    async ready() {
      if (phase === "ready") {
        entered.resolve();
        await wait.promise;
      }
    },
    async refresh() {
      refreshes++;
      if (phase === "refresh") {
        entered.resolve();
        await wait.promise;
      }
    },
    status: () => ({ available: true, global: { content: "private-A" } }),
    docView: () => {
      documents++;
      return { content: "private-A" };
    },
    controlsVersion: () => "v1:0:0:0",
  };
  return {
    ...fixture(service),
    wait,
    entered,
    documents: () => documents,
    refreshes: () => refreshes,
  };
}

for (const method of ["memoryStatus", "memoryDoc", "memoryControlsState"])
  for (const change of [
    "owner",
    "generation",
    "store",
    "remote",
    "session",
    "service",
    "retiring",
  ] as const)
    test(`${method} refuses ${change} change during readiness`, async () => {
      const f = pending("ready"),
        result = f.call(method, ...(method === "memoryStatus" ? [] : [global]));
      await f.entered.promise;
      switch (change) {
        case "owner":
          f.ctx.activeAccount = { id: "synthetic-B" };
          break;
        case "generation":
          f.ctx.accountActivationIdentity++;
          break;
        case "store":
          f.ctx.store = { ...f.ctx.store };
          break;
        case "remote":
          f.ctx.remote = { session: {} };
          break;
        case "session":
          f.ctx.remote.session = {};
          break;
        case "service":
          f.ctx.services.memory = { service: {} };
          break;
        case "retiring":
          f.ctx.accountRetiring = true;
          break;
      }
      f.wait.resolve();
      await assert.rejects(result, /Memory account changed/);
      assert.equal(f.documents(), 0);
      assert.equal(f.refreshes(), 0);
    });

for (const method of ["memoryDoc", "memoryControlsState"])
  for (const phase of ["ready", "refresh"] as const) {
    test(`${method} rechecks project membership after ${phase}`, async () => {
      const f = pending(phase),
        result = f.call(method, project);
      await f.entered.promise;
      f.ctx.store.projects = [];
      f.wait.resolve();
      await assert.rejects(result, /Project not found/);
      assert.equal(f.documents(), 0);
    });
    test(`${method} refuses same-account reactivation during ${phase}`, async () => {
      const f = pending(phase),
        result = f.call(method, project);
      await f.entered.promise;
      f.ctx.accountActivationIdentity++;
      f.wait.resolve();
      await assert.rejects(result, /Memory account changed/);
      assert.equal(f.documents(), 0);
    });
  }

test("snapshot reads reject retiring accounts without waiting or refreshing", async () => {
  const f = pending("ready");
  f.ctx.accountRetiring = true;
  await assert.rejects(
    f.call("memoryStatus", { snapshotOnly: true }),
    /Memory account changed/,
  );
  await assert.rejects(
    f.call("memoryControlsState", global, { snapshotOnly: true }),
    /Memory account changed/,
  );
  assert.equal(f.documents(), 0);
  assert.equal(f.refreshes(), 0);
});

test("document reads reject missing, invalid and removed project scopes before loading", async () => {
  const f = pending("ready");
  for (const raw of [
    { kind: "project", projectId: otherId },
    { kind: "project", projectId: "bad" },
    { kind: "project", projectId: "" },
    { kind: "global", projectId },
    null,
  ])
    await assert.rejects(f.call("memoryDoc", raw));
  assert.equal(f.documents(), 0);
  assert.equal(f.refreshes(), 0);
});

test("real local stores preserve global/project and account isolation across reopening", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f050-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const account of ["A", "B"]) {
    const dir = path.join(root, account);
    fs.mkdirSync(dir);
    const store = new LocalMemoryStore(dir);
    await store.saveDoc("global", {
      content: `${account}-global`,
      source: "user",
      baseRevision: 0,
    });
    await store.saveDoc(projectScope(projectId)!, {
      content: `${account}-project`,
      source: "user",
      baseRevision: 0,
    });
    await store.saveDoc(projectScope(otherId)!, {
      content: `${account}-unlisted`,
      source: "user",
      baseRevision: 0,
    });
    await store.addEdit("global", `${account} global rule`);
    await store.addEdit(projectScope(projectId)!, `${account} project rule`);
    const service = new MemoryService({
      store: new LocalMemoryStore(dir),
      policy: () => openPolicy,
      changed() {},
    });
    t.after(() => service.close());
    const f = fixture(service);
    const read = (await f.call("memoryDoc", global)) as any;
    assert.equal(read.content, `${account}-global`);
    assert.deepEqual(
      read.edits.map((edit: any) => edit.text),
      [`${account} global rule`],
    );
    const scoped = (await f.call("memoryControlsState", project)) as any;
    assert.equal(scoped.doc.content, `${account}-project`);
    assert.deepEqual(
      scoped.doc.edits.map((edit: any) => edit.text),
      [`${account} project rule`],
    );
    assert.equal(
      scoped.version,
      service.controlsVersion(projectScope(projectId)!),
    );
    await assert.rejects(
      f.call("memoryDoc", { kind: "project", projectId: otherId }),
      /Project not found/,
    );
    f.ctx.store.projects.push({ id: otherId });
    assert.equal(
      (
        (await f.call("memoryDoc", {
          kind: "project",
          projectId: otherId,
        })) as any
      ).content,
      `${account}-unlisted`,
    );
    assert.equal(
      ((await f.call("memoryStatus", { snapshotOnly: true })) as any).global
        .content,
      `${account}-global`,
    );
  }
});

test("empty memory is null and non-generating snapshots do not trigger readiness or refresh", async () => {
  let reads = 0;
  const service = {
    ready: async () => {
      reads++;
    },
    refresh: async () => {
      reads++;
    },
    status: () => ({ available: true }),
    docView: () => null,
    controlsVersion: () => "v1:0:0:0",
  };
  const f = fixture(service);
  assert.deepEqual(
    await f.call("memoryControlsState", global, { snapshotOnly: true }),
    { doc: null, version: "v1:0:0:0" },
  );
  assert.equal(reads, 0);
  assert.equal(await f.call("memoryDoc", global), null);
  assert.equal(reads, 2);
});
