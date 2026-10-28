import { ProjectKnowledgeMcp } from "../../electron/projects/project-knowledge-mcp";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "../../shared/types";
import type { KnowledgeRepositorySource } from "../../shared/collections-api";
import type { AppContext } from "../../electron/app/app-context";
import type { GhRunner } from "../../electron/git/github-cli";
import { withArtifactConnector } from "../../electron/artifacts/artifact-tools";
import { ProjectKnowledgeStore } from "../../electron/projects/project-knowledge";
import { syncKnowledgeRepositoryFile } from "../../electron/projects/project-knowledge-github";
import { ProjectKnowledgeDrive } from "../../electron/projects/project-knowledge-drive";
import { KnowledgeList } from "../../src/collections/projects/KnowledgeList";
import { webRemoteRunnerMethods } from "../../shared/web-bridge-methods";
import { openPolicy } from "../../shared/client-policy";
import { knowledgeFileMatches } from "../../src/collections/projects/knowledge-tree";

const project: Project = {
  id: "p1",
  name: "Research",
  description: "",
  instructions: "",
  createdAt: 1,
};
const source: KnowledgeRepositorySource = {
  provider: "github",
  repository: "owner/repo",
  branch: "release",
  path: "docs/notes.md",
  status: "idle",
  lastSyncedAt: 1,
};
const name = "owner/repo/docs/notes.md";

function fixture(context: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-sources-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProjectKnowledgeStore(root, () => [project]);
  store.add(project.id, [{ name, data: Buffer.from("old") }]);
  store.setSource(project.id, name, source);
  return {
    root,
    store,
    content: () =>
      fs.readFileSync(path.join(store.folder(project.id), name), "utf8"),
  };
}

const github =
  (text: string, fail = false): GhRunner =>
  async (args) => {
    if (fail) return { code: 1, stdout: "", stderr: "unavailable" };
    if (args[1].includes("git/trees")) {
      assert.match(args[1], /git\/trees\/release\?recursive=1$/);
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          tree: [
            {
              path: source.path,
              type: "blob",
              mode: "100644",
              sha: "a".repeat(40),
              size: text.length,
            },
          ],
        }),
      };
    }
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        encoding: "base64",
        content: Buffer.from(text).toString("base64"),
        size: Buffer.byteLength(text),
      }),
    };
  };

test("GitHub sources persist branch and selection, refresh at the branch head, and keep metadata out of context", async (context) => {
  const { root, store, content } = fixture(context);
  assert.deepEqual(
    new ProjectKnowledgeStore(root, () => [project]).list(project.id).files[0]
      .source,
    source,
  );
  const synced = await syncKnowledgeRepositoryFile(
    store,
    project.id,
    name,
    github("new content"),
  );
  assert.equal(content(), "new content");
  assert.equal(synced.files.length, 1);
  assert.equal(synced.bytes, 11);
  assert.equal(synced.files[0].source?.status, "idle");
  assert.ok(synced.files[0].source!.lastSyncedAt > 1);
  assert.deepEqual(fs.readdirSync(store.folder(project.id)), ["owner"]);
});

test("failed sync retains last good bytes, persists failure, and can retry; removed upstream files fail safely", async (context) => {
  const { root, store, content } = fixture(context);
  const failed = await syncKnowledgeRepositoryFile(
    store,
    project.id,
    name,
    github("", true),
  );
  assert.equal(failed.files[0].source?.status, "failed");
  assert.equal(content(), "old");
  assert.equal(
    new ProjectKnowledgeStore(root, () => [project]).list(project.id).files[0]
      .source?.status,
    "failed",
  );
  const retried = await syncKnowledgeRepositoryFile(
    store,
    project.id,
    name,
    github("recovered"),
  );
  assert.equal(retried.files[0].source?.status, "idle");
  assert.equal(content(), "recovered");
  const missing: GhRunner = async () => ({
    code: 0,
    stderr: "",
    stdout: '{"tree":[]}',
  });
  const removed = await syncKnowledgeRepositoryFile(
    store,
    project.id,
    name,
    missing,
  );
  assert.equal(removed.files[0].source?.status, "inaccessible");
  assert.equal(removed.files[0].source?.failure, "not-found");
  assert.equal(content(), "recovered");
});

test("sync never resurrects a removed source; replacing it with an upload removes the sync association", async (context) => {
  const { store } = fixture(context);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run: GhRunner = async (args, limit) => {
    await waiting;
    return github("late")(args, limit);
  };
  const pending = syncKnowledgeRepositoryFile(store, project.id, name, run);
  await assert.rejects(
    syncKnowledgeRepositoryFile(store, project.id, name, github("other")),
  );
  store.remove(project.id, name);
  release();
  assert.deepEqual((await pending).files, []);
  store.add(project.id, [{ name, data: Buffer.from("uploaded") }]);
  assert.equal(store.list(project.id).files[0].source, undefined);
  await assert.rejects(
    syncKnowledgeRepositoryFile(store, project.id, name, github("other")),
  );
});

test("synced rows show the live idle, syncing and failure copy, not internal storage folders", () => {
  for (const [status, syncing, text] of [
    ["idle", false, "Synced source"],
    ["failed", false, "Sync failed"],
    ["idle", true, "Syncing..."],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(KnowledgeList, {
        files: [{ name, bytes: 3, addedAt: 1, source: { ...source, status } }],
        busy: syncing,
        syncing: syncing ? name : undefined,
        onSync() {},
        onPick() {},
        onRemove() {},
      }),
    );
    assert.match(html, new RegExp(text.replaceAll(".", "\\.")));
    assert.match(html, /data-icon="Link"/);
    assert.doesNotMatch(html, /Open folder/);
  }
});

function driveFixture() {
  const calls: { name: string; arguments: Record<string, string> }[] = [];
  let text = "Drive document";
  let failed = false;
  const config: Record<string, unknown> = {
    url: "https://drive.example/mcp",
    enabled: true,
  };
  const ctx = {
    store: { settings: { mcpServers: { "Google Drive": config } } },
    policy: () => ({}),
  } as unknown as Pick<AppContext, "store" | "policy" | "connectors">;
  const file = {
    id: "file-123",
    title: "Roadmap",
    url: "https://docs.google.com/document/d/file-123/edit",
  };
  const connect: typeof withArtifactConnector = async (_config, run) =>
    run(async (method, raw) => {
      if (method === "tools/list")
        return {
          tools: [
            {
              name: "search",
              inputSchema: {
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
            {
              name: "fetch",
              inputSchema: {
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
          ],
        };
      const params = raw as (typeof calls)[number];
      calls.push(params);
      if (failed)
        return { isError: true, content: [{ type: "text", text: "failure" }] };
      const result = params.name === "search" ? { results: [file] } : { text };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
  return {
    drive: new ProjectKnowledgeDrive(ctx, connect),
    connect,
    config,
    ctx,
    file,
    calls,
    text(value: string) {
      text = value;
    },
    fail(value: boolean) {
      failed = value;
    },
  };
}

test("connected Drive search/fetch imports real context, persists the source, syncs and retries", async (context) => {
  const { store } = fixture(context);
  const drive = driveFixture();
  assert.deepEqual(await drive.drive.connectors(), ["Google Drive"]);
  assert.deepEqual(await drive.drive.search("Google Drive", "roadmap"), [
    drive.file,
  ]);
  const added = await drive.drive.add(store, project.id, "Google Drive", [
    drive.file,
  ]);
  const imported = added.files.find(
    (file) => file.source?.provider === "gdrive",
  )!;
  assert.equal(imported.source?.provider, "gdrive");
  const target = path.join(store.folder(project.id), imported.name);
  assert.equal(fs.readFileSync(target, "utf8"), "Drive document");
  assert.deepEqual(drive.calls[1], {
    name: "fetch",
    arguments: { id: drive.file.id },
  });
  drive.text("Updated document");
  const updated = await drive.drive.sync(store, project.id, imported.name);
  assert.equal(
    updated.files.find((file) => file.name === imported.name)?.source?.status,
    "idle",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "Updated document");
  drive.fail(true);
  const failed = await drive.drive.sync(store, project.id, imported.name);
  assert.equal(
    failed.files.find((file) => file.name === imported.name)?.source?.status,
    "failed",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "Updated document");
  drive.fail(false);
  drive.text("Recovered");
  await drive.drive.sync(store, project.id, imported.name);
  assert.equal(fs.readFileSync(target, "utf8"), "Recovered");
});

test("Drive honors disabled connectors, tool allowlists, policy, URL validation and project ownership", async (context) => {
  const { store } = fixture(context);
  const drive = driveFixture();
  drive.config.enabled = false;
  assert.deepEqual(await drive.drive.connectors(), []);
  await assert.rejects(drive.drive.search("Google Drive", "test"));
  drive.config.enabled = true;
  drive.config.disabled_tools = ["fetch"];
  assert.deepEqual(await drive.drive.connectors(), []);
  delete drive.config.disabled_tools;
  drive.config.enabled_tools = ["fetch"];
  assert.deepEqual(await drive.drive.connectors(), []);
  delete drive.config.enabled_tools;
  await assert.rejects(
    drive.drive.add(store, "missing", "Google Drive", [drive.file]),
  );
  await assert.rejects(
    drive.drive.add(store, project.id, "Google Drive", [
      { ...drive.file, url: "http://127.0.0.1/private" },
    ]),
  );
  drive.ctx.policy = () => ({ ...openPolicy, connectors: [] });
  assert.deepEqual(await drive.drive.connectors(), []);
});

test("source methods are served by the runner for web projects", () => {
  for (const method of [
    "syncProjectKnowledge",
    "listProjectKnowledgeDriveConnectors",
    "searchProjectKnowledgeDrive",
    "addProjectKnowledgeDriveFiles",
  ]) {
    assert.ok(
      webRemoteRunnerMethods.includes(
        method as (typeof webRemoteRunnerMethods)[number],
      ),
      method,
    );
  }
});

test("web Drive calls use the user's guarded connector transport and bearer token", async () => {
  const fixture = driveFixture();
  const urls: string[] = [];
  const forwarded: { url: string; method: string; token: string | null }[] = [];
  let denied = false;
  const fetcher: typeof fetch = async (input, init) => {
    const message = JSON.parse(String(init?.body));
    forwarded.push({
      url: String(input),
      method: message.method,
      token: new Headers(init?.headers).get("authorization"),
    });
    if (message.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (denied && message.method === "tools/call")
      return new Response(null, { status: 401 });
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {} }
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
          : { structuredContent: { results: [fixture.file] }, content: [] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
  Object.defineProperty(fixture.ctx, "connectors", {
    value: {
      fetch: fetcher,
      getToken: () => "private-token",
      setToken() {},
      async assertUrl(url: string) {
        urls.push(url);
      },
    },
  });
  // Run the real MCP transport: the observable wrapper must still call the
  // user's guarded fetch, carrying its bearer token and preserving status.
  const drive = new ProjectKnowledgeDrive(fixture.ctx);
  assert.deepEqual(await drive.connectors(), ["Google Drive"]);
  assert.deepEqual(urls, ["https://drive.example/mcp"]);
  assert.deepEqual(await drive.search("Google Drive", "roadmap"), [
    fixture.file,
  ]);
  denied = true;
  await assert.rejects(drive.search("Google Drive", "roadmap"), (error) =>
    Boolean(
      error &&
      typeof error === "object" &&
      "failure" in error &&
      error.failure === "reconnect",
    ),
  );
  assert.equal(urls.length, 3);
  assert.ok(forwarded.some((call) => call.method === "tools/call"));
  assert.ok(
    forwarded.every(
      (call) =>
        call.url === "https://drive.example/mcp" &&
        call.token === "Bearer private-token",
    ),
  );
});

test("Drive search and selection match the visible title even when storage names are shortened", () => {
  const file = {
    name: "Google Drive/hash/short.md",
    bytes: 1,
    addedAt: 1,
    source: {
      ...driveFixture().file,
      provider: "gdrive" as const,
      server: "Google Drive",
      status: "idle" as const,
      lastSyncedAt: 1,
      title: "Long document title with appendix",
    },
  };
  assert.equal(knowledgeFileMatches(file, "appendix"), true);
  const html = renderToStaticMarkup(
    createElement(KnowledgeList, {
      files: [file],
      query: "appendix",
      busy: false,
      onPick() {},
      onRemove() {},
    }),
  );
  assert.match(html, /Long document title with appendix/);
  assert.doesNotMatch(html, /No matching files/);
});

test("MCP resources: servers with resources are listed, filtered, resolved, added and synced", async (context) => {
  const { store } = fixture(context);
  let text = "Resource body";
  const reads: string[] = [];
  const configs: Record<string, Record<string, unknown>> = {
    Notion: { url: "https://notion.example/mcp", enabled: true },
    Empty: { url: "https://empty.example/mcp", enabled: true },
    Off: { url: "https://off.example/mcp", enabled: false },
    Local: { command: "node", enabled: true },
  };
  const ctx = {
    store: { settings: { mcpServers: configs } },
    policy: () => ({}),
  } as unknown as Pick<AppContext, "store" | "policy" | "connectors">;
  const connect: typeof withArtifactConnector = async (config, run) =>
    run(async (method, raw) => {
      const params = raw as { uri?: string; cursor?: string };
      if (method === "resources/list") {
        if (config === configs.Empty) return { resources: [] };
        return params.cursor
          ? { resources: [{ uri: "notion://page/2", name: "Plans" }] }
          : {
              resources: [
                {
                  uri: "notion://page/1",
                  name: "roadmap",
                  title: "Roadmap",
                  description: "Q4 plans",
                },
              ],
              nextCursor: "next",
            };
      }
      reads.push(params.uri!);
      if (params.uri === "https://bad.example/x") throw new Error("nope");
      return { contents: [{ uri: params.uri, text }] };
    });
  const mcp = new ProjectKnowledgeMcp(ctx, connect);
  assert.deepEqual(await mcp.servers(), ["Notion"]);
  assert.deepEqual(
    (await mcp.resources("Notion", "q4")).map((r) => r.uri),
    ["notion://page/1"],
  );
  assert.equal((await mcp.resources("Notion")).length, 2);
  await assert.rejects(
    mcp.resolve("Notion", "https://bad.example/x"),
    /Make sure the MCP server supports this URL/,
  );
  assert.deepEqual(await mcp.resolve("Notion", "https://ok.example/doc"), {
    uri: "https://ok.example/doc",
    name: "https://ok.example/doc",
  });
  await assert.rejects(
    mcp.add(store, project.id, "Off", { uri: "x://y", name: "y" }),
    /Failed to add MCP resource/,
  );
  await assert.rejects(
    mcp.add(store, project.id, "Local", { uri: "x://y", name: "y" }),
    /Failed to add MCP resource/,
  );
  const added = await mcp.add(store, project.id, "Notion", {
    uri: "notion://page/1",
    name: "roadmap",
    title: "Roadmap",
  });
  const file = added.files.find((entry) => entry.source?.provider === "mcp");
  assert.ok(file);
  assert.match(file.name, /^Notion\/[0-9a-f]{24}\/Roadmap\.md$/);
  text = "Updated body";
  await mcp.sync(store, project.id, file.name);
  assert.equal(
    fs.readFileSync(path.join(store.folder(project.id), file.name), "utf8"),
    "Updated body",
  );
});
