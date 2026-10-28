import assert from "node:assert/strict";
import test from "node:test";
import { countSmoother } from "../../src/transcript/smoothed-count";
import { filePreviewKind } from "../../src/files/FilesPanel";

test("the token count climbs to each new figure over the last update's interval", () => {
  const smoother = countSmoother();
  smoother.snapTo(476, 0);
  smoother.update(545, 500);
  // 500ms since the last figure: the climb takes 500ms.
  assert.equal(smoother.valueAt(500), 476);
  assert.equal(smoother.valueAt(750), 510);
  assert.equal(smoother.valueAt(1000), 545);
  // A quick update still takes 300ms; a slow one at most 3s.
  smoother.update(634, 1100);
  smoother.update(640, 1200);
  assert.ok(smoother.valueAt(1499)! < 640);
  assert.equal(smoother.valueAt(1500), 640);
  smoother.update(700, 9000);
  assert.ok(smoother.valueAt(11_999)! < 700);
  assert.equal(smoother.valueAt(12_000), 700);
});

test("a first count rises from zero and a smaller one is taken at once", () => {
  const smoother = countSmoother();
  smoother.update(1200, 0);
  assert.equal(smoother.valueAt(600), 600);
  smoother.update(900, 700);
  assert.equal(smoother.valueAt(700), 900);
});

test("HTML, SVG and Markdown files have a preview", () => {
  assert.equal(filePreviewKind("site/index.html"), "html");
  assert.equal(filePreviewKind("a.HTM"), "html");
  assert.equal(filePreviewKind("logo.svg"), "svg");
  assert.equal(filePreviewKind("README.md"), "markdown");
  assert.equal(filePreviewKind("main.ts"), undefined);
});
