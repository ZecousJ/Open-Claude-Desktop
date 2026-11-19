import assert from "node:assert/strict";
import test from "node:test";
import {
  codeToolTranscript,
  transcriptToolText,
} from "../electron/official-ui/native/code-tool-transcript";
import {
  convertCodeTranscript,
  pageCodeTranscript,
} from "../electron/official-ui/native/code-transcript";
import type { Conversation, Item } from "../shared/types";

const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZnjIAAAAASUVORK5CYII=";
const item = (patch: Partial<Item> = {}): Item => ({
  id: "mcp",
  type: "mcpToolCall",
  server: "wiki",
  tool: "lookup",
  arguments: { query: "fixture" },
  status: "completed",
  ...patch,
});
function conversation(items: Item[]): Conversation {
  return {
    id: "c",
    mode: "code",
    providerId: "fixture",
    model: "fixture",
    title: "Fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "t",
        createdAt: 1,
        prompt: "fixture",
        attachments: [],
        status: "completed",
        items,
      },
    ],
  };
}
const text = (value: ReturnType<typeof codeToolTranscript>) =>
  value.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

test("MCP preserves text/image order, structured payload, namespaced identity and input", () => {
  const source = item({
    result: {
      content: [
        { type: "text", text: "before" },
        { type: "image", mimeType: "image/png", data: image },
        { type: "text", text: "after" },
      ],
      structuredContent: { results: [{ title: "fixture" }] },
    },
  });
  const saved = structuredClone(source);
  const projected = codeToolTranscript(source);
  assert.equal(projected.name, "mcp__wiki__lookup");
  assert.deepEqual(projected.input, source.arguments);
  assert.deepEqual(projected.content, [
    { type: "text", text: "before" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: image },
    },
    { type: "text", text: "after" },
  ]);
  assert.deepEqual(projected.mcpMeta, {
    structuredContent: { results: [{ title: "fixture" }] },
  });
  assert.equal(projected.failed, false);
  assert.deepEqual(source, saved);
});

test("same tool from different servers stays distinct and already-qualified names are unchanged", () => {
  const sources = [
    item(),
    item({ server: "docs" }),
    item({ tool: "mcp__exact__lookup" }),
  ];
  assert.deepEqual(
    sources.map((x) => codeToolTranscript(x).name),
    ["mcp__wiki__lookup", "mcp__docs__lookup", "mcp__exact__lookup"],
  );
  assert.equal(
    codeToolTranscript(item({ type: "dynamicToolCall" })).name,
    "lookup",
  );
  assert.equal(codeToolTranscript(item({ server: undefined })).name, "lookup");
});

test("only a configured remote directory App uses its connector UUID", () => {
  const source = item({
    server: "Field-Notes",
    tool: "fixture_widget-v2",
    mcpAppResourceUri: "ui://fixture/widget.html",
  });
  const directory = { claudex_directory_id: "a2545dc6-cc30-4f5b-8482-96108b4c5142" };
  const remote = { url: "https://example.com/mcp" };
  const name = (config: unknown) =>
    codeToolTranscript(source, { "Field-Notes": config }).name;
  assert.equal(
    name({ ...remote, ...directory }),
    "mcp__3d7dbae0-89f2-4b6b-85c5-392460c543f9__fixture_widget-v2",
  );
  assert.equal(name(remote), "mcp__Field-Notes__fixture_widget-v2");
  assert.equal(name({ ...directory, command: "fixture-server" }), "mcp__Field-Notes__fixture_widget-v2");
  assert.equal(
    codeToolTranscript({ ...source, mcpAppResourceUri: undefined }, {
      "Field-Notes": { ...remote, ...directory },
    }).name,
    "mcp__Field-Notes__fixture_widget-v2",
  );
});

test("saved tool image content with no MIME type uses the original PNG default", () => {
  const projected = codeToolTranscript(
    item({
      result: { content: [{ type: "image", data: image }] },
    }),
  );
  assert.deepEqual(projected.content, [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: image },
    },
  ]);
});

for (const failed of [
  { result: { isError: true, content: [{ type: "text", text: "failure" }] } },
  { result: { is_error: true, content: [] } },
  { success: false },
  { error: { message: "failed" } },
  ...["failed", "declined", "interrupted", "cancelled", "canceled"].map(
    (status) => ({ status, lifecycleStatus: "completed" as const }),
  ),
  { lifecycleStatus: "failed" as const },
  { lifecycleStatus: "interrupted" as const },
])
  test(`failure evidence is not hidden by completed lifecycle: ${JSON.stringify(failed)}`, () => {
    const projected = codeToolTranscript(item(failed));
    assert.equal(projected.complete, true);
    assert.equal(projected.failed, true);
    const converted = convertCodeTranscript(conversation([item(failed)]));
    assert.equal(
      (converted.rows.at(-1)!.message.content as any[])[0].is_error,
      true,
    );
  });

test("error and partial result are both visible without overwriting each other", () => {
  const projected = codeToolTranscript(
    item({
      result: { content: [{ type: "text", text: "partial" }] },
      error: { message: "disconnected" },
    }),
  );
  assert.deepEqual(projected.content, [
    { type: "text", text: "partial" },
    { type: "text", text: "disconnected" },
  ]);
  assert.equal(projected.failed, true);
});

test("dynamic contentItems support text and inline image; remote images never fetch", () => {
  const projected = codeToolTranscript(
    item({
      type: "dynamicToolCall",
      contentItems: [
        { type: "inputText", text: "dynamic" },
        { type: "inputImage", imageUrl: `data:image/png;base64,${image}` },
        { type: "inputImage", imageUrl: "https://example.invalid/private.png" },
      ],
    }),
  );
  assert.equal(projected.content.filter((x) => x.type === "image").length, 1);
  assert.equal((projected.content[0] as any).text, "dynamic");
  assert.ok(projected.warnings.some((x) => x.includes("does not fetch")));
  assert.ok(!JSON.stringify(projected.content).includes("example.invalid"));
});

test("MCP resource links keep their metadata and supported embedded resources keep their content", () => {
  const link = {
    type: "resource_link",
    name: "Manual",
    title: "Fixture manual",
    description: "Reference",
    uri: "resource://manual",
    mimeType: "text/plain",
  };
  const standalone = { uri: "resource://guide", name: "Guide" };
  const source = item({
    resource_links: [standalone],
    result: {
      content: [
        link,
        {
          type: "resource",
          resource: { uri: "file:///fixture.txt", text: "resource text" },
        },
        {
          type: "resource",
          resource: { mimeType: "image/png", blob: image },
        },
        {
          type: "resource",
          resource: { mimeType: "application/pdf", blob: "secret-binary" },
        },
        {
          type: "resource",
          resource: {
            mimeType: "text/html",
            text: "<script>never execute</script>",
          },
        },
      ],
    },
  });
  const saved = structuredClone(source);
  const result = convertCodeTranscript(conversation([source])).rows.at(-1)!;
  assert.deepEqual(result.mcpMeta, {
    resourceLinks: [{ type: "resource_link", ...standalone }, link],
  });
  assert.deepEqual(result.message.content, [
    {
      type: "tool_result",
      tool_use_id: "t:tool:mcp",
      is_error: false,
      content: [
        link,
        { type: "text", text: "resource text" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: image },
        },
        { type: "text", text: "<script>never execute</script>" },
      ],
    },
  ]);
  assert.deepEqual(result.claudexToolResultWarnings, [
    "Unsupported binary resource omitted",
  ]);
  assert.deepEqual(source, saved);
});

for (const part of [
  null,
  42,
  [],
  { type: "audio", data: "must-not-leak" },
  { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
  { type: "image", mimeType: "image/png", data: "???" },
  {
    type: "image",
    source: { type: "url", url: "https://example.invalid/image" },
  },
  { type: "resource_link" },
])
  test(`invalid or unsupported content stays outside the result: ${JSON.stringify(part)}`, () => {
    const projected = codeToolTranscript(item({ result: { content: [part] } }));
    assert.ok(projected.warnings.length > 0);
    assert.deepEqual(projected.content, []);
  });

test("text, image, blocks and structured payload have independent bounded limits", () => {
  const projected = codeToolTranscript(
    item({
      result: {
        content: [
          { type: "text", text: "a".repeat(99_990) },
          { type: "text", text: "b".repeat(100) },
          {
            type: "image",
            mimeType: "image/png",
            data: "AAAA".repeat(1024 * 1024 + 1),
          },
          ...Array.from({ length: 300 }, () => ({
            type: "text",
            text: "trailing",
          })),
        ],
        structuredContent: { long: "c".repeat(100_001) },
      },
    }),
  );
  assert.equal(text(projected), `${"a".repeat(99_990)}\n${"b".repeat(10)}`);
  assert.equal(projected.mcpMeta, undefined);
  assert.deepEqual(projected.warnings, [
    "Tool text truncated",
    "Tool image limit exceeded; image omitted",
    "Tool content block limit exceeded",
    "Structured tool content limit exceeded",
  ]);
});

test("structured-only output is available through native metadata", () => {
  const source = item({
    result: {
      content: [],
      structuredContent: { answer: 42 },
      _meta: {
        ui: { resourceUri: "ui://private-widget" },
        token: "not-forwarded",
      },
    },
  });
  const projected = codeToolTranscript(source);
  assert.deepEqual(projected.content, []);
  assert.deepEqual(projected.mcpMeta, { structuredContent: { answer: 42 } });
  assert.ok(!JSON.stringify(projected).includes("not-forwarded"));
  assert.ok(!JSON.stringify(projected).includes("ui://private-widget"));
  assert.equal(source.result._meta.token, "not-forwarded");
});

test("legacy JSON results retain their recorded data", () => {
  const projected = codeToolTranscript(
    item({
      result: { matches: ["manual"], _meta: { token: "private" } },
    }),
  );
  assert.deepEqual(projected.content, [
    { type: "text", text: '{\n  "matches": [\n    "manual"\n  ]\n}' },
  ]);
});

test("cyclic, non-JSON and data-URI fallbacks cannot crash conversion or expose raw binary", () => {
  const cycle: any = {};
  cycle.self = cycle;
  for (const value of [cycle, 1n, () => 1, Symbol("x")])
    assert.equal(transcriptToolText(value), "");
  assert.equal(transcriptToolText("data:image/png;base64,private"), "");
  assert.equal(
    transcriptToolText({
      image: "data:image/png;base64,private",
      title: "Fixture",
    }),
    '{\n  "title": "Fixture"\n}',
  );
  assert.doesNotThrow(() =>
    codeToolTranscript(
      item({ result: { content: [], structuredContent: cycle } }),
    ),
  );
});

test("JSON object argument strings are decoded; scalar and literal arguments remain data", () => {
  assert.deepEqual(
    codeToolTranscript(item({ arguments: '{"q":"fixture"}' })).input,
    { q: "fixture" },
  );
  for (const input of ["literal", "[]", "false", [1, 2], 0])
    assert.deepEqual(codeToolTranscript(item({ arguments: input })).input, {
      value: input,
    });
});

test("running and unknown-status tools have no fabricated result or progress-as-success", () => {
  for (const status of ["running", "inProgress", "unknown", undefined]) {
    const c = conversation([item({ status, progress: "opening" })]);
    c.turns[0].status = "inProgress";
    const converted = convertCodeTranscript(c);
    assert.equal(converted.rows.length, 2);
    assert.ok(!JSON.stringify(converted.rows).includes('"tool_result"'));
    assert.ok(
      converted.unsupported.includes(
        status === "running" || status === "inProgress"
          ? "running-tool-call"
          : "unknown-tool-status",
      ),
    );
  }
  assert.equal(
    codeToolTranscript(item({ status: undefined, result: { content: [] } }))
      .complete,
    true,
  );
});

test("stable UUIDs and parent chain persist from running through completion and repeated snapshots", () => {
  const source = item({ status: "inProgress", progress: "opening" });
  const c = conversation([source]);
  c.turns[0].status = "inProgress";
  const running = convertCodeTranscript(c);
  assert.equal(running.rows.at(-1)!.claudexToolProgress, "opening");
  source.status = "completed";
  source.result = { content: [{ type: "text", text: "done" }] };
  c.turns[0].status = "completed";
  const completed = convertCodeTranscript(c);
  assert.equal(completed.rows[1].uuid, running.rows[1].uuid);
  assert.equal(completed.rows[2].parentUuid, completed.rows[1].uuid);
  assert.equal(completed.rows[1].claudexToolProgress, undefined);
  assert.deepEqual(convertCodeTranscript(c), completed);
  assert.equal(completed.rows.filter((r) => r.claudexSourceItem).length, 0);
});

test("large tool history pages retain all identities without overlap or mutation", () => {
  const c = conversation(
    Array.from({ length: 1000 }, (_, i) =>
      item({
        id: `tool-${i}`,
        result: { content: [{ type: "text", text: `result-${i}` }] },
      }),
    ),
  );
  const rows = convertCodeTranscript(c).rows;
  let cursor = "",
    recovered: typeof rows = [];
  do {
    const page = pageCodeTranscript(rows, cursor, 47);
    recovered = [...page.messages, ...recovered];
    cursor = page.hasMore ? page.messages[0].uuid : "";
  } while (cursor);
  assert.deepEqual(recovered, rows);
  assert.equal(new Set(rows.map((r) => r.uuid)).size, 2001);
  assert.deepEqual(convertCodeTranscript(c).unsupported, []);
});

for (const content of [undefined, null, "Saved text", {}])
  test(`original response text and metadata stay separate for content ${JSON.stringify(content)}`, () => {
    const projected = codeToolTranscript(
      item({
        result: {
          content,
          structuredContent: { answer: 42 },
          _meta: {
            token: "must-not-forward",
            ui: { resourceUri: "ui://never-open" },
          },
        },
      }),
    );
    assert.ok(!JSON.stringify(projected).includes("must-not-forward"));
    assert.ok(!JSON.stringify(projected).includes("ui://never-open"));
    assert.deepEqual(projected.mcpMeta, { structuredContent: { answer: 42 } });
    assert.deepEqual(
      projected.content,
      typeof content === "string" ? [{ type: "text", text: content }] : [],
    );
  });

test("lifecycle-only completion with no result leaves the tool use unmatched", () => {
  const { rows, unsupported } = convertCodeTranscript(
    conversation([
      item({
        status: "inProgress",
        lifecycleStatus: "completed",
        result: null,
      }),
    ]),
  );
  assert.equal(rows.length, 2);
  const use = rows[1];
  assert.deepEqual(use.message.content, [
    {
      type: "tool_use",
      id: "t:tool:mcp",
      name: "mcp__wiki__lookup",
      input: { query: "fixture" },
    },
  ]);
  assert.deepEqual(use.claudexToolResultWarnings, [
    "The turn ended without a recorded tool result; tool success is unknown",
  ]);
  assert.deepEqual(unsupported, ["unknown-tool-status"]);
});

test("MCP resource links are bounded, validated, and excluded on errors", () => {
  const link = {
    type: "resource_link",
    uri: "https://example.com/a",
    name: "A",
    description: "Details",
    _meta: { widget: "secret" },
  };
  const result = {
    content: [
      link,
      { ...link, uri: "not a URI" },
      { ...link, uri: "https://example.com/a" },
    ],
    structuredContent: { count: 1 },
  };
  const projected = codeToolTranscript(item({ result }));
  assert.deepEqual(projected.mcpMeta, {
    structuredContent: { count: 1 },
    resourceLinks: [
      {
        type: "resource_link",
        uri: "https://example.com/a",
        name: "A",
        description: "Details",
      },
    ],
  });
  assert.equal(
    codeToolTranscript(item({ result: { ...result, isError: true } })).mcpMeta
      ?.resourceLinks,
    undefined,
  );
  assert.equal(
    codeToolTranscript(item({ status: "failed", result })).mcpMeta
      ?.resourceLinks,
    undefined,
  );
  assert.equal(
    codeToolTranscript(item({ type: "dynamicToolCall", result })).mcpMeta
      ?.resourceLinks,
    undefined,
  );
  const many = Array.from({ length: 300 }, (_, i) => ({
    ...link,
    uri: `https://example.com/${i}`,
  }));
  assert.equal(
    codeToolTranscript(item({ result: { content: many } })).mcpMeta
      ?.resourceLinks?.length,
    50,
  );
});
