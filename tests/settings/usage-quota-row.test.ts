import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerHooks } from "node:module";

registerHooks({
  load: (url, context, next) =>
    url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context),
});
const { QuotaRow } =
  await import("../../src/settings/usage-activity/UsageActivityParts");

const render = (limit: number | null, used: number) =>
  renderToStaticMarkup(
    createElement(QuotaRow, {
      window: { id: "daily", limit, used, resetsAt: null },
    }),
  );

test("a window with a limit shows the spend against it", () => {
  assert.match(render(20, 1.5), /\$1\.50 \/ \$20\.00/);
});

test("a window without a limit shows the spend alone, not against $0.00", () => {
  const html = render(null, 1.5);
  assert.match(html, /\$1\.50/);
  assert.ok(!html.includes("$0.00"));
  assert.ok(!html.includes(" / "));
});

test("a window that is turned off says so", () => {
  assert.match(render(0, 0), /Turned off/);
});
