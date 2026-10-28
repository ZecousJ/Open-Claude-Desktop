import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync("src/home/chat-home.css", "utf8");
const layoutCss = home.replace(/\/\*[\s\S]*?\*\//g, "");
const lazyComposer = readFileSync("src/live-web/composer.css", "utf8");
const main = readFileSync("src/main.tsx", "utf8");

test("web home headroom and compact greeting load before the lazy composer", () => {
  assert.match(main, /import "\.\/home\/chat-home\.css"/);
  assert.match(
    layoutCss,
    /@media \(min-width: 640px\) \{\s*\.app\.web \.chat-main \.chat-home \{\s*width: min\(624px, calc\(100% - 56px\)\);\s*padding-top: calc\(var\(--titlebar-height\) \+ 10vh \+ 16px\)/,
  );
  assert.match(
    layoutCss,
    /@media \(min-width: 768px\) \{\s*\.app\.web \.chat-main \.chat-home \{\s*width: min\(640px, calc\(100% - 128px\)\);\s*padding-top: calc\(var\(--titlebar-height\) \+ max\(28vh \+ 9\.1px, 192px\)\)/,
  );
  assert.match(
    home,
    /@media \(min-width: 768px\) and \(min-height: 900px\) \{\s*\.app\.web \.chat-main \.chat-home \{\s*padding-top: calc\(var\(--titlebar-height\) \+ 32vh \+ 9\.1px\)/,
  );
  const compact = home.match(
    /\.app\.web \.chat-main \.chat-home > h1 \{([^}]+)\}/,
  )?.[1];
  assert.ok(compact);
  assert.match(compact, /font-size: clamp\(24px, 18\.4px \+ 1vw, 32px\)/);
  assert.match(compact, /line-height: 1\.2/);
  assert.match(compact, /font-weight: 360/);
  assert.match(compact, /letter-spacing: normal/);
  assert.match(compact, /margin: 12px 0 24px/);
  assert.match(compact, /white-space: normal/);
  assert.match(compact, /text-wrap: balance/);
});

test("640, 767 and 768px CSS models match the measured frames without a dock below md", () => {
  const columnRule = (breakpoint: number) => {
    const rule = layoutCss.match(
      new RegExp(
        `@media \\(min-width: ${breakpoint}px\\) \\{\\s*\\.app\\.web \\.chat-main \\.chat-home \\{([^}]+)\\}`,
      ),
    )?.[1];
    assert.ok(rule);
    return rule;
  };
  const numbers = (css: string, pattern: RegExp) => {
    const match = css.match(pattern);
    assert.ok(match);
    return match.slice(1).map(Number);
  };
  const middle = columnRule(640);
  const desktop = columnRule(768);
  const widthRule = /width: min\(([\d.]+)px, calc\(100% - ([\d.]+)px\)\)/;
  const [middleCap, middleGutter] = numbers(middle, widthRule);
  const [desktopCap, desktopGutter] = numbers(desktop, widthRule);
  const [noticeVh, greetingInset] = numbers(
    middle,
    /padding-top: calc\(var\(--titlebar-height\) \+ ([\d.]+)vh \+ ([\d.]+)px\)/,
  );
  const [desktopVh, desktopInset, desktopFloor] = numbers(
    desktop,
    /max\(([\d.]+)vh \+ ([\d.]+)px, ([\d.]+)px\)/,
  );
  const [fontMin, fontBase, fontVw, fontMax] = numbers(
    layoutCss,
    /font-size: clamp\(([\d.]+)px, ([\d.]+)px \+ ([\d.]+)vw, ([\d.]+)px\)/,
  );
  const [greetingTop, greetingGap] = numbers(
    layoutCss,
    /margin: ([\d.]+)px 0 ([\d.]+)px/,
  );
  const [lineHeight] = numbers(layoutCss, /line-height: (1\.2);/);
  const [header] = numbers(
    readFileSync("src/styles/00-foundation.css", "utf8"),
    /--titlebar-height: ([\d.]+)px/,
  );
  const tall = numbers(
    layoutCss,
    /@media \(min-width: 768px\) and \(min-height: 900px\) \{\s*\.app\.web \.chat-main \.chat-home \{\s*padding-top: calc\(var\(--titlebar-height\) \+ ([\d.]+)vh \+ ([\d.]+)px\)/,
  );
  // Golden DOM measurements supplied by the root's current official tab.
  // Local fixtures retain their actual 242px sidebar instead of forcing 288.
  for (const [
    viewport,
    height,
    sidebar,
    expectedX,
    expectedY,
    expectedWidth,
  ] of [
    [640, 844, 0, 28, 214.1484375, 584],
    [767, 844, 288, 316, 215.6796875, 423],
    [767, 844, 242, 270, 215.6796875, 469],
    [768, 844, 288, 352, 360.703125, 352],
    [768, 844, 242, 306, 360.703125, 398],
    [1440, 900, 288, 544, 419.4921875, 640],
    [1440, 900, 242, 521, 419.4921875, 640],
    [1440, 900, 0, 400, 419.4921875, 640],
  ]) {
    const wide = viewport >= 768;
    const width = Math.min(
      wide ? desktopCap : middleCap,
      viewport - sidebar - (wide ? desktopGutter : middleGutter),
    );
    const headroom = wide
      ? height >= 900
        ? (height * tall[0]) / 100 + tall[1]
        : Math.max((height * desktopVh) / 100 + desktopInset, desktopFloor)
      : (height * noticeVh) / 100 + greetingInset;
    const font = Math.max(
      fontMin,
      Math.min(fontMax, fontBase + (viewport * fontVw) / 100),
    );
    const y = header + headroom + greetingTop + font * lineHeight + greetingGap;
    assert.equal(sidebar + (viewport - sidebar - width) / 2, expectedX);
    assert.equal(width, expectedWidth);
    // Browser layout quantizes fractional font and line metrics.
    assert.ok(Math.abs(y - expectedY) < 1 / 32, `${viewport}: ${y}`);
  }
});

test("loading the old composer cannot override ordinary or incognito web home headroom", () => {
  assert.doesNotMatch(
    lazyComposer,
    /^\s*\.chat-main \.chat-home \{\s*padding-top/m,
  );
  assert.match(
    lazyComposer,
    /\.app:not\(\.web\) \.chat-main \.chat-home \{\s*padding-top: calc\(25vh \+ 57\.5px\)/,
  );
  assert.doesNotMatch(lazyComposer, /\.app\.web\.incognito-app/);
});

test("measured web incognito uses the semantic dashed rim and separate 14px note", () => {
  const css = readFileSync("src/incognito/incognito.css", "utf8");
  assert.match(
    css,
    /\.app\.web\.incognito-app \.composer:focus-within \{\s*border: 1px dashed rgb\(225 224 217 \/ 30%\)/,
  );
  assert.match(
    css,
    /:root\[data-theme="light"\] \.app\.web\.incognito-app \.composer:focus-within \{\s*border-color: rgb\(30 30 29 \/ 30%\)/,
  );
  assert.match(
    css,
    /\.app\.web\.incognito-app \.incognito-note \{\s*margin: 48px 0 0;\s*font-size: 14px;\s*line-height: 20px;\s*color: #898781/,
  );
  assert.match(
    css,
    /\.app\.web\.incognito-app \.incognito-learn-more \{\s*display: block;/,
  );
  assert.match(
    css,
    /@media \(min-width: 640px\) \{[^}]*\.app\.web\.incognito-app \.composer-chin\[data-place="home"\] \{\s*padding-bottom: 0;/,
  );
  assert.match(
    css,
    /\.app\.web\.incognito-app \.incognito-bar \{[^}]*height: 48px;[^}]*padding: 0 8px 0 20px;/,
  );
  assert.match(
    css,
    /:root\[data-theme="light"\] \.app\.web\.incognito-app \{\s*background: #0b0b0b;/,
  );
  assert.match(
    css,
    /:root\[data-theme="light"\] \.app\.web\.incognito-app > \.workspace \{\s*background: #fcfcfa;/,
  );
  const bar = readFileSync("src/incognito/IncognitoBar.tsx", "utf8");
  assert.match(bar, /<span>Incognito<\/span>/);
  assert.doesNotMatch(bar, /<span>Incognito chat<\/span>/);
});
