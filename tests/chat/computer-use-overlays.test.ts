import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { Script } from "node:vm";
import { indicatorHtml } from "../../electron/computer-use/indicator-page";
import { teachHtml } from "../../electron/computer-use/teach-page";

test("full-display indicator uses the official glow and transient badge, not an interactive Stop pill", () => {
  const html = indicatorHtml("Notes", "Using <your> computer");
  const { document } = parseHTML(html);
  assert.equal(
    document.querySelector("#badge-label")?.textContent,
    "Using <your> computer",
  );
  assert.equal(document.querySelector("a,button,script"), null);
  assert.match(html, /glow-pulse 2s/);
  assert.match(html, /badge-center-to-corner 6s/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /inset 0 0 150px rgba\(217, 119, 87, 0.1\)/);
});

test("teaching uses the native tooltip layout, OS theme and localized controls", () => {
  const html = teachHtml(
    (text) =>
      ({
        Exit: "退出",
        Next: "下一步",
        "Working…": "处理中…",
        Teaching: "教学",
      })[text] ?? text,
  );
  const { document } = parseHTML(html);
  assert.equal(document.querySelector("#exit-btn")?.textContent, "退出");
  assert.equal(document.querySelector("#next-btn")?.textContent, "下一步");
  assert.equal(
    document.querySelector(".working-label")?.textContent,
    "处理中…",
  );
  assert.match(html, /min-width: 280px/);
  assert.match(html, /max-width: 420px/);
  assert.match(html, /border-radius: 16px/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /cuTeach.onWorking/);
  assert.match(html, /cuTeach.onReassertHover/);
  assert.doesNotThrow(
    () => new Script(document.querySelector("script")!.textContent!),
  );
});
