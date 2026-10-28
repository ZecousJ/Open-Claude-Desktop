import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_THINKING_VERBS,
  THINKING_VERB_MS,
  nextVerb,
} from "../../src/mobile-conversation/official/ThinkingVerb";
import { citedSources } from "../../src/mobile-conversation/official/SourcesChip";
import { stepContent } from "../../src/mobile-conversation/official/step-content";
import type { Turn } from "../../shared/types";

test("the thinking verb is one of the 17 official verbs and changes every 8 s to a different one", () => {
  assert.equal(OFFICIAL_THINKING_VERBS.length, 17);
  assert.equal(THINKING_VERB_MS, 8000);
  for (let previous = 0; previous < 17; previous++)
    for (const r of [0, 0.3, 0.999]) {
      const next = nextVerb(previous, () => r);
      assert.notEqual(next, previous);
      assert.ok(next >= 0 && next < 17);
    }
  assert.equal(
    nextVerb(undefined, () => 0.999),
    16,
  );
});

test("the sources chip counts each cited page once, in citation order", () => {
  const turn = {
    id: "t",
    prompt: "",
    attachments: [],
    status: "completed",
    createdAt: 0,
    items: [
      {
        id: "a",
        type: "agentMessage",
        text: "One fact. Another fact.",
        citations: [
          { url: "https://b.example/x", start: 0, end: 9 },
          { url: "https://a.example/y", start: 10, end: 23 },
          { url: "https://b.example/x", start: 10, end: 23 },
        ],
      },
    ],
  } as Turn;
  assert.deepEqual(
    citedSources(turn).map((source) => source.url),
    ["https://b.example/x", "https://a.example/y"],
  );
});

test("a command step's page shows its command as the request and its output as the response", () => {
  const content = stepContent({
    id: "c",
    type: "commandExecution",
    command: "ls",
    aggregatedOutput: "a.txt",
    status: "completed",
    exitCode: 0,
  });
  assert.equal(content.request, "ls");
  assert.deepEqual(content.response, [{ type: "text", text: "a.txt" }]);
  assert.equal(content.failed, false);
});
