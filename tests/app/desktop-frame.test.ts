import test from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../support/read-source";
import { defaultSidebarWidth } from "../../shared/sidebar-layout";
import { desktopHost, webHost } from "../../shared/host";
import { sidebarWidth, windowChrome } from "../../src/host/layout";
import { hostWidth } from "../../src/split-view/useSplitPanes";

const stylesheet = (name: string) =>
  readSource(new URL(`../../src/${name}.css`, import.meta.url), "utf8");

test("frame defaults are 288px and 48px without responsive width overrides", () => {
  const foundation = stylesheet("styles/00-foundation");
  assert.match(foundation, /--sidebar-width: 288px;/);
  assert.match(foundation, /--titlebar-height: 48px;/);
  assert.equal(defaultSidebarWidth, 288);
  for (const name of [
    "styles/80-dialogs-responsive",
    "styles/90-reference-foundation",
    "styles/93-reference-responsive",
  ])
    assert.doesNotMatch(stylesheet(name), /--sidebar-width:/);
  for (const host of [desktopHost, webHost]) {
    assert.equal(sidebarWidth(host, defaultSidebarWidth), 288);
    assert.equal(sidebarWidth(host, 340), 340);
    assert.equal(sidebarWidth(host, 340, 360), 360);
  }
});

test("desktop cards use the live light and dark surfaces, ring and insets", () => {
  const css = stylesheet("sidebar/sidebar");
  assert.match(css, /--sidebar-card-bg: hsl\(0 0% 14\.9%\);/);
  assert.match(css, /--sidebar-card-ring: hsl\(from #fff h s l \/ 10%\);/);
  assert.match(
    css,
    /:root\[data-theme="light"\] \.app:not\(\.web\) \{[^}]*--sidebar-card-bg: white;[^}]*--sidebar-card-ring: hsl\(from #0b0b0b h s l \/ 10%\);/s,
  );
  assert.match(
    css,
    /\.app:not\(\.web\):not\(\.sidebar-hidden\) \.sidebar \{[^}]*grid-area: auto;[^}]*top: calc\(8px \+ var\(--sidebar-chrome-height\)\);[^}]*bottom: 8px;[^}]*inset-inline-start: 8px;[^}]*border-radius: 8px;[^}]*background: var\(--sidebar-card-bg\);[^}]*0 0 0 1px var\(--sidebar-card-ring\),[^}]*0 4px 24px color-mix\(in oklab, #0b0b0b 6%, transparent\);/s,
  );
});

test("all desktop pages reserve the caption row, while macOS keeps its traffic lights", () => {
  const css = stylesheet("sidebar/sidebar");
  assert.match(
    css,
    /\.app:not\(\.web\) \{[^}]*--sidebar-chrome-height: 36px;[^}]*padding-top: var\(--sidebar-chrome-height\);[^}]*padding-inline-end: 8px;/s,
  );
  assert.match(
    css,
    /\.app\.darwin:not\(\.web\) \{[^}]*--sidebar-chrome-height: 0px;[^}]*--sidebar-controls-top: 10px;[^}]*--traffic-light-spacer: 74px;/s,
  );
  assert.match(
    css,
    /\.app\.darwin:not\(\.web\):not\(\.sidebar-hidden\) \.sidebar-chrome \{[^}]*height: 44px;[^}]*padding-left: calc\(8px \+ var\(--traffic-light-spacer\)\);/s,
  );
  assert.match(css, /top: calc\(var\(--sidebar-controls-top\) \+ 36px\);/);
  const chrome = stylesheet("styles/90-reference-foundation");
  assert.match(chrome, /\.window-controls \{[^}]*height: 36px;/s);
  assert.match(chrome, /\.window-controls button \{[^}]*width: 46px;/s);
  assert.deepEqual(windowChrome(desktopHost, "win32"), {
    dragSurface: true,
    controls: true,
  });
  assert.deepEqual(windowChrome(desktopHost, "darwin"), {
    dragSurface: true,
    controls: false,
  });
  assert.deepEqual(windowChrome(webHost, "win32"), {
    dragSurface: false,
    controls: false,
  });
});

test("Chat, Cowork and Code share the frame header; split panes keep sidebar clearance", () => {
  for (const name of [
    "styles/20-workspace",
    "styles/90-reference-foundation",
  ]) {
    assert.match(
      stylesheet(name),
      /\.chat-header \{[^}]*height: var\(--titlebar-height\);[^}]*min-height: var\(--titlebar-height\);/s,
    );
  }
  const split = stylesheet("split-view/split-view");
  assert.match(
    split,
    /\.app\[data-split\] \{[^}]*grid-template-columns: calc\(var\(--sidebar-width\) \+ 8px\)/s,
  );
  assert.match(
    split,
    /\.app\[data-split\]\.sidebar-hidden \{[^}]*grid-template-columns: 0 var\(--df-col-tracks/s,
  );
  assert.match(
    stylesheet("sidebar/sidebar"),
    /\.app\.sidebar-animating \{[^}]*transition: grid-template-columns 150ms/s,
  );
  assert.match(stylesheet("styles/95-web"), /@media \(max-width: 639\.98px\)/);
});

test("split panes fit within the frame gutters with a docked or collapsed sidebar", () => {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "getComputedStyle",
  );
  let style = {
    gridTemplateColumns: "296px 540px 540px",
    paddingInlineStart: "0px",
    paddingInlineEnd: "8px",
    columnGap: "8px",
  };
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => style,
  });
  try {
    assert.equal(hostWidth({ clientWidth: 1400 } as HTMLElement), 1080);
    style = {
      gridTemplateColumns: "0px 692px 692px",
      paddingInlineStart: "8px",
      paddingInlineEnd: "8px",
      columnGap: "0px",
    };
    assert.equal(hostWidth({ clientWidth: 1400 } as HTMLElement), 1384);
  } finally {
    if (original)
      Object.defineProperty(globalThis, "getComputedStyle", original);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});
