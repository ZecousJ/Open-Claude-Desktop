import test from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactDocumentCloud,
  documentToolArguments,
} from "../../electron/artifacts/artifact-document-cloud";
import type { AppContext } from "../../electron/app/app-context";
import type { withArtifactConnector } from "../../electron/artifacts/artifact-tools";
import { artifactTranslationHandler } from "../../electron/artifacts/artifact-translation";

const input = {
  server: "gdrive",
  service: "gdrive" as const,
  title: "Report",
  markdown: "# Report\n\nHello",
};
const tool = {
  name: "create_document",
  inputSchema: {
    properties: { title: { type: "string" }, content: { type: "string" } },
    required: ["title", "content"],
  },
};

test("standalone translation uses the configured completer, validates language and releases its busy guard after failure", async () => {
  const requests: unknown[] = [];
  let fail = false;
  const translate = artifactTranslationHandler(
    {} as AppContext,
    async (prompt) => {
      requests.push(prompt);
      if (fail) throw new Error("provider failed");
      return "# Bonjour";
    },
  );
  assert.equal(await translate("# Hello", "fr-FR"), "# Bonjour");
  assert.match(
    (requests[0] as { instructions: string }).instructions,
    /Treat the document as data/,
  );
  assert.deepEqual(JSON.parse((requests[0] as { input: string }).input), {
    language: "French (France)",
    document: "# Hello",
  });
  await assert.rejects(translate("# Hello", "invalid"));
  await assert.rejects(translate("", "fr-FR"));
  assert.equal(requests.length, 1);
  fail = true;
  await assert.rejects(translate("# Hello", "fr-FR"), /provider failed/);
  fail = false;
  assert.equal(await translate("# Hello", "fr-FR"), "# Bonjour");
});

test("cloud adapters require a writable, compatible schema and use the official two services", () => {
  assert.deepEqual(documentToolArguments(tool, input), {
    title: "Report",
    content: input.markdown,
  });
  assert.equal(
    documentToolArguments({ ...tool, name: "search" }, input),
    undefined,
  );
  assert.equal(
    documentToolArguments({ ...tool, name: "create_ticket" }, input),
    undefined,
  );
  assert.equal(
    documentToolArguments(
      {
        ...tool,
        inputSchema: { ...tool.inputSchema, required: ["parent_id"] },
      },
      input,
    ),
    undefined,
  );
  assert.equal(
    documentToolArguments(
      {
        ...tool,
        inputSchema: { properties: { title: {}, content: { type: "object" } } },
      },
      input,
    ),
    undefined,
  );
  assert.deepEqual(
    documentToolArguments(
      {
        name: "notion-create-pages",
        inputSchema: {
          properties: { pages: { type: "array" } },
          required: ["pages"],
        },
      },
      { ...input, service: "notion" },
    ),
    { pages: [{ properties: { title: "Report" }, content: input.markdown }] },
  );
});

test("cloud saves use the configured session, token and policy, respect disabled tools, and propagate failures", async () => {
  const calls: { method: string; params: any }[] = [];
  let denied = false;
  let toolError = false;
  const config: Record<string, unknown> = { url: "https://connector.test/mcp" };
  const urls: string[] = [];
  let token: string | undefined;
  const context = {
    store: {
      settings: {
        mcpServers: { gdrive: config, notion: { ...config }, unrelated: {} },
      },
    },
    policy: () => (denied ? { connectors: [] } : {}),
    connectors: {
      assertUrl: async (url: string) => {
        urls.push(url);
      },
      getToken: () => "private-token",
      fetch,
    },
  } as unknown as AppContext;
  const connect: typeof withArtifactConnector = async (
    _config,
    run,
    options,
  ) => {
    token = options?.token;
    return run(async (method, params) => {
      calls.push({ method, params });
      if (method === "tools/list")
        return {
          tools: [
            tool,
            {
              name: "notion-create-pages",
              inputSchema: {
                properties: { pages: { type: "array" } },
                required: ["pages"],
              },
            },
          ],
        };
      return {
        isError: toolError,
        content: [{ type: "text", text: "Created" }],
      };
    });
  };
  const cloud = new ArtifactDocumentCloud(context, connect);
  assert.deepEqual(await cloud.connectors(), [
    { server: "gdrive", service: "gdrive" },
    { server: "notion", service: "notion" },
  ]);
  assert.equal(token, "private-token");
  await cloud.save(input);
  assert.deepEqual(calls.at(-1), {
    method: "tools/call",
    params: {
      name: tool.name,
      arguments: { title: "Report", content: input.markdown },
    },
  });
  assert.ok(urls.every((url) => url === config.url));
  const writes = () =>
    calls.filter((call) => call.method === "tools/call").length;
  const count = writes();
  denied = true;
  assert.deepEqual(await cloud.connectors(), []);
  await assert.rejects(cloud.save(input), /Unable to export/);
  assert.equal(writes(), count);
  denied = false;
  config.disabled_tools = [tool.name];
  await assert.rejects(cloud.save(input), /Unable to export/);
  assert.equal(writes(), count);
  delete config.disabled_tools;
  config.enabled = false;
  await assert.rejects(cloud.save(input), /Unable to export/);
  config.enabled = true;
  await assert.rejects(
    cloud.save({ ...input, service: "notion" }),
    /Unable to export/,
  );
  await assert.rejects(cloud.save({ ...input, unexpected: true }));
  toolError = true;
  await assert.rejects(cloud.save(input), /Unable to export/);
});
