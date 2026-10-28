import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { artifactCompleteHandler } from "../../electron/artifacts/artifact-complete";
import { capabilityInstructions } from "../../electron/engine/instructions";
import type { AppContext } from "../../electron/app/app-context";
import {
  completeMessageType,
  htmlDocument,
  visualizationDocument,
  visualizationSizeType,
} from "../../src/artifacts/preview-document";
import { Capabilities } from "../../src/artifacts/capabilities";
import { preloadArtifactCard } from "../../src/artifacts/LazyArtifactCard";
import { Markdown, preloadInlineVisualization } from "../../src/ui/Markdown";

before(() => preloadInlineVisualization());
before(() => preloadArtifactCard());
import type { Settings } from "../../shared/types";

function completeHandler(settings: Partial<Settings>, clock: () => number) {
  const prompts: unknown[] = [];
  const call = artifactCompleteHandler(
    { store: { settings } } as unknown as AppContext,
    async (prompt) => {
      prompts.push(prompt);
      return "42";
    },
    clock,
  );
  return { call, prompts };
}

test("an artifact's window.claude.complete is answered only while the setting is on", async () => {
  let now = 0;
  const off = completeHandler({}, () => now);
  await assert.rejects(async () => off.call("What is 6 × 7?"), /are off/);
  assert.equal(off.prompts.length, 0);

  const on = completeHandler({ aiArtifacts: true }, () => now);
  assert.equal(await on.call("What is 6 × 7?"), "42");
  assert.equal((on.prompts[0] as { input: string }).input, "What is 6 × 7?");
  await assert.rejects(async () => on.call(""));
  await assert.rejects(async () => on.call(42));
  // A looping artifact is stopped after 20 calls a minute.
  for (let i = 1; i < 20; i++) await on.call(`q${i}`);
  await assert.rejects(async () => on.call("again"), /too often/);
  now += 61_000;
  assert.equal(await on.call("later"), "42");
});

test("Chat's model is told about the capabilities that are on", () => {
  const base = {} as Settings;
  // Inline visualizations are on by default, AI-powered artifacts off.
  const lines = capabilityInstructions(base, "chat");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /language is `visualization`/);
  const both = capabilityInstructions(
    { ...base, aiArtifacts: true } as Settings,
    "chat",
  );
  assert.match(both[1], /window\.claude\.complete/);
  assert.deepEqual(
    capabilityInstructions(
      { ...base, inlineVisualizations: false } as Settings,
      "chat",
    ),
    [],
  );
  assert.deepEqual(
    capabilityInstructions({ ...base, aiArtifacts: true } as Settings, "code"),
    [],
  );
  assert.match(
    capabilityInstructions(
      {
        ...base,
        inlineVisualizations: false,
        mcpServers: { work: { url: "https://connector.test/mcp" } },
      } as Settings,
      "chat",
    )[0],
    /window\.claude\.mcp/,
  );
});

test("MCP is independent of AI-powered artifacts, while complete still requires the capability", () => {
  assert.doesNotMatch(htmlDocument("<p>x</p>"), /claudex-complete/);
  assert.match(htmlDocument("<p>x</p>"), /window\.mcp=mcp/);
  const page = htmlDocument("<p>x</p>", true);
  assert.match(page, /window\.claude=/);
  assert.ok(page.includes(completeMessageType));
  // The shim runs before the artifact's own scripts, after the CSP.
  assert.ok(page.indexOf("window.claude=") < page.indexOf("<p>x</p>"));
  assert.ok(
    page.indexOf("Content-Security-Policy") < page.indexOf("window.claude="),
  );
  const drawing = visualizationDocument("<svg></svg>", true);
  assert.ok(drawing.includes(visualizationSizeType));
  assert.match(drawing, /color-scheme:dark/);
  assert.match(drawing, /connect-src 'none'/);
});

test("visualization blocks are drawn in place while the setting is on", () => {
  const text = "Here:\n\n```visualization\n<svg></svg>\n```\n";
  const render = (inlineVisualizations: boolean, streaming = false) =>
    renderToStaticMarkup(
      createElement(
        Capabilities.Provider,
        { value: { aiArtifacts: false, inlineVisualizations } },
        createElement(Markdown, { text, streaming }),
      ),
    );
  const drawn = render(true);
  assert.match(drawn, /class="inline-visualization"/);
  assert.match(drawn, /<iframe title="Visualization" sandbox="allow-scripts"/);
  assert.doesNotMatch(drawn, /code-block/);
  // Off: the block stays code.
  assert.match(render(false), /code-block/);
  // Still arriving: the spinner waits, no frame yet.
  const open = renderToStaticMarkup(
    createElement(
      Capabilities.Provider,
      { value: { aiArtifacts: false, inlineVisualizations: true } },
      createElement(Markdown, {
        text: '```visualization\n<svg><circle r="4"/>',
        streaming: true,
      }),
    ),
  );
  assert.match(open, /aria-label="Drawing visualization"/);
  assert.doesNotMatch(open, /<iframe/);
});

test("Artifacts off renders new HTML replies as code while enabled renders an artifact card", () => {
  const text =
    "```html\n<!doctype html><html><title>Fixture</title><body>Hello</body></html>\n```";
  const render = (artifacts: boolean) =>
    renderToStaticMarkup(
      createElement(
        Capabilities.Provider,
        {
          value: { artifacts, aiArtifacts: false, inlineVisualizations: true },
        },
        createElement(Markdown, { text, onArtifact() {} }),
      ),
    );
  assert.match(render(false), /class="code-block/);
  assert.doesNotMatch(render(false), /class="artifact-card/);
  assert.match(render(true), /artifact-card/);
});
