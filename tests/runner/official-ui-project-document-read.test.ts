/** Original doc consumer -> Web fetch -> runner adapter -> real collections/store.
 * Only temporary synthetic project files are used; no login, UI, or model calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import vm from "node:vm";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { knowledgeId } from "../../electron/official-ui/api/projects";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { isOfficialUiQuery } from "../../shared/official-ui-web";

const projectId = "33333333-3333-4333-8333-333333333333";
const otherProjectId = "44444444-4444-4444-8444-444444444444";
const title = "原始文本.txt";
const content = "Synthetic project document\r\n原始内容 🦊\n";
const org = organizationUuid("synthetic-owner");
const base = `/api/organizations/${org}/projects/${projectId}`;
const docId = knowledgeId(projectId, title);
const docPath = `${base}/docs/${docId}`;

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f025-web-doc-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map<string, (...args: any[]) => any>();
  const store = {
    root,
    projects: [{ id: projectId, kind: "chat", name: "Synthetic", createdAt: 1 }],
  };
  registerCollectionHandlers((name, handler) => handlers.set(name, handler), {
    store,
    onSettingsChanged() {},
    onAccountActivated() {},
    onAccountDeactivating() {},
  } as never);
  await handlers.get("addProjectKnowledgeText")!(projectId, { name: title, text: content });
  assert.equal(
    fs.readFileSync(path.join(root, "projects", projectId, "knowledge", title), "utf8"),
    content,
  );
  let owner = "synthetic-owner", activation = 1;
  const calls: string[] = [], paths: string[] = [];
  let beforeDispatch: ((method: string) => Promise<void> | void) | undefined;
  const run = createRunnerOfficialAdapter({
    account: () => ({ id: owner, email: "synthetic@example.invalid", name: "Synthetic" }),
    settings: () => ({}),
    sessionIdentity: () => activation,
    stateDirectory: () => root,
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
  } as never, async (method, args) => {
    calls.push(method);
    await beforeDispatch?.(method);
    if (method === "snapshot") return { projects: store.projects, conversations: [] };
    assert.ok(
      method === "listProjectKnowledge" || method === "readProjectKnowledge",
      `Unexpected native method: ${method}`,
    );
    assert.equal(args[0], projectId);
    const handler = handlers.get(method);
    assert.ok(handler, `Missing real collections handler: ${method}`);
    return handler(...args);
  }, root, { modes: ["chat"] });
  const fetch = createOfficialReadFetch("https://synthetic.example.invalid", async request => {
    paths.push(request.path);
    return run(request);
  }, async () => { throw Error("The document read must not use native/network fetch."); });
  return {
    root, store, calls, paths, run, fetch,
    before(fn: typeof beforeDispatch) { beforeDispatch = fn; },
    retire(account = "synthetic-owner") { owner = account; activation++; },
  };
}

/** Execute the unchanged recovered hook. React Query is represented only by a
 * recording hook that executes the real request; no successful data is supplied. */
function originalDocConsumer(fetch: typeof globalThis.fetch) {
  const sourcePath = "build/official-ui/ui/assets/v1/shared-0-BgsOqC85.js";
  const source = fs.readFileSync(sourcePath, "utf8");
  const start = source.indexOf("function uP(e) {"), end = source.indexOf("\nfunction tA(", start);
  assert.ok(start >= 0 && end > start, "The pinned original uP consumer must exist.");
  const original = source.slice(start, end);
  assert.match(original, /jg\(`\/api\/organizations\/\$\{c\}\/projects\/\$\{t\}\/docs\/\$\{n\}`/);
  assert.match(original, /return \(wh\(p\.error, c, t\), p\);/);
  const memo = (...args: unknown[]) => args.at(-1);
  return vm.runInNewContext(`(${original})`, {
    J9: () => [], J1: () => true, J3: () => true, K1: memo, K3: memo,
    a4: () => ({ activeOrganization: { uuid: org } }),
    yM: (project: unknown, doc: unknown) => [project, doc],
    wh() {},
    jg: (url: string, options: { enabled: boolean }) => {
      assert.equal(options.enabled, true);
      return { response: fetch(url) };
    },
  }) as (input: { projectUuid: string; docUuid: string }) => { response: Promise<Response> };
}

test("original uP reads actual saved text through the Web fetch and runner adapter", async t => {
  const f = await fixture(t);
  const consumer = originalDocConsumer(f.fetch);
  const response = await consumer({ projectUuid: projectId, docUuid: docId }).response;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const doc = await response.json();
  assert.deepEqual(Object.keys(doc).sort(), [
    "uuid", "file_name", "content", "content_length", "created_at", "project_uuid", "estimated_token_count",
  ].sort());
  assert.equal(doc.uuid, docId);
  assert.equal(doc.file_name, title);
  assert.equal(doc.project_uuid, projectId);
  assert.equal(doc.content, content);
  assert.equal(doc.content_length, [...content].length);
  assert.equal(doc.estimated_token_count, Math.ceil(Buffer.byteLength(content) / 4));
  assert.deepEqual(f.paths, [docPath]);
  assert.deepEqual(f.calls, ["snapshot", "listProjectKnowledge", "readProjectKnowledge"]);
  const listed = await (await f.fetch(`${base}/docs?compact=true`)).json();
  assert.deepEqual(listed.find((item: { uuid: string }) => item.uuid === docId), { ...doc, content: "" });
  const strong = await f.fetch(`${docPath}?consistency=strong`);
  assert.equal(strong.status, 200);
  assert.deepEqual(await strong.json(), doc);
});

test("unknown document, foreign organization, and unowned project never read a file", async t => {
  const f = await fixture(t);
  for (const requestPath of [
    `${base}/docs/55555555-5555-4555-8555-555555555555`,
    docPath.replace(org, organizationUuid("foreign-owner")),
    docPath.replace(projectId, otherProjectId),
  ]) {
    f.calls.length = 0;
    const response = await f.fetch(requestPath);
    assert.equal(response.status, 404, requestPath);
    assert.ok(!f.calls.includes("readProjectKnowledge"));
    if (requestPath.includes(organizationUuid("foreign-owner"))) assert.deepEqual(f.calls, []);
    assert.ok(!(await response.text()).includes(content));
  }
});

test("a real store read failure returns an error without fabricated text or private paths", async t => {
  const f = await fixture(t);
  f.before(method => {
    if (method === "readProjectKnowledge")
      fs.unlinkSync(path.join(f.root, "projects", projectId, "knowledge", title));
  });
  const response = await f.fetch(docPath);
  assert.equal(response.status, 503);
  const error = await response.text();
  assert.ok(!error.includes(content));
  assert.ok(!error.includes(f.root));
  assert.equal(f.calls.filter(method => method === "readProjectKnowledge").length, 1);
});

test("account or activation changes while a read awaits return conflict without the document", async t => {
  for (const phase of ["snapshot", "listProjectKnowledge", "readProjectKnowledge"]) {
    for (const owner of ["synthetic-owner", "foreign-owner"]) {
      const f = await fixture(t);
      let reached!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { reached = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      f.before(async method => {
        if (method === phase) { reached(); await barrier; }
      });
      const pending = f.fetch(docPath);
      await waiting;
      f.retire(owner);
      release();
      const response = await pending;
      assert.equal(response.status, 409, `${phase}: ${owner}`);
      assert.ok(!(await response.text()).includes(content));
      if (phase !== "readProjectKnowledge") assert.ok(!f.calls.includes("readProjectKnowledge"));
    }
  }
});

test("only the exact GET document path opens, never mutations or adjacent resource routes", async t => {
  const f = await fixture(t);
  assert.equal(isOfficialUiQuery("GET", docPath), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    assert.equal(isOfficialUiQuery(method, docPath), false);
    assert.equal((await f.fetch(docPath, { method })).status, 501);
    assert.equal((await f.run({ method, path: docPath })).status, 501);
  }
  for (const requestPath of [
    `${docPath}/`, `${docPath}/edit`, `${docPath}/contents`,
    docPath.replace("/docs/", "/files/"),
    docPath.replace("/projects/", "/projects_v2/"),
    `${base}/docs/delete_many`, `${base}/docs/not-a-uuid`,
    docPath.replace(projectId, "not-a-project-uuid"),
    docPath.replace(org, "not-an-org-uuid"),
  ]) {
    assert.equal(isOfficialUiQuery("GET", requestPath), false, requestPath);
    assert.equal((await f.fetch(requestPath)).status, 501, requestPath);
    assert.equal((await f.run({ method: "GET", path: requestPath })).status, 501, requestPath);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.paths, []);
});
