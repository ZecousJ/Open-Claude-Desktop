/** Hash-pinned original Code reader/adapter contracts, not DOM or real UI acceptance.
 * Only pure indexing, metadata sanitization and joining execute. React rendering,
 * connector resource/apps and live progress UI are not exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { protectedToolFailure } from "./support/f040-auth-rejection";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
import { convertCodeTranscript } from "../electron/official-ui/native/code-transcript";
import type { Conversation } from "../shared/types";
const root = process.env.CLAUDEX_ORIGINAL_CODE_ASSETS;
const builds = [
  {
    name: "cloud",
    file: "ccba96ec3-CZWy4vzM.js",
    hash: "2b30b19a4c6857d4e94c27563b27e256a968f5b9b918a0f79fa471dbe81835e5",
    functions: ["Vt", "Ht", "Hn", "Rn", "Bn"],
    initialize: "Vt",
    index: "Ht",
    join: "Hn",
    globals:
      'const zn = ["anthropic/claudeai.signedSourceCard", "coworkTypedArtifactCreated"];',
  },
  {
    name: "renderer",
    file: "ccba96ec3-Cxoh5fxJ.js",
    hash: "de6663433e6fd9e8d0a3f29a395f29afcd0e8cc431907c0cd240bdc538618b81",
    functions: ["$t", "en", "$n", "Xn", "Zn", "Qt"],
    initialize: "$t",
    index: "en",
    join: "$n",
    globals: 'const Oe = "anthropic/claudeai.signedSourceCard";',
  },
];
function original(build: (typeof builds)[number]) {
  const source = fs.readFileSync(
    path.join(root!, build.name, "assets", "v1", build.file),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    build.hash,
    "Original asset changed; verify contract before repinning",
  );
  const ast = ts.createSourceFile(
    build.file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const functions = build.functions.map((name) => {
    const matches = ast.statements.filter(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.equal(matches.length, 1, `Expected exactly one original ${name}`);
    return matches[0].getText(ast);
  });
  // Imported constant values only; no original function is replaced with a stub.
  return vm.runInNewContext(
    `${build.globals}\n${functions.join("\n")}\n({initialize:${build.initialize},index:${build.index},join:${build.join}})`,
    {},
    { timeout: 1000 },
  ) as {
    initialize(): any;
    index(rows: any[], start: number, end: number, state: any): void;
    join(
      row: any,
      results: Map<string, any>,
      metadata: Map<string, any>,
    ): any[];
  };
}
function conversation(
  items: any[],
  status: "completed" | "inProgress" = "completed",
): Conversation {
  return {
    id: "mcp-contract",
    title: "MCP contract",
    mode: "code",
    providerId: "test",
    model: "test",
    pinned: false,
    archived: false,
    createdAt: 1000,
    updatedAt: 1000,
    turns: [
      {
        id: "turn",
        prompt: "Question",
        attachments: [],
        status,
        createdAt: 1000,
        items,
      },
    ],
  };
}
function read(reader: ReturnType<typeof original>, rows: any[]) {
  const state = reader.initialize();
  reader.index(rows, 0, rows.length, state);
  const joined = rows
    .filter((row) => row.type === "assistant")
    .flatMap((row) =>
      reader.join(row, state.toolResultByIdMap, state.mcpToolMetadataMap),
    );
  return { state, joined: JSON.parse(JSON.stringify(joined)) as any[] };
}
const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHksAAAAASUVORK5CYII=";
const resource = {
  type: "resource_link",
  uri: "fixture://documents/manual.txt",
  name: "manual.txt",
  title: "Manual",
  description: "Fixture resource",
  mimeType: "text/plain",
};
const resourceLink = {
  type: "resource_link",
  uri: "fixture://documents/reference.txt",
  name: "reference.txt",
};
for (const build of builds) {
  test(
    `${build.name}: converted MCP text, image, resources and errors survive original reader`,
    { skip: !root },
    () => {
      const reader = original(build);
      const converted = convertCodeTranscript(
        conversation([
          {
            id: "ok",
            type: "mcpToolCall",
            server: "wiki",
            tool: "lookup",
            arguments: { query: "bicycle" },
            status: "completed",
            resource_links: [resourceLink],
            result: {
              content: [
                { type: "text", text: "Found" },
                { type: "image", mimeType: "image/png", data: imageData },
                resource,
                { type: "audio", mimeType: "audio/wav", data: "AAAA" },
              ],
              structuredContent: { count: 1 },
              _meta: { ui: { resourceUri: "ui://fixture" } },
            },
          },
          {
            id: "error",
            type: "mcpToolCall",
            server: "other",
            tool: "lookup",
            arguments: {},
            status: "completed",
            result: {
              isError: true,
              content: [{ type: "text", text: "Denied" }],
            },
          },
        ]),
      );
      const { joined } = read(reader, converted.rows);
      assert.equal(joined.length, 2);
      assert.equal(joined[0].name, "mcp__wiki__lookup");
      assert.equal(joined[1].name, "mcp__other__lookup");
      assert.equal(joined[0].tool_use_id, "turn:tool:ok");
      assert.equal(joined[0].is_error, false);
      assert.equal(joined[1].is_error, true);
      assert.deepEqual(joined[0].structured_content, { count: 1 });
      assert.deepEqual(joined[0].resource_links, [resourceLink, resource]);
      assert.equal(joined[0].meta, undefined);
      assert.deepEqual(joined[0].content, [
        { type: "text", text: "Found" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: imageData,
          },
        },
        resource,
      ]);
      assert.deepEqual(joined[1].content, [{ type: "text", text: "Denied" }]);
      const use = converted.rows.find((row) => row.type === "assistant")!;
      assert.deepEqual((use.message.content as any[])[0].input, {
        query: "bicycle",
      });
      const resultRow = converted.rows.find((row: any) => row.mcpMeta) as any;
      assert.deepEqual(resultRow.mcpMeta, {
        resourceLinks: [resourceLink, resource],
        structuredContent: { count: 1 },
      });
      assert.deepEqual(resultRow.toolUseResult, { structuredContent: { count: 1 } });
    },
  );
  test(
    `${build.name}: original reader receives MCP resource links`,
    { skip: !root },
    () => {
      const reader = original(build);
      const converted = convertCodeTranscript(
        conversation([
          {
            id: "links",
            type: "mcpToolCall",
            server: "wiki",
            tool: "lookup",
            status: "completed",
            result: {
              content: [
                {
                  type: "resource_link",
                  uri: "https://example.com/a",
                  name: "A",
                  title: "Title",
                  description: "Description",
                  mimeType: "text/plain",
                  _meta: { widget: "secret" },
                },
              ],
              structuredContent: { count: 1 },
              _meta: { widget: "secret" },
            },
          },
        ]),
      );
      const resultRow = converted.rows.find((row: any) => row.mcpMeta) as any;
      const expected = [
        {
          type: "resource_link",
          uri: "https://example.com/a",
          name: "A",
          title: "Title",
          description: "Description",
          mimeType: "text/plain",
        },
      ];
      assert.deepEqual(resultRow.mcpMeta.resourceLinks, expected);
      const { joined } = read(reader, converted.rows);
      assert.deepEqual(joined[0].resource_links, expected);
      assert.deepEqual(joined[0].structured_content, { count: 1 });
      assert.deepEqual(joined[0].content, expected);
      assert.ok(!JSON.stringify(joined).includes("secret"));
    },
  );
  test(
    `${build.name}: pending MCP is unmatched until terminal result arrives`,
    { skip: !root },
    () => {
      const reader = original(build);
      const item = {
        id: "pending",
        type: "mcpToolCall",
        server: "wiki",
        tool: "lookup",
        arguments: {},
        lifecycleStatus: "inProgress",
        progress: "Searching",
      };
      const pending = convertCodeTranscript(conversation([item], "inProgress"));
      const before = read(reader, pending.rows);
      assert.equal(before.joined.length, 0);
      assert.equal(before.state.toolResultByIdMap.size, 0);
      assert.ok(
        pending.rows.some(
          (row) =>
            row.type === "assistant" &&
            (row.message.content as any[]).some(
              (block) =>
                block.type === "tool_use" && block.name === "mcp__wiki__lookup",
            ),
        ),
      );
      const unmatched = convertCodeTranscript(
        conversation([{ ...item, lifecycleStatus: "completed", result: null }]),
      );
      assert.equal(read(reader, unmatched.rows).joined.length, 0);
      const completed = convertCodeTranscript(
        conversation([
          {
            ...item,
            lifecycleStatus: "completed",
            result: { content: [{ type: "text", text: "Done" }] },
          },
        ]),
      );
      const state = before.state;
      reader.index(completed.rows, 0, completed.rows.length, state);
      reader.index(completed.rows, 0, completed.rows.length, state);
      assert.equal(
        state.toolResultByIdMap.size,
        1,
        "Repeated snapshots replace indexed results",
      );
      const use = completed.rows.find((row) => row.type === "assistant")!;
      assert.equal(
        reader.join(use, state.toolResultByIdMap, state.mcpToolMetadataMap)
          .length,
        1,
      );
    },
  );
  test(
    `${build.name}: structured-only projection reaches the original reader as metadata`,
    { skip: !root },
    () => {
      const reader = original(build);
      const converted = convertCodeTranscript(
        conversation([
          {
            id: "structured",
            type: "mcpToolCall",
            server: "wiki",
            tool: "lookup",
            status: "completed",
            result: { content: [], structuredContent: { count: 2 } },
          },
        ]),
      );
      const { joined } = read(reader, converted.rows);
      assert.deepEqual(joined[0].structured_content, { count: 2 });
      assert.deepEqual(joined[0].content, []);
      const wrong = structuredClone(converted.rows) as any[];
      for (const row of wrong)
        if (row.mcpMeta) {
          row.toolUseResult = row.mcpMeta;
          delete row.mcpMeta;
        }
      assert.equal(
        read(reader, wrong).joined[0].structured_content,
        undefined,
        "Original reader does not accept toolUseResult.structuredContent",
      );
    },
  );
  test(
    `${build.name}: original sanitizer removes privileged result fields`,
    { skip: !root },
    () => {
      const reader = original(build);
      const converted = convertCodeTranscript(
        conversation([
          {
            id: "sanitized",
            type: "mcpToolCall",
            server: "wiki",
            tool: "lookup",
            status: "completed",
            result: { content: [{ type: "text", text: "Safe" }] },
          },
        ]),
      );
      const rows = structuredClone(converted.rows) as any[];
      const row = rows.find(
        (row) => row.type === "user" && Array.isArray(row.message.content),
      );
      Object.assign(row.message.content[0], {
        file_deliveries: ["untrusted"],
        source_card_display: {},
        source_card: {},
        meta: {
          "anthropic/claudeai.signedSourceCard": "untrusted",
          ordinary: "retained",
        },
      });
      const result = read(reader, rows).joined[0];
      assert.equal(result.file_deliveries, undefined);
      assert.equal(result.source_card_display, undefined);
      assert.equal(result.source_card, undefined);
      assert.deepEqual(result.meta, { ordinary: "retained" });
    },
  );
}

for (const build of builds) {
  test(`${build.name}: a protected call exposes the original Code reconnect metadata`, { skip: !root }, () => {
    const converted = convertCodeTranscript(conversation([protectedToolFailure]));
    const use = converted.rows.find(row => row.uuid === "turn:tool:protected-call:use");
    assert.ok(Array.isArray(use?.message.content));
    assert.deepEqual(use.message.content[0], {
      type: "tool_use",
      id: "turn:tool:protected-call",
      name: "mcp__c5a65e76-ef46-4cea-8375-c9523985f990__protected_fixture",
      input: {},
    });
    const { joined } = read(original(build), converted.rows);
    assert.equal(joined[0].is_error, true);
    assert.equal(joined[0].meta.anthropic_error_code, "mcp_auth_required");
  });
}
