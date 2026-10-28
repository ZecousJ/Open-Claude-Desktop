import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { MakeSomethingNew } from "../../src/artifacts/MakeSomethingNew";
import { routineDom } from "../support/routine-dom";

async function artworkDom() {
  const env = await routineDom({}, { jsdom: true });
  const sheet = env.document.createElement("style");
  sheet.textContent = ["gallery.css", "template-artwork.css"]
    .map((name) =>
      readFileSync(
        new URL(`../../src/artifacts/${name}`, import.meta.url),
        "utf8",
      ),
    )
    .join("\n");
  env.document.head.append(sheet);
  env.document.documentElement.style.fontSize = "14px";
  env.document.documentElement.dataset.theme = "dark";
  await env.render(h(MakeSomethingNew, { onCreate() {} }));
  const style = (element: Element) => env.window.getComputedStyle(element);
  const art = (kind: string) =>
    env.document.querySelector(`[data-artwork-kind="${kind}"]`)!;
  const part = (name: string) =>
    env.document.querySelector(`[data-motion-part="${name}"]`)!;
  const box = (element: Element, expected: string[]) => {
    const s = style(element);
    assert.deepEqual(
      [s.left, s.top, s.width, s.height, s.borderRadius],
      expected,
    );
  };
  return { ...env, style, art, part, box };
}

test("all four rendered template pictures retain measured frame, clip, label and badge geometry at a 14px root", async () => {
  const env = await artworkDom();
  try {
    const buttons = [...env.document.querySelectorAll(".artifacts-make-card")];
    assert.deepEqual(
      buttons.map((b) => b.getAttribute("aria-label")),
      ["Docs, New", "Slides, New", "Design, New", "Dashboard, Beta"],
    );
    for (const button of buttons) {
      assert.equal(button.hasAttribute("id"), false);
      assert.equal(button.hasAttribute("aria-describedby"), false);
      const frame = button.querySelector(".artifacts-make-art")!,
        label = button.querySelector(".artifacts-make-label")!,
        badge = button.querySelector(".artifacts-make-badge")!;
      assert.deepEqual(
        [
          env.style(button).width,
          env.style(button).height,
          env.style(button).gap,
        ],
        ["136px", "119px", "6px"],
      );
      assert.deepEqual(
        [
          env.style(frame).width,
          env.style(frame).height,
          env.style(frame).borderRadius,
        ],
        ["136px", "96px", "14px"],
      );
      assert.equal(frame.getAttribute("aria-hidden"), "true");
      const clip = frame.querySelector(".artifacts-template-clip")!;
      assert.deepEqual(
        [
          env.style(clip).inset,
          env.style(clip).borderRadius,
          env.style(clip).overflow,
        ],
        ["6px", "8px", "hidden"],
      );
      assert.deepEqual(
        [
          env.style(label).fontSize,
          env.style(label).lineHeight,
          env.style(label).padding,
        ],
        ["13px", "17px", "0px 2px"],
      );
      assert.deepEqual(
        [
          env.style(badge).height,
          env.style(badge).fontSize,
          env.style(badge).lineHeight,
        ],
        ["16px", "10px", "13px"],
      );
    }
    assert.equal(
      env.style(env.document.querySelector(".artifacts-make-row")!).gap,
      "12px",
    );
  } finally {
    await env.clean();
  }
});
