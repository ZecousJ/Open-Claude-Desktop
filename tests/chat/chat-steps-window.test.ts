import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import { mergeRows } from "../../src/transcript/ChatSteps";
import type { Item, Turn } from "../../shared/types";

const command = (id: string, description: string): Item => ({
  id,
  type: "commandExecution",
  command: `echo ${id}`,
  description,
  status: "completed",
  lifecycleStatus: "completed",
});
const turn = (items: Item[], status: Turn["status"] = "inProgress"): Turn => ({
  id: "t",
  prompt: "test",
  attachments: [],
  createdAt: Date.now(),
  status,
  items,
});
const render = (value: Turn) =>
  renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn: value,
      awaitingApproval: false,
      onArtifact: () => {},
    }),
  );

test("a running group with three steps or more shows the latest two under “{n} steps”", () => {
  const items = [
    command("a", "List files"),
    command("b", "Run tests"),
    command("c", "Read the log"),
    command("d", "Fix the test"),
  ];
  const html = render(turn(items));
  assert.match(html, /class="chat-steps-more" aria-expanded="false"/);
  assert.match(html, /2 steps/);
  assert.doesNotMatch(html, /Listed files|Ran tests/);
  assert.match(html, /Read the log/);
  assert.match(html, /Fixed the test/);
  // Two steps: no header, both show.
  const two = render(turn(items.slice(0, 2)));
  assert.doesNotMatch(two, /chat-steps-more/);
  assert.match(two, /Listed files/);
  assert.match(two, /Ran tests/);
});

test("rows that leave keep their place while new ones join in order", () => {
  const before = {
    present: ["a", "b"],
    all: ["a", "b"],
    gone: new Map<string, string>(),
  };
  const previous = new Map([
    ["a", "A"],
    ["b", "B"],
  ]);
  // The window slides: "a" leaves above, "c" arrives below.
  const slid = mergeRows(before, ["b", "c"], previous);
  assert.deepEqual(slid.all, ["a", "b", "c"]);
  assert.deepEqual([...slid.gone], [["a", "A"]]);
  // A row coming back before it has gone is no longer leaving.
  const back = mergeRows(slid, ["a", "b", "c"], previous);
  assert.deepEqual(back.all, ["a", "b", "c"]);
  assert.equal(back.gone.size, 0);
  // Several new rows before a kept one keep their order.
  const header = mergeRows(
    { present: ["c"], all: ["c"], gone: new Map<string, string>() },
    ["h", "x", "c"],
    previous,
  );
  assert.deepEqual(header.all, ["h", "x", "c"]);
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());
