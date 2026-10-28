import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  registerArtifactToolHandlers,
  readMcpResponse,
  withArtifactConnector,
} from "../../electron/artifacts/artifact-tools";
import type { AppContext, IpcHandle } from "../../electron/app/app-context";
import { ArtifactToolDialog } from "../../src/artifacts/ArtifactToolDialog";
import { ArtifactScheduledTaskDialog } from "../../src/artifacts/ArtifactScheduledTaskDialog";
import { htmlDocument } from "../../src/artifacts/preview-document";
import {
  artifactToolMessage,
  artifactToolResult,
  artifactToolIdentity,
  artifactToolPreview,
  artifactToolDisplay,
} from "../../shared/artifact-tools";

test("connector transport initializes MCP, sends the session and calls the selected tool", async () => {
  const calls: { method: string; headers: Headers; body: any }[] = [];
  const fetch_ = (async (_url: unknown, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method: init.method!,
      headers: new Headers(init.headers),
      body,
    });
    return body?.id
      ? Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result:
              body.method === "initialize"
                ? { protocolVersion: "2025-03-26" }
                : { content: [{ type: "text", text: "done" }] },
          },
          { headers: { "mcp-session-id": "session" } },
        )
      : new Response(null, { status: 202 });
  }) as typeof fetch;
  const result = await withArtifactConnector(
    { url: "https://tools.example/mcp" },
    (request) =>
      request("tools/call", { name: "search", arguments: { query: "hello" } }),
    { fetch: fetch_, token: "secret", remoteOnly: true },
  );
  assert.equal(result.content[0].text, "done");
  assert.deepEqual(
    calls.map((call) => call.body?.method ?? call.method),
    ["initialize", "notifications/initialized", "tools/call", "DELETE"],
  );
  assert.equal(calls[2].headers.get("mcp-session-id"), "session");
  assert.equal(calls[2].headers.get("authorization"), "Bearer secret");
  assert.equal(calls[1].headers.get("mcp-protocol-version"), "2025-03-26");
  assert.equal(calls[3].headers.get("mcp-protocol-version"), "2025-03-26");
  assert.equal(calls[2].body.params.arguments.query, "hello");
});

test("MCP streaming replies skip notifications and stop at the matching result", async () => {
  const response = new Response(
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );
  assert.deepEqual(await readMcpResponse(response, 7), { ok: true });
  await assert.rejects(
    readMcpResponse(Response.json({ id: 7, error: { message: "oops" } }), 7),
  );
});

test("artifact decisions are single-use, account-scoped, revocable and invalidated by connector changes", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-tools-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers: Record<string, (...args: any[]) => any> = {};
  let ran = 0;
  const settings = {
    mcpServers: { search: { url: "https://tools.example/mcp" } } as Record<
      string,
      Record<string, unknown>
    >,
  };
  const ctx = {
    store: {
      root,
      settings,
      write: (name: string, value: unknown) =>
        fs.writeFileSync(path.join(root, name), JSON.stringify(value)),
    },
    policy: () => ({}),
    connectors: {
      fetch: (async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (!body.id) return new Response(null, { status: 202 });
        if (body.method === "tools/call") ran++;
        return Response.json({ id: body.id, result: { content: [] } });
      }) as typeof fetch,
    },
  } as unknown as AppContext;
  const handle = ((name: string, handler: (...args: any[]) => any) => {
    handlers[name] = handler;
  }) as IpcHandle;
  registerArtifactToolHandlers(handle, ctx);
  const call = { server: "search", tool: "lookup", input: { query: "x" } };
  const first = handlers.requestArtifactTool("artifact-a", call);
  assert.equal(first.permitted, false);
  assert.equal(ran, 0);
  await assert.rejects(handlers.respondArtifactTool(first.id, false));
  const allowed = handlers.requestArtifactTool("artifact-a", call);
  await handlers.respondArtifactTool(allowed.id, true);
  assert.equal(ran, 1);
  const restored: Record<string, (...args: any[]) => any> = {};
  registerArtifactToolHandlers(
    ((name, handler) => {
      restored[name] = handler;
    }) as IpcHandle,
    ctx,
  );
  assert.equal(
    restored.requestArtifactTool("artifact-a", call).permitted,
    true,
  );
  const originalStore = ctx.store;
  const otherRoot = path.join(root, "other-account");
  fs.mkdirSync(otherRoot);
  (ctx as any).store = {
    ...originalStore,
    root: otherRoot,
    write: (name: string, value: unknown) =>
      fs.writeFileSync(path.join(otherRoot, name), JSON.stringify(value)),
  };
  assert.equal(
    handlers.requestArtifactTool("artifact-a", call).permitted,
    false,
  );
  (ctx as any).store = originalStore;
  await assert.rejects(handlers.respondArtifactTool(allowed.id, true));
  assert.equal(
    handlers.requestArtifactTool("artifact-a", call).permitted,
    true,
  );
  assert.equal(
    handlers.requestArtifactTool("artifact-b", call).permitted,
    false,
  );
  settings.mcpServers.search.url = "https://different.example/mcp";
  assert.equal(
    handlers.requestArtifactTool("artifact-a", call).permitted,
    false,
  );
  settings.mcpServers.search.disabled_tools = ["lookup"];
  assert.throws(() => handlers.requestArtifactTool("artifact-a", call));
  delete settings.mcpServers.search.disabled_tools;
  const waiting = handlers.requestArtifactTool("artifact-a", call);
  handlers.revokeArtifactTools("artifact-a");
  await assert.rejects(handlers.respondArtifactTool(waiting.id, true));
  assert.deepEqual(handlers.artifactToolPermissions("artifact-a"), []);
  const other: Record<string, (...args: any[]) => any> = {};
  registerArtifactToolHandlers(
    ((name, handler) => {
      other[name] = handler;
    }) as IpcHandle,
    ctx,
  );
  assert.equal(other.requestArtifactTool("artifact-a", call).permitted, false);
});

test("tool permissions follow an artifact's identity rather than its changing contents", () => {
  assert.equal(
    artifactToolIdentity({ id: "block", conversationId: "chat" }),
    artifactToolIdentity({ id: "block", conversationId: "chat" }),
  );
  assert.notEqual(
    artifactToolIdentity({ id: "block", conversationId: "chat" }),
    artifactToolIdentity({ id: "other", conversationId: "chat" }),
  );
});

test("tool argument presentation follows official readable keys, lookalike checks and truncation", () => {
  assert.deepEqual(artifactToolPreview({ searchQuery: "hello" }).rows, [
    { label: "Search query", text: '"hello"', stacked: false },
  ]);
  assert.equal(artifactToolPreview({ query: "one", Query: "two" }).rows, null);
  assert.equal(artifactToolPreview({ call: "one", ca11: "two" }).rows, null);
  const long = artifactToolPreview({ value: "x".repeat(21000) });
  assert.equal(long.shortened, true);
  assert.equal(long.text.length, 2000);
  assert.equal(long.rows, null);
  assert.equal(artifactToolDisplay("abc\u202Edef"), "abc\\u202Edef");
  assert.equal(artifactToolDisplay("long value", 5), "long…");
  const markup = renderToStaticMarkup(
    createElement(ArtifactToolDialog, {
      request: {
        id: "id",
        server: "server",
        tool: "tool",
        input: { long: "x".repeat(21000) },
        groups: [{ server: "server", tools: ["tool"] }],
        permitted: false,
      },
      busy: false,
      onDecision() {},
    }),
  );
  assert.match(markup, /Only the start is shown. All of it will be sent./);
  assert.match(markup, /disabled=""/);
});

test("stdio artifacts initialize and execute through the configured MCP process", async () => {
  const code = `const lines=require('node:readline').createInterface({input:process.stdin});lines.on('line',line=>{const message=JSON.parse(line);if(message.id)console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?{protocolVersion:'2025-03-26'}:{content:[{type:'text',text:message.params.arguments.query}]}}))});`;
  const result = await withArtifactConnector(
    { command: process.execPath, args: ["-e", code] },
    (request) =>
      request("tools/call", {
        name: "search",
        arguments: { query: "stdio result" },
      }),
  );
  assert.equal(result.content[0].text, "stdio result");
});

test("the tool-set dialog shows every connector and the exact data without ICU copy", () => {
  const markup = renderToStaticMarkup(
    createElement(ArtifactToolDialog, {
      request: {
        id: "request",
        permitted: false,
        server: "a",
        tool: "search",
        input: { query: "<private>" },
        groups: [
          { server: "a", tools: ["search"] },
          { server: "b", tools: ["edit"] },
        ],
      },
      busy: false,
      onDecision() {},
    }),
  );
  assert.match(markup, /Let this artifact run these 2 tools\?/);
  assert.match(markup, /Tools to allow/);
  assert.match(markup, /From/);
  assert.match(markup, /&lt;private&gt;/);
  assert.doesNotMatch(markup, /plural|organization/);
});

test("sandboxed HTML exposes MCP independently of complete and trusts replies only from its parent", async () => {
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const posted: any[] = [];
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  const window: any = {};
  const timers = new Map();
  const sandbox = vm.createContext({
    window,
    parent,
    navigator: { userActivation: { isActive: true } },
    addEventListener: (name: string, listener: any) => {
      (listeners[name] ??= []).push(listener);
    },
    setTimeout: (callback: unknown) => {
      timers.set(callback, callback);
      return callback;
    },
    clearTimeout: (callback: unknown) => timers.delete(callback),
  });
  for (const match of htmlDocument("<h1>Artifact</h1>").matchAll(
    /<script>([\s\S]*?)<\/script>/g,
  ))
    vm.runInContext(match[1], sandbox);
  assert.equal(window.claude.complete, undefined);
  const promise = window.claude.mcp.callTool("connector", "search", {
    query: "test",
  });
  const request = posted[0];
  assert.equal(request.type, artifactToolMessage);
  for (const listener of listeners.message)
    listener({
      source: {},
      data: { type: artifactToolResult, id: request.id, result: "wrong" },
    });
  for (const listener of listeners.message)
    listener({
      source: parent,
      data: { type: artifactToolResult, id: request.id, result: "right" },
    });
  assert.equal(await promise, "right");
  const task = window.claude.runScheduledTask("daily-review");
  const taskRequest = posted.at(-1);
  assert.equal(taskRequest.method, "runScheduledTask");
  assert.deepEqual(Array.from(taskRequest.args), ["daily-review", true]);
  assert.notEqual(taskRequest.id, request.id);
  for (const listener of listeners.message)
    listener({
      source: parent,
      data: {
        type: artifactToolResult,
        id: taskRequest.id,
        result: { sessionId: "child" },
      },
    });
  assert.equal((await task).sessionId, "child");
  vm.runInContext("navigator.userActivation.isActive = false", sandbox);
  const inactive = window.claude.runScheduledTask("daily-review");
  const inactiveRequest = posted.at(-1);
  assert.equal(inactiveRequest.args[1], false);
  for (const listener of listeners.message)
    listener({
      source: parent,
      data: {
        type: artifactToolResult,
        id: inactiveRequest.id,
        result: { isError: true },
      },
    });
  assert.equal((await inactive).isError, true);
});

test("artifact task confirmation uses the official copy and safe default", () => {
  const html = renderToStaticMarkup(
    createElement(ArtifactScheduledTaskDialog, {
      artifact: "Dashboard",
      task: "daily-review",
      onDecision() {},
    }),
  );
  assert.match(html, /Allow &quot;Dashboard&quot; to run a scheduled task\?/);
  assert.match(
    html,
    /The live artifact &quot;Dashboard&quot; wants to run the scheduled task &quot;daily-review&quot;\./,
  );
  assert.match(html, /Don&#x27;t ask again for this task/);
  assert.match(html, /disabled=""[^>]*>Run/);
});
