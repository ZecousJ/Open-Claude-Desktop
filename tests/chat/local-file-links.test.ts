import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import {
  LocalFileLinks,
  localFileResolver,
} from "../../src/transcript/local-file-links";
import { Markdown } from "../../src/ui/Markdown";

const conversation = {
  turns: [
    {
      items: [
        {
          id: "f",
          type: "fileChange",
          generatedFiles: [
            {
              id: "g",
              name: "pelican.html",
              path: "/var/lib/claudex-runner/users/1/profile/workspace/pelican.html",
              language: "html",
              operation: "create",
              state: "ready",
              content: "<title>Pelican</title>",
            },
          ],
        },
      ],
    },
  ],
} as unknown as Conversation;

test("a link to a file the conversation wrote opens it; other local paths are text", () => {
  const resolve = localFileResolver(conversation);
  assert.equal(
    resolve("/var/lib/claudex-runner/users/1/profile/workspace/pelican.html")
      ?.filename,
    "pelican.html",
  );
  assert.equal(
    resolve("file:///elsewhere/pelican.html")?.filename,
    "pelican.html",
  );
  assert.equal(resolve("pelican.html")?.filename, "pelican.html");
  assert.equal(resolve("/etc/passwd"), undefined);
  assert.equal(resolve("#top"), undefined);
  const render = (text: string) =>
    renderToStaticMarkup(
      createElement(
        LocalFileLinks.Provider,
        { value: resolve },
        createElement(Markdown, { text, onArtifact: () => {} }),
      ),
    );
  assert.match(
    render(
      "[打开鹈鹕](/var/lib/claudex-runner/users/1/profile/workspace/pelican.html)",
    ),
    /<a href="#">打开鹈鹕<\/a>/,
  );
  // A dead local link reads as text; web links stay links.
  assert.match(render("[设置](/etc/passwd)"), /<span>设置<\/span>/);
  assert.match(
    render("[Docs](https://example.com)"),
    /<a href="https:\/\/example.com">Docs<\/a>/,
  );
});
