import test from "node:test";
import assert from "node:assert/strict";
import type { Item } from "../../shared/types";
import {
  chatStepsSummary,
  isChatStep,
  thoughtLine,
} from "../../src/transcript/ChatSteps";
import { chatSegments } from "../../src/transcript/ChatActivityGroup";

const read: Item = {
  id: "r",
  type: "commandExecution",
  command: "sed -n 1,80p SKILL.md",
  commandActions: [{ type: "read", name: "SKILL.md", path: "/s/SKILL.md" }],
  status: "completed",
};
const write = (id: string, path: string, kind = "add"): Item => ({
  id,
  type: "fileChange",
  status: "completed",
  changes: [{ path, kind: { type: kind }, diff: "" }],
});

test("a finished group counts what its steps did, in order, without names", () => {
  assert.equal(
    chatStepsSummary([read, write("w", "/w/pelican.html")]),
    "Read a file, created a file",
  );
  // Writing one file twice is still one file.
  assert.equal(
    chatStepsSummary([
      write("a", "/w/card.html", "update"),
      write("b", "/w/card.html", "update"),
    ]),
    "Edited a file",
  );
  assert.equal(
    chatStepsSummary([
      { ...read, id: "c1", commandActions: [] },
      { ...read, id: "c2", commandActions: [], exitCode: 2 },
    ]),
    "Ran 2 commands",
  );
  assert.equal(
    chatStepsSummary([{ ...read, commandActions: [], exitCode: 1 }]),
    "Command failed",
  );
  assert.equal(
    chatStepsSummary([
      {
        id: "t",
        type: "reasoning",
        summary: ["x"],
        startedAt: 0,
        completedAt: 12_000,
      },
    ]),
    "Thought for 12s",
  );
});

test("a thought step reads its heading, or else its first sentence", () => {
  assert.equal(
    thoughtLine({
      id: "a",
      type: "reasoning",
      summary: ["**Placing the frame**\nMore."],
    }),
    "Placing the frame",
  );
  assert.equal(
    thoughtLine({
      id: "b",
      type: "reasoning",
      summary: ["Adding spokes. Then more."],
    }),
    "Adding spokes.",
  );
});

test("a picture the agent looked at is a step and counts as reading a file", () => {
  const view = { id: "v", type: "imageView", path: "/w/red_circle.png" } as any;
  assert.equal(isChatStep(view), true);
  assert.equal(chatStepsSummary([view]), "Read a file");
  assert.equal(
    chatStepsSummary([
      {
        id: "c",
        type: "commandExecution",
        command: "python3 draw.py",
        commandActions: [{ type: "unknown" }],
        exitCode: 0,
      } as any,
      view,
    ]),
    "Ran a command, read a file",
  );
});

test("a picture the agent generated is a step and counts as creating a file", () => {
  const made = {
    id: "g",
    type: "imageGeneration",
    status: "completed",
    savedPath: "/w/cat.png",
  } as any;
  assert.equal(isChatStep(made), true);
  assert.equal(chatStepsSummary([made]), "Created a file");
  assert.deepEqual(
    chatSegments([made], new Set(), "chat").map((s) => s.activity),
    [true],
  );
  assert.deepEqual(
    chatSegments([made], new Set(), "cowork").map((s) => s.activity),
    [false],
  );
});

test("web searches are steps, and any number of them read Searched the web", () => {
  const search = (id: string, query: string) =>
    ({
      id,
      type: "webSearch",
      query,
      action: { type: "search", query },
      status: "completed",
    }) as any;
  const one = search("s1", "latest stable Rust release");
  assert.equal(isChatStep(one), true);
  assert.equal(chatStepsSummary([one]), "Searched the web");
  assert.equal(
    chatStepsSummary([one, search("s2", "Rust release announcement")]),
    "Searched the web",
  );
  assert.deepEqual(
    chatSegments([one, search("s2", "second")], new Set(), "chat").map(
      (segment) => [segment.activity, segment.items.length],
    ),
    [[true, 2]],
  );
  // Cowork keeps its own rows for searches.
  assert.equal(chatSegments([one], new Set(), "cowork")[0].activity, false);
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());
