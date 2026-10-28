import test from "node:test";
import assert from "node:assert/strict";
import {
  builtInOutputStyles,
  outputStyleFor,
} from "../../shared/output-styles";
import { builtInOutputStyleNames } from "../../shared/output-style-names";

test("built-in output styles include the official selectable names", () => {
  assert.deepEqual(
    builtInOutputStyles.map((style) => style.name),
    ["default", "Concise", "Explanatory", "Learning", "Proactive"],
  );
  assert.match(outputStyleFor("Explanatory", undefined).prompt, /Insights/);
  assert.match(
    outputStyleFor("Learning", undefined).prompt,
    /Requesting Human Contributions/,
  );
});

test("custom output styles override the built-ins by name and unknown styles fall back", () => {
  const custom = { Review: { name: "Review", prompt: "Review every change." } };
  assert.equal(outputStyleFor("Review", custom).prompt, "Review every change.");
  assert.equal(outputStyleFor("Missing", custom).name, "default");
  assert.equal(outputStyleFor(undefined, custom).name, "default");
});

test("the menu's style names match the built-in styles", () => {
  assert.deepEqual(
    [...builtInOutputStyleNames],
    builtInOutputStyles.map((style) => style.name),
  );
});
