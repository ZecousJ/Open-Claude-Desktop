import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DropOverlay } from "../../src/composer/DropOverlay";
import type { FileDropState } from "../../src/composer/useFileDrop";

const card = (state: FileDropState) =>
  renderToStaticMarkup(
    createElement(DropOverlay, {
      scope: "card",
      state,
      label: "Drop files here",
    }),
  );

test("card drags show the dashed off-target layer and solid on-target layers", () => {
  assert.equal(card("idle"), "");
  const offTarget = card("off-target");
  assert.match(
    offTarget,
    /class="composer-drop-card" aria-hidden="true" data-state="open"/,
  );
  for (const layer of ["dashed", "ring", "glow"])
    assert.match(offTarget, new RegExp(`class="composer-drop-${layer}"`));
  assert.doesNotMatch(
    offTarget,
    /data-target|data-rejected|composer-drop-label/,
  );
  const onTarget = card("on-target");
  assert.match(onTarget, /data-target="true"/);
  assert.doesNotMatch(onTarget, /data-rejected|composer-drop-label/);
});

test("the page overlay is the surface at 90% over the document pictogram and the label", () => {
  const css = readFileSync("src/composer/drop-overlay.css", "utf8");
  assert.match(
    css,
    /\.composer-drop-page-fill\s*\{[^}]*color-mix\(in oklab, var\(--bg\) 90%/,
  );
  assert.doesNotMatch(css, /backdrop-filter|composer-drop-icons|data-rejected/);
  assert.match(css, /animation: composer-drop-fade-in 100ms/);
});

test("card feedback uses the official dashed frame, fast crossfade and reduced motion", () => {
  const css = readFileSync("src/composer/drop-overlay.css", "utf8");
  assert.match(
    css,
    /\.composer-drop-card > \.composer-drop-dashed\s*\{\s*border: 1px dashed var\(--drop-accent\)/,
  );
  assert.match(
    css,
    /\.composer-drop-card\[data-target\] > \.composer-drop-dashed\s*\{\s*opacity: 0/,
  );
  assert.match(
    css,
    /\.composer-drop-card\[data-target\] > \.composer-drop-ring,\s*\.composer-drop-card\[data-target\] > \.composer-drop-glow\s*\{\s*opacity: 1/,
  );
  assert.match(
    css,
    /transition: opacity var\(--motion-fast\) var\(--ease-standard\)/,
  );
  assert.match(
    css,
    /\.composer-drop-card\[data-state="closed"\]\s*\{\s*opacity: 0;\s*transform: scale\(0\.95\)/,
  );
  assert.match(
    css,
    /:root\[data-motion="reduced"\] \.composer-drop-card > div\s*\{\s*animation: none;\s*transition: none/,
  );
  assert.match(css, /pointer-events: none/);
});
