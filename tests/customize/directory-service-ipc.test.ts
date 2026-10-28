import test from "node:test";
import assert from "node:assert/strict";
import { useElectronShim } from "../runner/runner-core-support.test.ts";
import type { DirectorySubmissionInput } from "../../shared/directory-submissions";

useElectronShim();
const { registerCollectionHandlers } =
  await import("../../electron/ipc/collections");
const { Sub2ApiClient } = await import("../../electron/sub2api/client");

test("shared desktop/runner submission handlers authenticate and reverify live MCP tools", async () => {
  const requests: { url: string; authorization: string | null; body: any }[] =
    [];
  const client = new Sub2ApiClient(
    "https://claudex.example",
    async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("Authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ code: 0, data: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  const rpcCalls: string[] = [];
  const context = {
    onSettingsChanged() {},
    onAccountActivated() {},
    onAccountDeactivating() {},
    store: {
      root: "/tmp/directory-user",
      settings: { mcpServers: { example: { url: "https://example.com/mcp" } } },
    },
    engine: {
      rpc: {
        call: async (method: string) => {
          rpcCalls.push(method);
          return { data: [{ name: "example", tools: { actual_tool: {} } }] };
        },
      },
    },
    remote: {
      session: {
        authorized: (action: (token: string) => Promise<unknown>) =>
          action("signed-in-token"),
      },
      backend: { client },
    },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCollectionHandlers(
    (name, handler) => handlers.set(name, handler),
    context as any,
  );
  const input: DirectorySubmissionInput = {
    kind: "mcp",
    name: "Example",
    slug: "example",
    url: "https://example.com/mcp",
    description: "Useful tools",
    examples: "Read docs",
    email: "me@example.com",
    license: "MIT",
    termsAcknowledged: true,
    toolsVerified: true,
    serverName: "example",
    tools: ["forged_tool"],
  };
  await handlers.get("saveDirectorySubmission")!(input, true);
  await handlers.get("listDirectorySubmissions")!();
  await handlers.get("listApprovedDirectory")!();
  assert.deepEqual(rpcCalls, ["mcpServerStatus/list"]);
  assert.deepEqual(requests[0].body.input.tools, ["actual_tool"]);
  assert.equal(requests[0].body.submit, true);
  assert.equal(requests[0].authorization, "Bearer signed-in-token");
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://claudex.example/api/v1/claudex/directory/submissions",
      "https://claudex.example/api/v1/claudex/directory/submissions",
      "https://claudex.example/api/v1/claudex/directory",
    ],
  );
  await assert.rejects(
    handlers.get("saveDirectorySubmission")!(
      { ...input, url: "https://different.example/mcp" },
      true,
    ),
  );
  assert.equal(requests.length, 3);
});
