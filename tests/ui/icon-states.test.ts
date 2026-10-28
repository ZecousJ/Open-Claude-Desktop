import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Spinner } from "../../src/ui/Spinner";
import * as glyphs from "../../src/ui/glyphs";
import { TaskStatusTile } from "../../src/cowork/task-status";

test("CDS spinner sizes, track, arc, delay and inherited ink", () => {
  for (const [size, box, stroke] of [
    ["sm", 12, 1.5],
    ["md", 16, 1.75],
    ["lg", 20, 2],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(Spinner, { size, inheritColor: true }),
    );
    assert.match(html, new RegExp(`width:${box}px;height:${box}px`));
    assert.match(html, new RegExp(`border:${stroke}px solid color-mix`));
    assert.match(html, /currentColor 25%, transparent/);
    assert.match(html, /conic-gradient\(transparent 40%, currentColor\)/);
    assert.match(html, /radial-gradient\(farthest-side/);
    assert.match(html, /aria-hidden="true"/);
    assert.doesNotMatch(html, /<svg|role="status"/);
  }
  assert.equal(
    renderToStaticMarkup(createElement(Spinner, { delay: 100 })),
    "",
  );
  const defaultInk = renderToStaticMarkup(createElement(Spinner));
  assert.match(defaultInk, /var\(--text-muted\)/);
  assert.match(defaultInk, /var\(--alpha-ink\) 10%/);
  for (const [pixels, box] of [
    [10, 12],
    [14, 16],
    [18, 20],
  ]) {
    assert.match(
      renderToStaticMarkup(createElement(Spinner, { size: pixels })),
      new RegExp(`width:${box}px`),
    );
  }
  const css = readFileSync("src/ui/spinner.css", "utf8");
  assert.match(css, /spin 1s linear infinite/);
  assert.match(css, /prefers-reduced-motion: reduce.*animation: none/s);
  assert.match(css, /data-motion="reduced".*animation: none/s);
});

test("delayed spinner reveals, announces after 100ms, and resets when delay changes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const wait = (delay: number) =>
    act(() => {
      context.mock.timers.tick(delay);
    });
  try {
    await act(() =>
      root.render(createElement(Spinner, { delay: 20, label: "Loading" })),
    );
    assert.ok(document.querySelector('[role="status"]'));
    assert.equal(document.querySelector('[data-cds="Spinner"]'), null);
    assert.equal(document.querySelector(".sr-only"), null);
    await wait(40);
    assert.ok(document.querySelector('[data-cds="Spinner"]'));
    assert.equal(document.querySelector(".sr-only"), null);
    await wait(90);
    assert.equal(document.querySelector(".sr-only")?.textContent, "Loading");
    await act(() =>
      root.render(createElement(Spinner, { delay: 1000, label: "Loading" })),
    );
    assert.equal(document.querySelector('[data-cds="Spinner"]'), null);
    assert.equal(document.querySelector(".sr-only"), null);
    await act(() =>
      root.render(createElement(Spinner, { delay: 0, label: "Loading" })),
    );
    assert.ok(document.querySelector('[data-cds="Spinner"]'));
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("task tiles use live overrides and PR states without overriding attention", () => {
  const tile = (
    status: Parameters<typeof TaskStatusTile>[0]["status"],
    pullRequestState?: Parameters<typeof TaskStatusTile>[0]["pullRequestState"],
  ) =>
    renderToStaticMarkup(
      createElement(TaskStatusTile, { status, pullRequestState }),
    );
  assert.equal((tile("running").match(/<span/g) ?? []).length, 5);
  assert.match(tile("running"), /cowork-tile-dots/);
  assert.match(tile("idle"), /lucide-circle-dashed/);
  for (const [status, name] of [
    ["needs_input", "Hand"],
    ["errored", "X"],
    ["ready_review", "Eye"],
    ["done", "Check"],
  ] as const) {
    assert.match(tile(status), new RegExp(`data-icon="${name}"`));
    assert.match(tile(status), /width="20" height="20"/);
  }
  for (const state of [
    "open",
    "draft",
    "queued",
    "merged",
    "closed",
  ] as const) {
    const name =
      state === "queued" || state === "merged"
        ? "GitMerge"
        : state === "closed"
          ? "GitPullRequestClosed"
          : "GitPullRequest";
    assert.match(tile("done", state), new RegExp(`cowork-pr-${state}`));
    assert.match(tile("idle", state), new RegExp(`data-icon="${name}"`));
    for (const status of [
      "running",
      "needs_input",
      "errored",
      "ready_review",
    ] as const)
      assert.doesNotMatch(tile(status, state), /cowork-pr-/);
  }
  const css = readFileSync("src/cowork/cowork-active.css", "utf8");
  assert.match(css, /cowork-status-tile[^}]+32px/);
  assert.match(css, /cowork-tile-dot-pulse 1\.8s linear infinite/);
});

test("busy buttons center the CDS spinner without dimming it", () => {
  const css = readFileSync("src/styles/00-foundation.css", "utf8");
  assert.match(css, /button\.busy > \.busy-label\s*\{\s*visibility: hidden/);
  const rule = css.match(/button\.busy > \.cds-spinner\s*\{([^}]+)\}/)![1];
  assert.match(rule, /position: absolute/);
  assert.match(rule, /margin: auto/);
  assert.doesNotMatch(rule, /opacity/);
  const nav = readFileSync("src/sidebar/MainNav.tsx", "utf8");
  assert.equal((nav.match(/AppIcon name="Tool"/g) ?? []).length, 2);
  assert.doesNotMatch(
    nav,
    /BriefcaseIcon|ProjectsIcon|ArtifactsIcon|ClockIcon/,
  );
});
