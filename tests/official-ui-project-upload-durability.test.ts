import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { organizationUuid, type AdapterContext } from "../electron/official-ui/api/context";
import { projectsRoute } from "../electron/official-ui/api/projects";
import { ProjectKnowledgeStore } from "../electron/projects/project-knowledge";
import type { Project } from "../shared/types";

const project = {
  id: "durability", name: "Durability", description: "", instructions: "", createdAt: 1,
} satisfies Project;
const contents = Buffer.from("Upload survives a process kill.\n");
const name = "nested/notes.txt";

function fixture(root: string) {
  const store = new ProjectKnowledgeStore(root, () => [project]);
  const folder = store.folder(project.id);
  const target = path.join(folder, name);
  const publication = process.platform === "win32" ? target : path.dirname(target);
  let adds = 0;
  const ctx = {
    root,
    account: () => ({ id: "owner" }),
    stateDirectory: () => root,
    sessionIdentity: () => "active",
    snapshot: async () => ({ projects: [project] }),
    call: async (method: string, projectId: string, input: never) => {
      assert.equal(projectId, project.id);
      switch (method) {
        case "addProjectKnowledgeFiles":
          adds++;
          return store.add(projectId, input);
        case "listProjectKnowledge":
          return store.list(projectId);
        case "readProjectKnowledge":
          return store.read(projectId, input);
        case "confirmProjectKnowledgeUpload":
          return store.confirmUpload(projectId, input);
        default:
          throw new Error(`Unexpected method ${method}`);
      }
    },
  } as unknown as AdapterContext;
  const route = `/api/organizations/${organizationUuid("owner")}/projects/${project.id}/upload`;
  const upload = async (reuse: boolean) => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(contents)]), path.basename(name));
    form.set("relative_dir", "nested");
    form.set("client_upload_id", "durability-fixture");
    if (reuse) form.set("reuse_first_upload", "true");
    const body = new Request("http://fixture.invalid", { method: "POST", body: form });
    const req = Object.assign(Readable.from([Buffer.from(await body.arrayBuffer())]), {
      method: "POST",
      headers: { "content-type": body.headers.get("content-type") },
    }) as Parameters<typeof projectsRoute>[0];
    let status = 0;
    const res = {
      writeHead: (code: number) => { status = code; },
      end: () => {},
    } as unknown as Parameters<typeof projectsRoute>[1];
    assert.equal(await projectsRoute(req, res, route, new URL(route, body.url), ctx), true);
    return status;
  };
  const receipts = () => {
    const directory = fs.readdirSync(root).find(entry => entry.startsWith("official-project-upload-receipts-"));
    assert.ok(directory);
    return fs.readdirSync(path.join(root, directory));
  };
  return { store, folder, target, publication, upload, receipts, adds: () => adds };
}

function temporary(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-upload-durability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function interceptSync(
  open: typeof fs.promises.open,
  intercept: (file: string, sync: () => Promise<void>) => Promise<void>,
): typeof open {
  return async (...args) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = () => intercept(String(args[0]), sync);
    return handle;
  };
}

const workerIndex = process.argv.indexOf("--project-upload-worker");
if (workerIndex !== -1) {
  const f = fixture(process.argv[workerIndex + 1]);
  fs.promises.open = interceptSync(fs.promises.open, async (file, sync) => {
    if (file !== f.publication) return sync();
    assert.deepEqual(fs.readFileSync(f.target), contents);
    assert.equal(f.receipts().length, 1);
    setInterval(() => {}, 1000);
    assert.ok(process.send);
    process.send("published");
    await new Promise<void>(() => {});
  });
  assert.fail(`Upload returned ${await f.upload(false)} before interruption`);
} else {
  test("a pending upload stays pending until retry syncs the published knowledge", async t => {
    const root = temporary(t);
    const f = fixture(root);
    let fail = true;
    const synced: string[] = [];
    t.mock.method(fs.promises, "open", interceptSync(fs.promises.open, async (file, sync) => {
      if (file === f.publication && fail) throw Object.assign(new Error("Fixture sync failed"), { code: "EIO" });
      await sync();
      synced.push(file);
    }));
    assert.equal(await f.upload(false), 503);
    assert.deepEqual(fs.readFileSync(f.target), contents);
    assert.equal(f.receipts().length, 1);
    assert.equal(await f.upload(true), 503);
    assert.equal(f.receipts().length, 1);

    fail = false;
    synced.length = 0;
    const before = fs.statSync(f.target);
    assert.equal(await f.upload(true), 200);
    const doneSync = synced.findIndex(file => file.endsWith(".done.json"));
    assert.ok(doneSync >= 0);
    const knowledgeSyncs = synced.slice(synced.indexOf(f.target), doneSync);
    const required = process.platform === "win32"
      ? [f.target]
      : [f.target, f.publication, f.folder, path.dirname(f.folder), path.join(root, "projects"), root];
    for (const file of required) assert.ok(knowledgeSyncs.includes(file), file);
    assert.equal(f.receipts().filter(entry => entry.endsWith(".done.json")).length, 1);
    const after = fs.statSync(f.target);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(fs.readFileSync(f.target), contents);
    assert.equal(f.adds(), 1);
  });

  test("retry completes removal of a replaced file's sidecars after an interrupted rename", async t => {
    const f = fixture(temporary(t));
    const source = {
      provider: "github", repository: "owner/repo", branch: "main",
      path: "notes.txt", status: "idle", lastSyncedAt: 1,
    } as const;
    await f.store.add(project.id, [
      { name, data: Buffer.from("Old text"), displayName: "Old notes", source },
      { name: "kept.txt", data: Buffer.from("Kept"), displayName: "Kept title", source },
    ]);
    const rename = fs.renameSync;
    let interrupted = false;
    t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
      if (!interrupted && String(args[1]).endsWith("knowledge-sources.json")) {
        interrupted = true;
        throw Object.assign(new Error("Fixture rename failed"), { code: "EIO" });
      }
      rename(...args);
    });
    assert.equal(await f.upload(false), 503);
    assert.deepEqual(fs.readFileSync(f.target), contents);
    assert.equal(f.store.list(project.id).files.find(file => file.name === name)?.displayName, "Old notes");
    assert.equal(await f.upload(true), 200);
    const files = f.store.list(project.id).files;
    const replaced = files.find(file => file.name === name);
    const kept = files.find(file => file.name === "kept.txt");
    assert.ok(replaced);
    assert.equal(replaced.displayName, undefined);
    assert.equal(replaced.source, undefined);
    assert.equal(kept?.displayName, "Kept title");
    assert.deepEqual(kept?.source, source);
    assert.deepEqual(fs.readFileSync(f.target), contents);
    assert.equal(f.adds(), 1);
  });

  test("a readable confirmation is flushed before its retry can succeed", async t => {
    const f = fixture(temporary(t));
    let fail = true;
    let flushed = false;
    t.mock.method(fs.promises, "open", interceptSync(fs.promises.open, async (file, sync) => {
      if (!file.endsWith(".done.json")) return sync();
      if (fail) throw Object.assign(new Error("Fixture confirmation sync failed"), { code: "EIO" });
      await sync();
      flushed = true;
    }));
    assert.equal(await f.upload(false), 503);
    assert.equal(f.receipts().filter(entry => entry.endsWith(".done.json")).length, 1);
    assert.equal(await f.upload(true), 503);
    fail = false;
    assert.equal(await f.upload(true), 200);
    assert.equal(flushed, true);
    assert.deepEqual(fs.readFileSync(f.target), contents);
    assert.equal(f.adds(), 1);
  });

  test("a process killed after knowledge publication can confirm the pending upload on restart", { timeout: 15_000 }, async t => {
    const root = temporary(t);
    const child = fork(fileURLToPath(import.meta.url), ["--project-upload-worker", root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const closed = once(child, "exit");
    try {
      const message = await Promise.race([
        once(child, "message").then(([value]) => value),
        closed.then(([code, signal]) => assert.fail(`Upload worker exited before publication (${code}, ${signal})`)),
        once(t.signal, "abort").then(() => assert.fail("Upload worker did not reach publication")),
      ]);
      assert.equal(message, "published");
    } finally {
      assert.equal(child.kill("SIGKILL"), true);
      const [code] = await closed;
      assert.notEqual(code, 0);
    }
    const f = fixture(root);
    assert.equal(f.receipts().length, 1);
    assert.deepEqual(fs.readFileSync(f.target), contents);
    assert.equal(await f.upload(true), 200);
    assert.equal(f.receipts().filter(entry => entry.endsWith(".done.json")).length, 1);
    assert.deepEqual(fs.readFileSync(f.target), contents);
    assert.equal(f.adds(), 0);
  });
}
