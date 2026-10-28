import test from "node:test";
import assert from "node:assert/strict";
import { createReadAloud } from "../../src/transcript/read-aloud";
import { readAloudLabel } from "../../src/transcript/ReplyToolbar";
import type { Speaking } from "../../src/voice/speech";

/** A fake speech run the test drives: start, finish, and what was asked. */
function fakeSpeech() {
  const runs: {
    text: string;
    calls: string[];
    start: () => void;
    finish: () => void;
  }[] = [];
  const speak = (text: string, options: { onStart?: () => void } = {}) => {
    let finish = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    const calls: string[] = [];
    const run: Speaking = {
      done,
      cancel: () => {
        calls.push("cancel");
        finish();
      },
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
    };
    runs.push({ text, calls, start: () => options.onStart?.(), finish });
    return run;
  };
  return { speak, runs };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Read aloud: loading, then Pause, Resume, and Read aloud again", async () => {
  const { speak, runs } = fakeSpeech();
  const store = createReadAloud(speak);
  store.toggle("a", "Hello");
  assert.equal(store.phase("a"), "loading");
  assert.equal(readAloudLabel(store.phase("a")), "Pause");
  runs[0].start();
  assert.equal(store.phase("a"), "playing");
  store.toggle("a", "Hello");
  assert.equal(store.phase("a"), "paused");
  assert.equal(readAloudLabel("paused"), "Resume");
  store.toggle("a", "Hello");
  assert.equal(store.phase("a"), "playing");
  assert.deepEqual(runs[0].calls, ["pause", "resume"]);
  runs[0].finish();
  await settle();
  assert.equal(store.phase("a"), "idle");
  assert.equal(readAloudLabel("idle"), "Read aloud");
});

test("Read aloud reads one reply at a time", async () => {
  const { speak, runs } = fakeSpeech();
  const store = createReadAloud(speak);
  let changes = 0;
  store.subscribe(() => changes++);
  store.toggle("a", "First");
  runs[0].start();
  store.toggle("b", "Second");
  assert.deepEqual(runs[0].calls, ["cancel"]);
  assert.equal(store.phase("a"), "idle");
  assert.equal(store.phase("b"), "loading");
  // The stopped run ending later does not touch the new one.
  await settle();
  assert.equal(store.phase("b"), "loading");
  runs[0].start();
  assert.equal(store.phase("b"), "loading");
  runs[1].start();
  assert.equal(store.phase("b"), "playing");
  // Stopping another reply's reading leaves this one alone.
  store.stop("a");
  assert.equal(store.phase("b"), "playing");
  store.stop("b");
  assert.equal(store.phase("b"), "idle");
  assert.ok(changes > 0);
});

test("pausing while the voices load resumes into loading", () => {
  const { speak, runs } = fakeSpeech();
  const store = createReadAloud(speak);
  store.toggle("a", "Hello");
  store.toggle("a", "Hello");
  assert.equal(store.phase("a"), "paused");
  store.toggle("a", "Hello");
  assert.equal(store.phase("a"), "loading");
  runs[0].start();
  assert.equal(store.phase("a"), "playing");
});
