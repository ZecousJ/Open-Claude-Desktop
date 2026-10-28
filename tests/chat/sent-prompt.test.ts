import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "../../shared/types";
import { sentPromptOf } from "../../src/transcript/sent-prompt";

const turn = (prompt: string, rawOriginals?: string[]) =>
  ({
    id: "t",
    prompt,
    attachments: [],
    items: [],
    status: "completed",
    rawOriginals,
  }) as unknown as Turn;

test("a prompt sent as shown has no sent prompt to view", () => {
  assert.equal(sentPromptOf(turn("hey", ["hey"])), undefined);
  assert.equal(sentPromptOf(turn("hey")), undefined);
  assert.equal(sentPromptOf(turn("hey", [])), undefined);
});

test("a prompt the model got differently keeps its sent text", () => {
  assert.deepEqual(sentPromptOf(turn("look", ["look", "<file>a</file>"])), [
    "look",
    "<file>a</file>",
  ]);
  assert.deepEqual(sentPromptOf(turn("look", ["look\n\n> quote"])), [
    "look\n\n> quote",
  ]);
});
