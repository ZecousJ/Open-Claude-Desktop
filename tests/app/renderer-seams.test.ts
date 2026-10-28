import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelBoundary } from "../../src/app/PanelBoundary";
import { draftWebSearchDefault } from "../../src/app/useComposerDraft";
import { lockedPolicy, openPolicy } from "../../shared/client-policy";

test("a panel boundary shows its panel until the panel fails, then a way back", () => {
  const props = {
    resetKey: "changes:c-1",
    onClose: () => {},
    children: createElement("aside", { className: "work-panel" }, "Changes"),
  };
  const boundary = new PanelBoundary(props);
  assert.equal(
    renderToStaticMarkup(boundary.render() as never),
    '<aside class="work-panel">Changes</aside>',
  );
  boundary.state = PanelBoundary.getDerivedStateFromError();
  const fallback = renderToStaticMarkup(boundary.render() as never);
  assert.match(fallback, /role="alert"/);
  assert.match(fallback, /This panel couldn(’|'|&#x27;)t be shown/);
  assert.match(fallback, /Try again/);
  assert.match(fallback, /aria-label="Close panel"/);
  // Another panel or conversation starts clean; the same one stays failed.
  let next: unknown;
  boundary.setState = ((value: unknown) => (next = value)) as never;
  boundary.componentDidUpdate({ resetKey: "changes:c-1" });
  assert.equal(next, undefined);
  boundary.componentDidUpdate({ resetKey: "terminal:c-1" });
  assert.deepEqual(next, { failed: false });
});

test("new conversations start with web search only where the policy turns it on and allows it", () => {
  assert.equal(draftWebSearchDefault(openPolicy), false);
  assert.equal(
    draftWebSearchDefault({ ...openPolicy, webSearchDefault: true }),
    true,
  );
  assert.equal(
    draftWebSearchDefault({ ...lockedPolicy, webSearchDefault: true }),
    false,
  );
});
