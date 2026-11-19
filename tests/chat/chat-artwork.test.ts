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

test("rendered Docs, Slides, Design and Dashboard use the captured shape coordinates, paths and idle layers", async () => {
  const env = await artworkDom();
  try {
    env.box(env.art("docs").querySelector(".artifacts-template-ink > span")!, [
      "38px",
      "9px",
      "48px",
      "66px",
      "5px",
    ]);
    env.box(env.part("docs-head"), ["7px", "7px", "22px", "5px", "9999px"]);
    env.box(env.part("slides-paper"), ["14px", "14px", "96px", "56px", "0px"]);
    env.box(env.part("slides-title"), [
      "10px",
      "10px",
      "50px",
      "9px",
      "9999px",
    ]);
    env.box(
      env.art("design").querySelector(".artifacts-template-ink > span")!,
      ["42px", "8px", "40px", "68px", "6px"],
    );
    env.box(env.part("design-row-0"), ["0px", "0px", "30px", "7px", "0px"]);
    const dashboard = env
      .art("dashboard")
      .querySelector(".artifacts-template-ink > span")!;
    env.box(dashboard, ["14px", "14px", "96px", "56px", "7px"]);
    assert.deepEqual(
      [...dashboard.children].map((bar) => [
        env.style(bar).left,
        env.style(bar).top,
        env.style(bar).width,
        env.style(bar).height,
      ]),
      [
        ["11px", "34px", "14px", "12px"],
        ["31px", "26px", "14px", "20px"],
        ["51px", "16px", "14px", "30px"],
        ["71px", "30px", "14px", "16px"],
      ],
    );
    for (const [kind, count] of [
      ["docs", 4],
      ["slides", 4],
      ["design", 2],
      ["dashboard", 2],
    ] as const) {
      assert.equal(env.art(kind).querySelectorAll("svg").length, count);
      assert.equal(env.style(env.part(`${kind}-cursor`)).opacity, "0");
    }
    assert.equal(
      env
        .art("docs")
        .querySelector(".artifacts-template-check path")!
        .getAttribute("d"),
      "M2.6 5.2L4.3 6.8L7.4 3.4",
    );
    assert.equal(
      env
        .art("dashboard")
        .querySelector(".artifacts-template-cursor path")!
        .getAttribute("d"),
      "M1.5 1.5L1.5 12.5L4.6 9.8L6.9 14.3L8.9 13.4L6.7 9L11 9Z",
    );
    assert.equal(
      env.style(env.part("slides-paper")).transformOrigin,
      "top left",
    );
    assert.equal(
      env.style(env.part("docs-cap")).transformOrigin,
      "bottom left",
    );
    assert.equal(
      env.style(env.part("dashboard-bar-2")).transformOrigin,
      "bottom",
    );
  } finally {
    await env.clean();
  }
});

test("the rendered artwork switches semantic ink, paper, neutral, shadows and badge colors between dark and light", async () => {
  const env = await artworkDom();
  try {
    for (const [kind, hue] of [
      ["docs", "#256abf"],
      ["slides", "#b7791f"],
      ["design", "#7663b8"],
      ["dashboard", "#6250d6"],
    ]) {
      const frame = env.art(kind),
        ink = frame.querySelector(".artifacts-template-ink")!;
      assert.equal(env.style(frame).getPropertyValue("--hue").trim(), hue);
      assert.equal(
        env.style(frame).getPropertyValue("--neutral").trim(),
        "#fff",
      );
      assert.equal(
        env.style(frame).getPropertyValue("--template-shadow").trim(),
        "rgb(0 0 0/24%)",
      );
      assert.equal(
        env.style(ink).getPropertyValue("--ink").trim(),
        "color-mix(in srgb,var(--hue) 72%,white)",
      );
      assert.equal(
        env.style(ink).getPropertyValue("--tint-boost").trim(),
        "30%",
      );
      assert.ok(
        env
          .style(ink)
          .getPropertyValue("--card-fill")
          .includes("var(--neutral) 5%"),
      );
    }
    env.document.documentElement.dataset.theme = "light";
    for (const frame of env.document.querySelectorAll(".artifacts-make-art")) {
      const ink = frame.querySelector(".artifacts-template-ink")!;
      assert.equal(
        env.style(frame).getPropertyValue("--neutral").trim(),
        "#0b0b0b",
      );
      assert.equal(
        env.style(frame).getPropertyValue("--template-surface").trim(),
        "#fff",
      );
      assert.equal(
        env.style(frame).getPropertyValue("--template-shadow").trim(),
        "rgb(11 11 11/8%)",
      );
      assert.equal(
        env.style(ink).getPropertyValue("--ink").trim(),
        "var(--hue)",
      );
      assert.equal(
        env.style(ink).getPropertyValue("--card-fill").trim(),
        "white",
      );
      assert.equal(
        env.style(ink).getPropertyValue("--tint-boost").trim(),
        "0%",
      );
    }
    assert.equal(
      env.style(env.document.querySelector(".artifacts-make-badge.new")!).color,
      "rgb(24, 79, 149)",
    );
  } finally {
    await env.clean();
  }
});
