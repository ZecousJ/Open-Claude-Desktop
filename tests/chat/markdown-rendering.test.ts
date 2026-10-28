import assert from "node:assert/strict";
import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, renderedText } from "../../src/ui/components";
import { loadHighlight } from "../../src/ui/lazy-highlight";

test("highlighted code preserves nested source characters for clipboard and artifacts", () => {
  const content = createElement(
    "code",
    {},
    createElement("span", { className: "hljs-keyword" }, "return"),
    ' a < b && "quoted";\n',
  );
  assert.equal(renderedText(content), 'return a < b && "quoted";\n');
});

test("markdown highlights declared languages and safely renders unknown languages and markup", async () => {
  // Before the highlighter has loaded, code is plain text in the same box.
  const plain = renderToStaticMarkup(
    createElement(Markdown, {
      text: "```javascript\nfunction add(a, b) { return a + b; }\n```",
      onArtifact: () => {},
    }),
  );
  assert.match(plain, /language-javascript/);
  assert.match(plain, /function add/);
  await loadHighlight();
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      text: "```javascript\nfunction add(a, b) { return a + b; }\n```\n\n```madeup\n<script>alert(1)</script>\n```",
      onArtifact: () => {},
    }),
  );
  assert.match(html, /hljs-keyword/);
  assert.match(html, /language-madeup/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|\[object Object\]/);
});

test("completed command with empty output is not presented as still waiting", async () => {
  const { CommandActivity } = await import("../../src/ui/components");
  const html = renderToStaticMarkup(
    createElement(CommandActivity, {
      item: {
        id: "cmd",
        type: "commandExecution",
        command: "true",
        status: "completed",
        aggregatedOutput: "",
        exitCode: 0,
      },
    }),
  );
  assert.match(html, /Ran a command/);
  // Empty output leaves the Output area blank.
  assert.doesNotMatch(html, /No output|Waiting for output/);
});

test("failed commands preserve literal source including fences and expose exit status", async () => {
  const { CommandActivity } = await import("../../src/ui/components");
  const html = renderToStaticMarkup(
    createElement(CommandActivity, {
      item: {
        id: "cmd",
        type: "commandExecution",
        command: 'printf "```<script>"',
        status: "failed",
        aggregatedOutput: "literal output",
        exitCode: 2,
      },
    }),
  );
  assert.match(html, /Command failed/);
  assert.match(html, /Exit code 2/);
  assert.match(html, /```&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("a streaming code block highlights finished lines and appends the line being typed as text", async () => {
  await loadHighlight();
  const { endsInOpenFence } = await import("../../src/ui/Markdown");
  assert.equal(
    endsInOpenFence("Intro\n```js\nconst a = 1;\nconst b = 'x"),
    true,
  );
  assert.equal(endsInOpenFence("```js\nconst a = 1;\n```"), false);
  assert.equal(endsInOpenFence("~~~\ncode\n```\nstill open"), true);
  const text = "Here:\n\n```javascript\nconst done = 1;\nconst s = 'unfinished";
  const streaming = renderToStaticMarkup(
    createElement(Markdown, { text, onArtifact: () => {}, streaming: true }),
  );
  // The finished line is highlighted; the open string is not.
  assert.match(streaming, /hljs-keyword">const<\/span> done/);
  assert.match(
    streaming,
    /<span class="code-stream-tail">const s = &#x27;unfinished<\/span><\/code>/,
  );
  assert.doesNotMatch(streaming, /data-stream-tail/);
  // Once the reply is complete (or the line is finished) the whole block is highlighted.
  const done = renderToStaticMarkup(
    createElement(Markdown, { text, onArtifact: () => {} }),
  );
  assert.doesNotMatch(done, /code-stream-tail/);
  assert.match(done, /hljs-string/);
  const lineEnded = renderToStaticMarkup(
    createElement(Markdown, {
      text: text + "';\n",
      onArtifact: () => {},
      streaming: true,
    }),
  );
  assert.doesNotMatch(lineEnded, /code-stream-tail/);
});
