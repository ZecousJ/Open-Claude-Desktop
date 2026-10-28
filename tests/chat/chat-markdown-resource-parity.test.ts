import assert from "node:assert/strict";
import test, { before } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { AppContext, IpcHandle } from "../../electron/app/app-context";
import { registerArtifactToolHandlers } from "../../electron/artifacts/artifact-tools";
import { projectAgentItems } from "../../electron/conversations/agent-transcript-item";
import type { Item, Turn } from "../../shared/types";
import {
  electionInfoSource,
  resourceLinks,
  resourceName,
  resourceDownloadName,
  resourceChunkBytes,
  validResourceBase64,
} from "../../shared/message-resources";
import { Markdown, preloadInlineMermaid } from "../../src/ui/Markdown";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { loadHighlight } from "../../src/ui/lazy-highlight";
import { exceedsCodeSizeLimit } from "../../src/ui/markdown-code";
import { markdownMermaidDocument } from "../../src/artifacts/markdown-mermaid-document";
import {
  McpResourceLinks,
  preloadResourceLinkCards,
} from "../../src/transcript/tools/McpResourceLinks";
import {
  ChatTurnContent,
  preloadElectionInfoSource,
} from "../../src/transcript/ChatTurnContent";
import { McpToolView } from "../../src/transcript/tools/McpToolView";

before(async () => {
  await Promise.all([
    preloadMarkdownRenderer(),
    preloadInlineMermaid(),
    preloadResourceLinkCards(),
    preloadElectionInfoSource(),
    loadHighlight(),
  ]);
});

const markdown = (text: string, streaming = false) =>
  renderToStaticMarkup(createElement(Markdown, { text, streaming }));
const resourceItem = (content: unknown[]): Item => ({
  id: "tool",
  type: "mcpToolCall",
  server: "files",
  tool: "lookup",
  status: "completed",
  result: { content },
});
const link = {
  type: "resource_link" as const,
  uri: "file:///reports/annual.pdf",
  name: "annual.pdf",
  mimeType: "application/pdf",
};

test("code groups and copy controls use the reference accessible names", () => {
  const html = markdown("```JavaScript\nreturn 42;\n```\n\n```\nplain\n```");
  assert.match(
    html,
    /role="group" aria-label="javascript code" tabindex="0" dir="ltr"/,
  );
  assert.match(html, /role="group" aria-label="Code"/);
  assert.match(markdown("```c++\nint main() {}\n```"), /aria-label="c code"/);
  assert.match(
    html,
    /aria-label="Copy to clipboard" data-testid="code-block-copy"/,
  );
  assert.match(html, /role="tooltip"[^>]*>Copy<\/span>/);
});

test("the 204800-byte guard skips highlighting only oversized blocks", () => {
  assert.equal(exceedsCodeSizeLimit("a".repeat(204_800)), false);
  assert.equal(exceedsCodeSizeLimit("a".repeat(204_801)), true);
  assert.equal(exceedsCodeSizeLimit("é".repeat(102_400)), false);
  assert.equal(exceedsCodeSizeLimit("é".repeat(102_401)), true);
  assert.equal(exceedsCodeSizeLimit("😀".repeat(51_201)), true);
  assert.equal(exceedsCodeSizeLimit("a".repeat(204_800) + "\n  "), false);
  const html = markdown(
    "```js\n" + "x".repeat(204_801) + "\n```\n\n```js\nconst small = 1;\n```",
  );
  assert.equal(
    (
      html.match(/Syntax highlighting has been disabled due to code size\./g) ??
      []
    ).length,
    1,
  );
  assert.match(html, /class="code-size-notice"/);
  assert.match(html, /no-highlight/);
  assert.match(html, /hljs-keyword/);
});

test("Mermaid is an accessible diagram, with source during streaming and refusal", () => {
  const diagram = markdown("```mermaid\ngraph TD; A-->B\n```");
  assert.match(
    diagram,
    /data-mermaid="true" role="img" aria-label="Mermaid diagram"/,
  );
  assert.doesNotMatch(diagram, /code-block-copy/);
  assert.match(
    markdown("```mermaid\ngraph TD; A-->B", true),
    /<pre data-mermaid="true" class="markdown-mermaid-source" dir="ltr">graph TD; A--&gt;B<\/pre>/,
  );
  assert.match(
    markdown("```mermaid\n" + "x".repeat(20_001) + "\n```"),
    /markdown-mermaid-source/,
  );
  for (const dark of [false, true]) {
    const document = markdownMermaidDocument(
      { source: "window.mermaid={}" },
      'graph TD; A["</script><script>bad()"]',
      dark,
    );
    assert.match(document, /"maxTextSize":20000,"maxEdges":400/);
    assert.match(document, /"htmlLabels":false/);
    assert.match(document, /"securityLevel":"strict"/);
    assert.match(document, /connect-src 'none'/);
    assert.match(document, dark ? /#E5E5E5/ : /#191919/);
    assert.doesNotMatch(document, /<script>bad/);
    assert.match(document, /claudex-markdown-mermaid/);
  }
});

test("resource links normalize, deduplicate, cap and render outside the tool disclosure", () => {
  const item = resourceItem([
    link,
    link,
    {
      type: "resource_link",
      uri: "file:///reports/hello%20world.txt?query=yes",
    },
    { ...link, uri: "not a uri" },
  ]);
  item.result.resource_links = [
    { uri: "mcp://files/table", title: "Table", mime_type: "text/csv" },
  ];
  const links = resourceLinks(item);
  assert.equal(links.length, 3);
  assert.equal(links[0].name, "table");
  assert.equal(links[0].mimeType, "text/csv");
  assert.equal(links[2].name, "hello world.txt");
  assert.equal(
    resourceName({ ...link, title: "\u202eAnnual report.pdf" }),
    "Annual report.pdf",
  );
  assert.equal(
    resourceDownloadName({ ...link, name: "report.exe", mimeType: "text/csv" }),
    "report.csv",
  );
  assert.equal(
    resourceDownloadName({ ...link, name: "REPORT.PDF" }),
    "REPORT.pdf",
  );
  assert.equal(
    resourceLinks(
      resourceItem(
        Array.from({ length: 60 }, (_, index) => ({
          ...link,
          uri: `mcp://files/${index}`,
        })),
      ),
    ).length,
    50,
  );
  assert.equal(resourceLinks({ ...item, success: false }).length, 0);
  const html = renderToStaticMarkup(createElement(McpToolView, { item }));
  assert.match(html, /<\/details><div><div class="mcp-resource-links"/);
  assert.match(html, /title="file:\/\/\/reports\/annual.pdf"/);
  assert.doesNotMatch(html, /Unsupported output type/);
  const placeholder = (content: unknown[]) =>
    renderToStaticMarkup(
      createElement(McpResourceLinks, {
        item: resourceItem(content),
        placeholder: true,
      }),
    );
  assert.match(
    placeholder([link]),
    /data-testid="mcp-resource-links-placeholder">1 file link\. View in transcript\./,
  );
  assert.match(
    placeholder([link, { ...link, uri: "mcp://files/other" }]),
    /2 file links\. View in transcript\./,
  );
});

test("MCP resource reads are allowlisted, policy checked, multipart and runner-frame sized", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-resources-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const methods: string[] = [];
  let onRead: (() => void) | undefined;
  const item = resourceItem([link]);
  const settings = {
    mcpServers: {
      files: {
        url: "https://mcp.example",
        enabled: true,
        disabled_tools: [] as string[],
      },
    },
  };
  let contents: unknown[] = [
    { text: "prefix", mimeType: "text/plain" },
    { blob: Buffer.from([0, 255]).toString("base64") },
  ];
  const store = {
    root,
    settings,
    conversation: (id: string) => {
      if (id !== "session") throw new Error("missing");
      return { turns: [{ items: [item] }] };
    },
  };
  const ctx = {
    store,
    policy: () => ({}),
    connectors: {
      fetch: (async (_url: unknown, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (!body) return new Response(null, { status: 202 });
        methods.push(body.method);
        if (!body.id) return new Response(null, { status: 202 });
        if (body.method === "resources/read") onRead?.();
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: body.method === "resources/read" ? { contents } : {},
        });
      }) as typeof fetch,
    },
  } as unknown as AppContext;
  registerArtifactToolHandlers(
    ((name, handler) => {
      handlers[name] = handler;
    }) as IpcHandle,
    ctx,
  );
  const read = () => handlers.readMcpResource("session", item.id, link.uri);
  const file = await read();
  assert.equal(file.name, "annual.pdf");
  assert.equal(file.mimeType, "application/pdf");
  assert.deepEqual(
    Buffer.from(file.base64, "base64"),
    Buffer.from([112, 114, 101, 102, 105, 120, 0, 255]),
  );
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "resources/read",
  ]);
  await assert.rejects(
    handlers.readMcpResource("session", item.id, "file:///secret"),
  );
  settings.mcpServers.files.disabled_tools = ["lookup"];
  await assert.rejects(read());
  settings.mcpServers.files.disabled_tools = [];
  onRead = () => {
    settings.mcpServers.files.enabled = false;
  };
  await assert.rejects(read());
  onRead = undefined;
  settings.mcpServers.files.enabled = true;
  for (const invalid of [
    [],
    [{ blob: "bad%" }],
    [{}],
    Array.from({ length: 4097 }, () => ({ text: "" })),
  ]) {
    contents = invalid;
    await assert.rejects(read());
  }
  const large = Buffer.alloc(resourceChunkBytes + 2, 42);
  contents = [{ blob: large.toString("base64") }];
  const staged = await read();
  assert.equal(staged.base64, "");
  assert.equal(staged.byteLength, large.length);
  await assert.rejects(async () =>
    handlers.readMcpResourceChunk(staged.downloadId, 1),
  );
  const chunks = await Promise.all(
    [0, resourceChunkBytes].map((offset) =>
      handlers.readMcpResourceChunk(staged.downloadId, offset),
    ),
  );
  assert.deepEqual(Buffer.from(chunks.join(""), "base64"), large);
  const revoked = await read();
  settings.mcpServers.files.enabled = false;
  await assert.rejects(async () =>
    handlers.readMcpResourceChunk(revoked.downloadId, 0),
  );
  settings.mcpServers.files.enabled = true;
  const swapped = await read();
  Object.defineProperty(ctx, "store", {
    value: { ...store },
    configurable: true,
  });
  await assert.rejects(async () =>
    handlers.readMcpResourceChunk(swapped.downloadId, 0),
  );
  assert.equal(validResourceBase64("AA=="), true);
  assert.equal(validResourceBase64("A==="), false);
  assert.equal(validResourceBase64("a".repeat(20_000_000)), true);
});

test("election attribution preserves tool display content and requires a successful allowed URL", () => {
  const display = (url: string) => ({
    type: "rich_link" as const,
    link: { resource_type: "democracy_works_election_info", url },
  });
  const item: Item = {
    id: "election",
    type: "mcpToolCall",
    tool: "us_election_info",
    display_content: display("https://voting.democracy.works/ballot?q=1"),
  };
  assert.equal(projectAgentItems([item])[0].display_content?.type, "rich_link");
  assert.equal(
    electionInfoSource(projectAgentItems([{ ...item, cancelled: true }])),
    undefined,
  );
  assert.equal(
    electionInfoSource([item]),
    "https://voting.democracy.works/ballot?q=1",
  );
  for (const url of [
    "http://voting.democracy.works",
    "https://user@voting.democracy.works",
    "https://voting.democracy.works:444",
    "https://voting.democracy.works.evil.test",
    "javascript:bad()",
  ])
    assert.equal(
      electionInfoSource([{ ...item, display_content: display(url) }]),
      undefined,
    );
  const failures: Partial<Item>[] = [
    { status: "failed" },
    { lifecycleStatus: "interrupted" },
    { cancelled: true },
    { success: false },
    { result: { is_error: true } },
  ];
  for (const failed of failures)
    assert.equal(electionInfoSource([{ ...item, ...failed }]), undefined);
  assert.ok(
    electionInfoSource([
      {
        ...item,
        display_content: {
          type: "rich_content",
          content: [display("https://voting.democracy.works").link],
        },
      },
    ]),
  );
  const turn: Turn = {
    id: "turn",
    prompt: "",
    attachments: [],
    status: "completed",
    createdAt: 0,
    items: [item],
  };
  const render = (status: Turn["status"]) =>
    renderToStaticMarkup(
      createElement(ChatTurnContent, {
        turn: { ...turn, status },
        awaitingApproval: false,
        onArtifact() {},
      }),
    );
  assert.match(
    render("completed"),
    /data-testid="election-info-source" class="election-info-source">Source: <a href="https:\/\/voting.democracy.works\/ballot\?q=1">Democracy Works<\/a>/,
  );
  assert.doesNotMatch(render("inProgress"), /election-info-source/);
});

test("code copying keeps its accessible name after announcing Copied", async () => {
  const { window } = parseHTML(
    "<!doctype html><html><body><main></main></body></html>",
  );
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", {
    value: window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: window.document,
    configurable: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { CopyButton } = await import("../../src/ui/Controls");
  const { ConversationServicesContext, desktopConversationServices } =
    await import("../../src/conversation/ConversationServices");
  const copies: string[] = [];
  const root = createRoot(window.document.querySelector("main")!);
  try {
    flushSync(() =>
      root.render(
        createElement(
          ConversationServicesContext.Provider,
          {
            value: {
              ...desktopConversationServices,
              copyText: async (text) => {
                copies.push(text);
              },
            },
          },
          createElement(CopyButton, {
            text: "  preserved",
            iconOnly: true,
            codeBlock: true,
          }),
        ),
      ),
    );
    window.document.querySelector("button")!.click();
    for (
      let attempt = 0;
      attempt < 100 &&
      window.document.querySelector('[role="status"]')!.textContent !==
        "Copied";
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(copies, ["  preserved"]);
    assert.equal(
      window.document.querySelector("button")!.getAttribute("aria-label"),
      "Copy to clipboard",
    );
    assert.equal(
      window.document.querySelector('[role="status"]')!.textContent,
      "Copied",
    );
    const savedFiles: unknown[] = [];
    const chunks = [Buffer.alloc(resourceChunkBytes, 42), Buffer.from([43])];
    const offsets: number[] = [];
    Object.defineProperty(window, "desktop", {
      value: {
        readMcpResource: async (...args: string[]) => {
          assert.deepEqual(args, ["session", "tool", link.uri]);
          return {
            name: "annual.pdf",
            mimeType: "application/pdf",
            base64: "",
            downloadId: "staged",
            byteLength: resourceChunkBytes + 1,
          };
        },
        readMcpResourceChunk: async (id: string, offset: number) => {
          assert.equal(id, "staged");
          offsets.push(offset);
          return chunks[offset === 0 ? 0 : 1].toString("base64");
        },
        saveMcpResourceFile: async (file: unknown) => {
          savedFiles.push(file);
          return "annual.pdf";
        },
      },
      configurable: true,
    });
    flushSync(() =>
      root.render(
        createElement(
          ConversationServicesContext.Provider,
          {
            value: {
              ...desktopConversationServices,
              conversationId: "session",
            },
          },
          createElement(McpResourceLinks, { item: resourceItem([link]) }),
        ),
      ),
    );
    window.document.querySelector("button")!.click();
    for (let attempt = 0; attempt < 50 && !savedFiles.length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(offsets, [0, resourceChunkBytes]);
    assert.equal(savedFiles.length, 1);
    assert.deepEqual(
      Buffer.from((savedFiles[0] as { base64: string }).base64, "base64"),
      Buffer.concat(chunks),
    );
  } finally {
    flushSync(() => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedDocument)
      Object.defineProperty(globalThis, "document", savedDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
