import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { act, createElement as h } from "react";
import type { Project } from "../../shared/types";
import type { KnowledgePreview } from "../../shared/collections-api";
import type { AppContext as ElectronContext } from "../../electron/app/app-context";
import type { GhRunner } from "../../electron/git/github-cli";
import {
  ProjectKnowledgeStore,
  knowledgeFileLimit,
} from "../../electron/projects/project-knowledge";
import { ProjectKnowledgeDrive } from "../../electron/projects/project-knowledge-drive";
import { ProjectKnowledgeMcp } from "../../electron/projects/project-knowledge-mcp";
import { syncKnowledgeRepositoryFile } from "../../electron/projects/project-knowledge-github";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ProjectKnowledge } from "../../src/collections/projects/ProjectKnowledge";
import { KnowledgePreviewDialog } from "../../src/collections/projects/KnowledgePreview";
import { routineDom } from "../support/routine-dom";

const project = (id = "p1"): Project => ({
  id,
  name: id,
  description: "",
  instructions: "",
  createdAt: 1,
});
const text =
  "<script>window.knowledgeExecuted = true</script>\n<svg onload='alert(1)'>unsafe as markup</svg>\n第二行";
function disk(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b23-knowledge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProjectKnowledgeStore(root, () => [
    project(),
    project("p2"),
  ]);
  store.add("p1", [{ name: "notes.html", data: Buffer.from(text) }]);
  store.add("p2", [
    { name: "private.txt", data: Buffer.from("other project") },
  ]);
  return { root, store };
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function ui(
  store: ProjectKnowledgeStore,
  read?: (id: string, name: string) => Promise<KnowledgePreview>,
) {
  const calls: string[][] = [],
    errors: unknown[] = [];
  const env = await routineDom(
    {
      listProjectKnowledge: async (id) => store.list(id),
      readProjectKnowledge: async (id, name) => {
        calls.push([id, name]);
        return read ? read(id, name) : store.read(id, name);
      },
      listProjectKnowledgeDriveConnectors: async () => [],
      listProjectKnowledgeMcpServers: async () => [],
      listProjectKnowledgeRepositories: async () => [],
    },
    { jsdom: true },
  );
  // Collapsible schedules a second animation frame; use the browser's async
  // clock rather than routineDom's synchronous shorthand for simple fixtures.
  const oldCancel = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame",
  );
  const dimensions = new Map(
    ["innerWidth", "innerHeight"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: env.window.requestAnimationFrame.bind(env.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: env.window.cancelAnimationFrame.bind(env.window),
  });
  const reference: { current: AppController | undefined } = {
    current: undefined,
  };
  const owner = {
    accountId: "account-one",
    controllerScope: {},
    currentController: reference,
    snapshot: { projects: [project(), project("p2")] },
  } as unknown as AppController;
  reference.current = owner;
  const render = async (id = "p1") =>
    env.render(
      h(
        AppContext.Provider,
        { value: owner },
        h(ProjectKnowledge, {
          projectId: id,
          onError: (error) => errors.push(error),
        }),
      ),
    );
  await render();
  return {
    ...env,
    render,
    calls,
    errors,
    owner,
    reference,
    async clean() {
      await env.clean();
      if (oldCancel)
        Object.defineProperty(globalThis, "cancelAnimationFrame", oldCancel);
      else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
      for (const [key, value] of dimensions) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("bounded file reads use actual project/account folders and reject links, traversal and non-members", (t) => {
  const { root, store } = disk(t);
  assert.deepEqual(store.read("p1", "notes.html"), {
    name: "notes.html",
    bytes: Buffer.byteLength(text),
    kind: "text",
    text,
  });
  for (const [id, name] of [
    ["p1", "../p2/knowledge/private.txt"],
    ["p1", "private.txt"],
    ["deleted", "notes.html"],
    ["p1", "notes.html/../notes.html"],
    ["p1", "notes.html\\x"],
  ])
    assert.throws(() => store.read(id, name));
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "must stay outside");
  fs.symlinkSync(outside, path.join(store.folder("p1"), "link.txt"));
  assert.throws(() => store.read("p1", "link.txt"));
  fs.symlinkSync(
    store.folder("p2"),
    path.join(store.folder("p1"), "linked-dir"),
  );
  assert.throws(() => store.read("p1", "linked-dir/private.txt"));
  const isolated = new ProjectKnowledgeStore(
    path.join(root, "different-account"),
    () => [project()],
  );
  assert.throws(() => isolated.read("p1", "notes.html"));
  fs.renameSync(store.folder("p1"), `${store.folder("p1")}-real`);
  fs.symlinkSync(`${store.folder("p1")}-real`, store.folder("p1"));
  assert.throws(() => store.read("p1", "notes.html"));
});

test("reads distinguish bounded PDFs, unsupported types/encoding and over-limit disk files", (t) => {
  const { store } = disk(t),
    folder = store.folder("p1");
  const pdf = Buffer.from("%PDF-1.7\nexample bounded bytes");
  store.add("p1", [{ name: "paper.pdf", data: pdf }]);
  assert.deepEqual(store.read("p1", "paper.pdf"), {
    name: "paper.pdf",
    bytes: pdf.length,
    kind: "pdf",
    base64: pdf.toString("base64"),
  });
  for (const [name, bytes, reason] of [
    ["external.exe", Buffer.from("binary"), "type"],
    ["broken.txt", Buffer.from([255, 254]), "encoding"],
    ["broken.pdf", Buffer.from("not PDF"), "invalid-pdf"],
  ] as const) {
    fs.writeFileSync(path.join(folder, name), bytes);
    assert.deepEqual(store.read("p1", name), {
      name,
      bytes: bytes.length,
      kind: "unsupported",
      reason,
    });
  }
  const large = path.join(folder, "large.txt"),
    fd = fs.openSync(large, "w");
  fs.ftruncateSync(fd, knowledgeFileLimit + 1);
  fs.closeSync(fd);
  assert.deepEqual(store.read("p1", "large.txt"), {
    name: "large.txt",
    bytes: knowledgeFileLimit + 1,
    kind: "unsupported",
    reason: "too-large",
  });
});

test("normal rendered rows open a loading content viewer and display HTML/SVG as inert text; Back returns to context", async (t) => {
  const { store } = disk(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const env = await ui(store, async (id, name) => {
    await waiting;
    return store.read(id, name);
  });
  try {
    const row = env.document.querySelector('button[aria-label="notes.html"]');
    assert.equal(row?.tagName, "BUTTON");
    assert.equal(row?.getAttribute("aria-haspopup"), "dialog");
    await env.event(row!, "click");
    await settle();
    assert.deepEqual(env.calls, [["p1", "notes.html"]]);
    assert.match(
      env.document.querySelector('[role="dialog"]')?.textContent ?? "",
      /Loading file/,
    );
    await act(async () => release());
    assert.equal(
      env.document.querySelector(".prj-knowledge-preview-text")?.textContent,
      text,
    );
    assert.equal(
      env.document.querySelector(".prj-knowledge-preview-body script"),
      null,
    );
    assert.equal(
      env.document.querySelector(".prj-knowledge-preview-body svg"),
      null,
    );
    await env.click('button[aria-label="Back to context"]');
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    assert.ok(env.document.querySelector('button[aria-label="notes.html"]'));
    assert.equal(
      env.document
        .querySelector('[aria-label="Project file storage"]')
        ?.getAttribute("aria-valuetext"),
      `${Buffer.byteLength(text)}B / 100MB`,
    );
    assert.doesNotMatch(
      env.document.querySelector(".prj-capacity-copy")?.textContent ?? "",
      /project capacity|token/i,
    );
  } finally {
    release();
    await env.clean();
  }
});

test("rendered viewer retries a real failed disk read and closes on Escape", async (t) => {
  const { store } = disk(t);
  let attempts = 0;
  const env = await ui(store, async (id, name) => {
    attempts++;
    return store.read(id, attempts === 1 ? "missing.txt" : name);
  });
  try {
    await env.click('button[aria-label="notes.html"]');
    await settle();
    assert.match(
      env.document.querySelector('[role="alert"]')?.textContent ?? "",
      /Failed to load file/,
    );
    const retry = [...env.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await env.event(retry, "click");
    assert.equal(attempts, 2);
    assert.equal(env.document.querySelector("pre")?.textContent, text);
    await env.event(env.document, "keydown", { key: "Escape" });
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("actual preview downloads preserve UTF-8 bytes and a retired owner cannot reuse Download", async (t) => {
  const { store } = disk(t),
    env = await ui(store);
  const downloads: Promise<{ name: string; text: string }>[] = [];
  const prototype = env.window.HTMLAnchorElement.prototype;
  const originalClick = prototype.click;
  prototype.click = function () {
    const name = this.download;
    downloads.push(
      fetch(this.href).then(async (response) => ({
        name,
        text: await response.text(),
      })),
    );
  };
  try {
    await env.click('button[aria-label="notes.html"]');
    await settle();
    const download = [...env.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Download file",
    )!;
    await env.event(download, "click");
    assert.deepEqual(await Promise.all(downloads), [
      { name: "notes.html", text },
    ]);
    env.reference.current = { ...env.owner, accountId: "retired-account" };
    await env.event(download, "click");
    assert.equal(downloads.length, 1);
  } finally {
    prototype.click = originalClick;
    await env.clean();
  }
});

test("an editable preview has a Remove button that takes the file out; a read-only one has none", async (t) => {
  const { store } = disk(t);
  const file = store.list("p1").files[0];
  const env = await routineDom(
    { readProjectKnowledge: async (id, name) => store.read(id, name) },
    { jsdom: true },
  );
  const removed: string[] = [];
  try {
    for (const editable of [false, true]) {
      await env.render(
        h(KnowledgePreviewDialog, {
          projectId: "p1",
          file,
          owns: () => true,
          onClose() {},
          onRemove: editable ? () => removed.push(file.name) : undefined,
        }),
      );
      const remove = [...env.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove",
      );
      assert.equal(Boolean(remove), editable);
      if (remove) await env.event(remove, "click");
    }
    assert.equal(removed.join(), file.name);
  } finally {
    await env.clean();
  }
});

test("rendered unsupported preview preserves the context and exposes no executable frame or download", async (t) => {
  const { store } = disk(t);
  fs.writeFileSync(
    path.join(store.folder("p1"), "external.exe"),
    "actual unsupported bytes",
  );
  const file = store
    .list("p1")
    .files.find((file) => file.name === "external.exe")!;
  const env = await routineDom(
    { readProjectKnowledge: async (id, name) => store.read(id, name) },
    { jsdom: true },
  );
  try {
    await env.render(
      h(KnowledgePreviewDialog, {
        projectId: "p1",
        file,
        owns: () => true,
        onClose() {},
      }),
    );
    assert.match(
      env.document.querySelector('[role="dialog"]')?.textContent ?? "",
      /No preview/,
    );
    assert.equal(env.document.querySelector("iframe"), null);
    assert.ok(
      ![...env.document.querySelectorAll("button")].some(
        (button) => button.textContent === "Download file",
      ),
    );
    assert.equal(store.list("p1").files.length, 2);
  } finally {
    await env.clean();
  }
});

for (const retirement of [
  "account",
  "controller",
  "bridge",
  "project",
  "deleted",
] as const)
  test(`delayed rendered preview is discarded on ${retirement} retirement`, async (t) => {
    const { store } = disk(t);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = await ui(store, async (id, name) => {
      await gate;
      return store.read(id, name);
    });
    try {
      await env.click('button[aria-label="notes.html"]');
      await settle();
      assert.equal(env.calls.length, 1);
      if (retirement === "account")
        env.reference.current = { ...env.owner, accountId: "other-account" };
      if (retirement === "controller")
        env.reference.current = { ...env.owner, controllerScope: {} };
      if (retirement === "bridge")
        env.window.desktop = { ...env.window.desktop };
      if (retirement === "deleted")
        env.reference.current = {
          ...env.owner,
          snapshot: { projects: [] },
        } as unknown as AppController;
      if (retirement === "project") await env.render("p2");
      await act(async () => release());
      assert.equal(
        env.document.querySelector(".prj-knowledge-preview-text"),
        null,
      );
      assert.deepEqual(env.errors, []);
    } finally {
      release();
      await env.clean();
    }
  });

async function provider(t: TestContext) {
  let responseStatus = 200,
    body = "provider original";
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const message = JSON.parse(raw || "{}");
    requests.push(message);
    if (message.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    if (
      responseStatus !== 200 &&
      (message.method === "tools/call" || message.method === "resources/read")
    ) {
      res.writeHead(responseStatus);
      res.end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "knowledge-test", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "search",
                  inputSchema: { properties: { query: { type: "string" } } },
                },
                {
                  name: "fetch",
                  inputSchema: { properties: { id: { type: "string" } } },
                },
              ],
            }
          : message.method === "tools/call"
            ? { structuredContent: { text: body }, content: [] }
            : message.method === "resources/list"
              ? { resources: [{ uri: "test://page", name: "Page" }] }
              : { contents: [{ uri: message.params?.uri, text: body }] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const port = (server.address() as { port: number }).port;
  const config = { url: `http://127.0.0.1:${port}/mcp`, enabled: true };
  const configs: Record<string, typeof config> = {
    "Google Drive": config,
    Research: config,
  };
  const ctx = {
    store: { settings: { mcpServers: configs } },
    policy: () => ({}),
  } as unknown as Pick<ElectronContext, "store" | "policy" | "connectors">;
  return {
    ctx,
    configs,
    requests,
    status(value: number) {
      responseStatus = value;
    },
    body(value: string) {
      body = value;
    },
  };
}

for (const kind of ["gdrive", "mcp"] as const)
  test(`${kind} real HTTP provider sync separates auth, denial, missing and retryable failures and recovers cached data`, async (t) => {
    const { store } = disk(t),
      remote = await provider(t);
    const source =
      kind === "gdrive"
        ? new ProjectKnowledgeDrive(remote.ctx)
        : new ProjectKnowledgeMcp(remote.ctx);
    const added =
      kind === "gdrive"
        ? await (source as ProjectKnowledgeDrive).add(
            store,
            "p1",
            "Google Drive",
            [
              {
                id: "actual-id",
                title: "Roadmap",
                url: "https://docs.google.com/document/d/actual-id/edit",
              },
            ],
          )
        : await (source as ProjectKnowledgeMcp).add(store, "p1", "Research", {
            uri: "test://page",
            name: "Page",
          });
    const file = added.files.find((file) => file.source?.provider === kind)!;
    assert.equal(
      (store.read("p1", file.name) as KnowledgePreview & { kind: "text" }).text,
      "provider original",
    );
    for (const [status, failure, state] of [
      [401, "reconnect", "inaccessible"],
      [403, "forbidden", "inaccessible"],
      [404, "not-found", "inaccessible"],
      [503, "temporary", "failed"],
    ] as const) {
      remote.status(status);
      const failed = await source.sync(store, "p1", file.name);
      const result = failed.files.find(
        (entry) => entry.name === file.name,
      )!.source!;
      assert.equal(result.failure, failure);
      assert.equal(result.status, state);
      assert.equal(result.lastSyncedAt, file.source!.lastSyncedAt);
      assert.equal(
        (store.read("p1", file.name) as KnowledgePreview & { kind: "text" })
          .text,
        "provider original",
      );
    }
    remote.status(200);
    remote.body("provider recovered");
    const recovered = (await source.sync(store, "p1", file.name)).files.find(
      (entry) => entry.name === file.name,
    )!.source!;
    assert.equal(recovered.status, "idle");
    assert.equal(recovered.failure, undefined);
    assert.equal(
      (store.read("p1", file.name) as KnowledgePreview & { kind: "text" }).text,
      "provider recovered",
    );
    assert.ok(
      remote.requests.some(
        (call) =>
          call.method === (kind === "gdrive" ? "tools/call" : "resources/read"),
      ),
    );
    remote.configs[kind === "gdrive" ? "Google Drive" : "Research"].enabled =
      false;
    const disconnected = (await source.sync(store, "p1", file.name)).files.find(
      (entry) => entry.name === file.name,
    )!.source!;
    assert.equal(disconnected.failure, "reconnect");
  });

test("MCP URL resolution reports actual denied/missing/auth outcomes and retains the supported resolve mechanism", async (t) => {
  const remote = await provider(t),
    source = new ProjectKnowledgeMcp(remote.ctx);
  for (const [status, copy] of [
    [401, /Reconnect/],
    [403, /denied/],
    [404, /no longer available/],
    [503, /supports this URL/],
  ] as const) {
    remote.status(status);
    await assert.rejects(
      source.resolve("Research", "https://example.com/page"),
      copy,
    );
  }
  remote.status(200);
  assert.deepEqual(
    await source.resolve("Research", "https://example.com/page"),
    { uri: "https://example.com/page", name: "https://example.com/page" },
  );
});

test("GitHub sync uses actual tree/blob provider paths, preserves bytes on explicit HTTP access loss and recovers", async (t) => {
  const { store } = disk(t),
    name = "owner/repo/docs.md";
  store.add("p1", [{ name, data: Buffer.from("cached github") }]);
  store.setSource("p1", name, {
    provider: "github",
    repository: "owner/repo",
    branch: "main",
    path: "docs.md",
    status: "idle",
    lastSyncedAt: 1,
  });
  const calls: string[][] = [];
  let status = 403,
    missing = false;
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (status !== 200)
      return {
        code: 1,
        stdout: "",
        stderr: `gh: provider refused (HTTP ${status})`,
      };
    const result = args[1].includes("git/trees")
      ? {
          tree: missing
            ? []
            : [
                {
                  path: "docs.md",
                  type: "blob",
                  mode: "100644",
                  sha: "a".repeat(40),
                  size: 8,
                },
              ],
        }
      : {
          encoding: "base64",
          content: Buffer.from("restored").toString("base64"),
          size: 8,
        };
    return { code: 0, stderr: "", stdout: JSON.stringify(result) };
  };
  for (const [httpStatus, failure] of [
    [403, "forbidden"],
    [401, "reconnect"],
    [404, "not-found"],
    [503, "temporary"],
  ] as const) {
    status = httpStatus;
    const result = (
      await syncKnowledgeRepositoryFile(store, "p1", name, run)
    ).files.find((file) => file.name === name)!.source!;
    assert.equal(result.failure, failure);
    assert.equal(
      (store.read("p1", name) as KnowledgePreview & { kind: "text" }).text,
      "cached github",
    );
  }
  status = 200;
  const result = (
    await syncKnowledgeRepositoryFile(store, "p1", name, run)
  ).files.find((file) => file.name === name)!.source!;
  assert.equal(result.status, "idle");
  assert.equal(result.failure, undefined);
  assert.ok(
    calls.some(
      (args) => args[1] === "repos/owner/repo/git/trees/main?recursive=1",
    ),
  );
  assert.ok(
    calls.some(
      (args) => args[1] === `repos/owner/repo/git/blobs/${"a".repeat(40)}`,
    ),
  );
  missing = true;
  assert.equal(
    (await syncKnowledgeRepositoryFile(store, "p1", name, run)).files.find(
      (file) => file.name === name,
    )!.source!.failure,
    "not-found",
  );
});

test("rendered linked rows distinguish provider failures, reserve sync for retryable failures, and keep cached previews", async (t) => {
  const { store } = disk(t),
    name = "linked.md";
  store.add("p1", [{ name, data: Buffer.from("cached source content") }]);
  const reasons = [
    ["reconnect", "Reconnect source to sync"],
    ["forbidden", "Source access denied"],
    ["not-found", "Source no longer available"],
    ["resolution", "Source URL could not be resolved"],
    ["temporary", "Sync failed"],
  ] as const;
  for (const [failure, copy] of reasons) {
    store.setSource("p1", name, {
      provider: "mcp",
      server: "Research",
      uri: "test://page",
      name: "Page",
      lastSyncedAt: 1,
      status: failure === "temporary" ? "failed" : "inaccessible",
      failure,
    });
    const env = await ui(store);
    try {
      assert.match(
        env.document.querySelector(".prj-context-list")?.textContent ?? "",
        new RegExp(copy),
      );
      await env.click('button[aria-label="Page"]');
      await settle();
      assert.equal(
        env.document.querySelector("pre")?.textContent,
        "cached source content",
      );
      await env.click('button[aria-label="Back to context"]');
      await env.click('button[aria-label="More options for Page"]');
      const menu = env.document.querySelector('[role="menu"]')!;
      assert.match(menu.textContent ?? "", /Remove from project/);
      if (failure === "temporary")
        assert.match(menu.textContent ?? "", /Retry sync/);
      else
        assert.doesNotMatch(
          menu.textContent ?? "",
          /Check source again|Retry sync|Sync now/,
        );
    } finally {
      await env.clean();
    }
  }
});
