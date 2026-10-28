import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { PixelMascot } from "../../src/composer/PixelMascot";
import { readSource } from "../support/read-source";

test("Code mascot preserves the original artwork and its natural native size", () => {
  const markup = renderToStaticMarkup(createElement(PixelMascot));
  const { document } = parseHTML(markup);
  const svg = document.querySelector("svg")!;
  assert.equal(svg.getAttribute("viewBox"), "0 0 36 24");
  assert.equal(svg.getAttribute("width"), "36");
  assert.equal(svg.getAttribute("height"), "24");
  assert.equal(svg.getAttribute("preserveAspectRatio"), "xMidYMax meet");
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.querySelectorAll("path").length, 2);
});

test("the web animation slot preserves 36x24 painted pixels instead of stretching the paths to 80px", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(createElement(PixelMascot, { webDraft: true })),
  );
  const svg = document.querySelector("svg")!;
  assert.equal(svg.getAttribute("viewBox"), "0 0 80 80");
  assert.equal(svg.getAttribute("width"), "80");
  assert.equal(
    svg.querySelector("g")?.getAttribute("transform"),
    "translate(22 43)",
  );
  const frameTop = 812;
  const slotBottom = frameTop + 144 / 11;
  const paintedBottom = slotBottom - 80 + 43 + 24;
  assert.ok(Math.abs(paintedBottom - frameTop) < 0.1);
  const source = readSource("src/composer/Composer.tsx");
  assert.match(source, /codeHomeDraft && <PixelMascot webDraft\s*\/>/);
});

test("native and web Code homes receive the measured 80px box and relative top anchor", () => {
  const sheets = [
    "src/composer/workspace-bar.css",
    "src/code-home/code-home.css",
  ].map((file) => postcss.parse(readFileSync(file, "utf8")));
  const geometry = (app: string, wrap: string) => {
    const { document } = parseHTML(
      renderToStaticMarkup(
        createElement(
          "div",
          { className: app },
          createElement("div", { className: wrap }, createElement(PixelMascot)),
        ),
      ),
    );
    const mascot = document.querySelector(".pixel-mascot")!;
    const values: Record<string, string> = {};
    for (const sheet of sheets)
      sheet.walkRules((rule) => {
        if (
          !rule.selector.includes("pixel-mascot") ||
          !mascot.matches(rule.selector)
        )
          return;
        rule.walkDecls((decl) => {
          values[decl.prop] = decl.value;
        });
      });
    return {
      width: values.width ?? `${mascot.getAttribute("width")}px`,
      height: values.height ?? `${mascot.getAttribute("height")}px`,
      right: values.right,
      bottom: values.bottom,
    };
  };
  assert.deepEqual(
    geometry(
      "app web mode-code",
      "composer-wrap code-composer code-home-composer web-code-draft",
    ),
    {
      width: "80px",
      height: "80px",
      right: "-13px",
      bottom: "calc(100% - 144px / 11)",
    },
  );
  assert.deepEqual(
    geometry("app mode-code", "composer-wrap code-composer code-home-composer"),
    geometry(
      "app web mode-code",
      "composer-wrap code-composer code-home-composer web-code-draft",
    ),
  );
  for (const [app, wrap] of [
    ["app mode-code", "composer-wrap code-composer"],
    ["app web mode-code", "composer-wrap code-composer conversation-composer"],
    ["app web mode-chat", "composer-wrap chat-composer"],
  ])
    assert.deepEqual(geometry(app, wrap), {
      width: "36px",
      height: "24px",
      right: "4.25px",
      bottom: "-8px",
    });
  // This calculates the captured contract, not a substitute for browser layout.
  const frame = { x: 480, y: 812, width: 768 };
  assert.equal(frame.x + frame.width + 13 - 80, 1181);
  assert.ok(Math.abs(frame.y + 144 / 11 - 80 - 745.090909) < 0.001);
});
