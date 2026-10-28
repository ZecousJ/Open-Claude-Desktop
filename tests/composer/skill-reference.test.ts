import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement, createRef } from "react";
import postcss from "postcss";
import { SkillReference } from "../../src/composer/SkillReference";
import { SkillTokenMirror } from "../../src/composer/SkillTokenMirror";
import { routineDom } from "../support/routine-dom";
import { referenceGeometry } from "../support/skill-reference-geometry";

const reference = (props: Parameters<typeof SkillReference>[0]) =>
  createElement(
    "div",
    { className: "composer-skill-mirror" },
    createElement(SkillReference, props),
  );

const css = postcss.parse(
  readFileSync("src/composer/skill-token-mirror.css", "utf8"),
);
const rule = (selector: string, property: string) => {
  let value: string | undefined;
  css.walkRules((row) => {
    if (row.selector.replace(/\s+/g, " ") === selector)
      row.walkDecls(property, (item) => {
        value = item.value.replace(/\s+/g, " ");
      });
  });
  return value;
};
test("the reference adapter separates visible slash from the unchanged real dollar protocol spelling", async () => {
  const env = await routineDom();
  const geometry = referenceGeometry(env.window as never, env.document);
  try {
    Object.assign(env.window, { innerWidth: 1440, innerHeight: 900 });
    await env.render(
      reference({
        name: "review",
        description: "Actual runtime description",
        raw: "$review",
      }),
    );
    assert.equal(
      env.document.querySelector(".composer-skill-raw")?.textContent,
      "$review",
    );
    assert.equal(
      env.document.querySelector(".composer-skill-prefix")?.textContent,
      "/",
    );
    assert.equal(
      env.document.querySelector(".composer-skill-name")?.textContent,
      "review",
    );
    assert.equal(
      env.document.querySelector("button")?.getAttribute("aria-label"),
      "/review",
    );
    assert.equal(rule(".composer-skill-prefix", "width"), "8px");
    assert.equal(rule(".composer-skill-prefix", "opacity"), "0.5");
    assert.equal(rule(".composer-skill-name", "user-select"), "none");
    assert.equal(rule(".composer-skill-raw", "visibility"), "hidden");
    assert.equal(rule(".composer-skill-reference", "color"), "#6da7ec");
    assert.equal(
      rule(".composer-skill-reference", "background"),
      "transparent",
    );
  } finally {
    await env.clean();
    geometry.restore();
  }
});

test("the actual read-only skill card exposes its source geometry, real description and caption and dismisses", async () => {
  const env = await routineDom();
  const geometry = referenceGeometry(env.window as never, env.document);
  try {
    Object.assign(env.window, { innerWidth: 1440, innerHeight: 900 });
    await env.render(
      reference({
        name: "review",
        description: "Actual runtime description",
        raw: "$review",
      }),
    );
    await env.click("button");
    const card = env.document.querySelector('[role="dialog"]')!;
    assert.equal(card.getAttribute("aria-label"), "review");
    assert.equal(
      card.querySelector("p")?.textContent,
      "Actual runtime description",
    );
    assert.equal(
      card.querySelector(".composer-skill-caption")?.textContent,
      "Skill",
    );
    assert.equal(
      card.querySelector("button, input"),
      null,
      "the card cannot install, enable or submit anything",
    );
    assert.equal(rule(".composer-skill-card", "width"), "178px");
    assert.equal(rule(".composer-skill-card", "border-radius"), "12px");
    assert.equal(rule(".composer-skill-card", "padding"), "8px");
    assert.equal(rule(".composer-skill-description", "padding"), "8px");
    assert.equal(
      rule(".composer-skill-description > p", "-webkit-line-clamp"),
      "5",
    );
    await env.event(env.document, "keydown", { key: "Escape" });
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    assert.equal(
      env.document.querySelector("button")?.getAttribute("aria-expanded"),
      "false",
    );
  } finally {
    await env.clean();
    geometry.restore();
  }
});

test("a restored raw invocation is not dressed as a callable reference when the real runtime reports disabled or missing", async () => {
  const env = await routineDom({
    customizeSkills: async () => [
      {
        name: "review",
        description: "Disabled",
        path: "/runtime/review/SKILL.md",
        scope: "user",
        enabled: false,
        own: true,
      },
    ],
  });
  try {
    await env.render(
      createElement(SkillTokenMirror, {
        text: "$review ",
        tokens: [{ name: "review", start: 0, end: 7 }],
        field: createRef<HTMLTextAreaElement>(),
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(
      env.document.querySelector(".composer-skill-reference-trigger"),
      null,
    );
    assert.match(
      env.document.querySelector(".composer-skill-mirror")!.textContent!,
      /\$review /,
    );
  } finally {
    await env.clean();
  }
});
