import test from "node:test";
import assert from "node:assert/strict";
import {
  greetingChoices,
  homeGreeting,
  timeOfDayGreeting,
} from "../../shared/home-greeting";

test("Home greeting follows the local time of day", () => {
  assert.equal(timeOfDayGreeting(4), "Good evening");
  assert.equal(timeOfDayGreeting(5), "Good morning");
  assert.equal(timeOfDayGreeting(11), "Good morning");
  assert.equal(timeOfDayGreeting(12), "Good afternoon");
  assert.equal(timeOfDayGreeting(16), "Good afternoon");
  assert.equal(timeOfDayGreeting(17), "Good evening");
  assert.equal(timeOfDayGreeting(23), "Good evening");
});

test("Home greeting offers every captured sentence at the right hours", () => {
  assert.deepEqual(greetingChoices("Ada", 19), [
    "Good evening, Ada",
    "Back at it, Ada",
    "Let’s noodle",
    "Evening, how are things?",
    "Evening thoughts",
  ]);
  assert.deepEqual(greetingChoices("Ada", 9), [
    "Good morning, Ada",
    "Back at it, Ada",
    "Let’s noodle",
  ]);
  assert.deepEqual(greetingChoices("Ada", 14), [
    "Good afternoon, Ada",
    "Afternoon, Ada",
    "Back at it, Ada",
    "Let’s noodle",
  ]);
  assert.deepEqual(greetingChoices(" ", 14), [
    "Good afternoon",
    "Let’s noodle",
  ]);
});

test("Home greeting picks each sentence for its share of rolls", () => {
  const seen = new Set<string>();
  for (let roll = 0; roll < 1; roll += 0.01)
    seen.add(homeGreeting("Ada", 21, roll));
  assert.deepEqual([...seen].sort(), greetingChoices("Ada", 21).sort());
  assert.equal(homeGreeting("Ada", 19, 0), "Good evening, Ada");
  assert.equal(homeGreeting("Ada", 19, 0.999), "Evening thoughts");
  assert.equal(homeGreeting("  ", 9, 0.1), "Good morning");
});
