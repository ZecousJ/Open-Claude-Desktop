import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { SkillReference } from "../../src/composer/SkillReference";
import { skillReferenceFits } from "../../src/composer/skill-reference-layout";
import { routineDom } from "../support/routine-dom";
import { referenceGeometry } from "../support/skill-reference-geometry";

test("the geometry contract refuses hyphen fragments and any raw name overflowing a narrow field", () => {
  const rect = (left: number, top: number, width: number) => ({
    left,
    top,
    right: left + width,
    bottom: top + 21,
    width,
    height: 21,
  });
  const bounds = rect(0, 0, 334);
  assert.equal(
    skillReferenceFits([rect(250, 0, 42), rect(0, 21, 50)], bounds),
    false,
  );
  assert.equal(skillReferenceFits([rect(0, 0, 512)], bounds), false);
  assert.equal(skillReferenceFits([rect(0, 0, 92)], bounds), true);
  assert.equal(skillReferenceFits([], bounds), false);
});

test("real fallback hook follows split-to-single-line resize without altering raw bytes or suffix text", async () => {
  const env = await routineDom();
  const geometry = referenceGeometry(env.window as never, env.document);
  const draw = (prefix: string) =>
    createElement(
      "div",
      { className: "composer-skill-mirror" },
      prefix,
      createElement(SkillReference, {
        name: "skill-creator",
        raw: "$skill-creator",
        description: "Actual fixture metadata",
      }),
      " tail",
    );
  try {
    geometry.state.rects = [
      geometry.rect(250, 0, 42),
      geometry.rect(0, 21, 50),
    ];
    await env.render(draw("WWWWWWWWWWWWWWWWWW "));
    const raw = env.document.querySelector(".composer-skill-raw")!;
    assert.equal(env.document.querySelector("button"), null);
    assert.equal(
      env.document.querySelector("mark")?.getAttribute("data-reference-mode"),
      "raw",
    );
    assert.equal(
      env.document.querySelector(".composer-skill-mirror")?.textContent,
      "WWWWWWWWWWWWWWWWWW $skill-creator tail",
    );
    geometry.state.width = 640;
    geometry.state.rects = [geometry.rect(250, 0, 92)];
    await act(async () =>
      env.window.dispatchEvent(new env.window.Event("resize")),
    );
    assert.equal(env.document.querySelector(".composer-skill-raw"), raw);
    assert.equal(
      env.document.querySelector("button")?.textContent,
      "/skill-creator",
    );
    geometry.state.width = 334;
    geometry.state.rects = [
      geometry.rect(250, 0, 42),
      geometry.rect(0, 21, 50),
    ];
    await env.render(draw("WWWWWWWWWWWWWWWWWWW "));
    assert.equal(
      env.document.querySelector("button"),
      null,
      "a prefix/text edit must remeasure even if the token's own raw string is unchanged",
    );
    assert.equal(raw.textContent, "$skill-creator");
    assert.ok(
      env.document
        .querySelector(".composer-skill-mirror")
        ?.textContent?.endsWith(" tail"),
    );
  } finally {
    await env.clean();
    geometry.restore();
  }
});

test("a 64-character skill stays honest raw text while split and recovers only when the whole range fits", async () => {
  const env = await routineDom();
  const geometry = referenceGeometry(env.window as never, env.document);
  const name = "a".repeat(64),
    text = `$${name} tail`;
  try {
    geometry.state.width = 240;
    geometry.state.rects = [
      geometry.rect(0, 0, 235),
      geometry.rect(0, 21, 235),
      geometry.rect(0, 42, 42),
    ];
    await env.render(
      createElement(
        "div",
        { className: "composer-skill-field" },
        createElement("textarea", { value: text, readOnly: true }),
        createElement(
          "div",
          { className: "composer-skill-mirror" },
          createElement(SkillReference, {
            name,
            raw: `$${name}`,
            description: "Long fixture",
          }),
          " tail",
        ),
      ),
    );
    const field = env.document.querySelector("textarea")!;
    // Linkedom does not reflect React's initial controlled textarea value.
    // Seed the real native property so the reflow check can detect any write.
    Object.getOwnPropertyDescriptor(
      env.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, text);
    Object.assign(field, {
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    assert.equal(env.document.querySelector("button"), null);
    assert.equal(field.value, text);
    assert.equal(
      env.document.querySelector(".composer-skill-mirror")?.textContent,
      text,
    );
    geometry.state.width = 640;
    geometry.state.rects = [geometry.rect(0, 0, 512)];
    await act(async () =>
      env.window.dispatchEvent(new env.window.Event("resize")),
    );
    assert.equal(env.document.querySelector("button")?.textContent, `/${name}`);
    assert.equal(field.value, text);
    assert.equal(field.selectionStart, text.length);
    assert.equal(field.selectionEnd, text.length);
    assert.ok(
      env.document
        .querySelector(".composer-skill-mirror")
        ?.textContent?.endsWith(" tail"),
    );
  } finally {
    await env.clean();
    geometry.restore();
  }
});
