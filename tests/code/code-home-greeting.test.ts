import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import { desktopHost, webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { CodeHome } from "../../src/code-home/CodeHome";

const renderHome = (host: typeof webHost) =>
  renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: host },
      createElement(CodeHome, {
        name: "Ada",
        conversations: [
          { id: "running", mode: "code", unread: true, turns: [] },
        ] as unknown as Conversation[],
        composer: createElement("div", { "data-composer": true }, "Prompt"),
        landing: createElement("section", {}, "Sessions"),
      }),
    ),
  );

test("web Code drafts show their environment composer without the old greeting, dashboard or landing list", () => {
  const html = renderHome(webHost);
  assert.match(html, /class="code-home-environments"/);
  assert.match(html, /data-composer="true">Prompt<\/div>/);
  assert.doesNotMatch(
    html,
    /<h1|usage-overview|Sessions|Ada|Welcome back|What’s up next/,
  );
});

test("desktop Code drafts keep environment/import composition without greeting, statistics or landing", () => {
  const html = renderHome(desktopHost);
  assert.match(html, /class="code-home-draft native-code-home"/);
  assert.match(html, /native-code-home-environments/);
  assert.match(html, /data-composer="true">Prompt<\/div>/);
  assert.doesNotMatch(
    html,
    /<h1|usage-overview|Sessions|Ada|Welcome back|What’s up next/,
  );
});
