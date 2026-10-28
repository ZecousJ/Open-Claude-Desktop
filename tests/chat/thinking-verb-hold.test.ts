import assert from "node:assert/strict";
import test from "node:test";
import {
  THINKING_VERBS,
  verbAfterTick,
} from "../../src/transcript/TurnActivity";

test("the 8 s tick picks a different word unless the verb is held", () => {
  const pick = (except?: string) =>
    except === "Mulling" ? "Musing" : "Mulling";
  assert.equal(verbAfterTick("Thinking", 0, pick), "Mulling");
  assert.equal(verbAfterTick("Mulling", 0, pick), "Musing");
  // One hold or more: the word stays (shared-13: holdCount > 0 skips the swap).
  assert.equal(verbAfterTick("Thinking", 1, pick), "Thinking");
  assert.equal(verbAfterTick("Thinking", 3, pick), "Thinking");
});

test("without a hold the real pick never repeats the current word", () => {
  for (const verb of THINKING_VERBS)
    for (let i = 0; i < 20; i++) assert.notEqual(verbAfterTick(verb, 0), verb);
});

test("the clay mark's words follow the chat word's place, modulo 15", async () => {
  const { clayVerb, CLAY_VERBS, THINKING_VERBS } =
    await import("../../src/transcript/TurnActivity");
  assert.equal(CLAY_VERBS.length, 15);
  assert.equal(clayVerb("Thinking"), "Thinking");
  assert.equal(clayVerb("Sifting"), "Kneading");
  assert.equal(clayVerb(THINKING_VERBS[14]), "Mulling");
  // The 16th wraps to the first.
  assert.equal(clayVerb(THINKING_VERBS[15]), "Thinking");
});
