import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BusyLabel } from "../../src/auth/BusyLabel";

test("a working sign-in button keeps its label under a spinner and says the busy text only to screen readers", () => {
  const busy = renderToStaticMarkup(
    createElement(BusyLabel, {
      busy: true,
      busyLabel: "Please wait…",
      children: "Continue with email",
    }),
  );
  assert.match(
    busy,
    /<span class="busy-label-text" data-busy="true">Continue with email<\/span>/,
  );
  assert.match(busy, /data-cds="Spinner"/);
  assert.match(
    busy,
    /<span class="sr-only" role="status">Please wait…<\/span>/,
  );
  const idle = renderToStaticMarkup(
    createElement(BusyLabel, {
      busy: false,
      busyLabel: "Please wait…",
      children: "Continue with email",
    }),
  );
  assert.doesNotMatch(idle, /data-busy|Spinner|sr-only/);
  assert.match(idle, /Continue with email/);
});
