import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeSubmitCell } from "../../src/composer/CodeSubmitCell";

const render = (showStop: boolean) =>
  renderToStaticMarkup(
    createElement(CodeSubmitCell, {
      showStop,
      stop: createElement("button", null, "Stop"),
      send: createElement("button", null, "Send"),
    }),
  );

test("the Code send cell shows Stop or Send, never both", () => {
  const running = render(true);
  assert.match(
    running,
    /<span class="code-submit-face" data-shown="true"><button>Stop<\/button>/,
  );
  assert.match(
    running,
    /<span class="code-submit-face" inert="" aria-hidden="true"><button>Send<\/button>/,
  );
  const idle = render(false);
  assert.match(
    idle,
    /<span class="code-submit-face" data-shown="true"><button>Send<\/button>/,
  );
  assert.match(
    idle,
    /<span class="code-submit-face" inert="" aria-hidden="true"><button>Stop<\/button>/,
  );
});

test("the first render of the Code send cell does not fade in", () => {
  assert.doesNotMatch(render(true), /data-entering/);
  assert.doesNotMatch(render(false), /data-entering/);
});
