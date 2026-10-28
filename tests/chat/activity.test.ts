import assert from "node:assert/strict";
import test from "node:test";
import {
  finishTurn,
  itemIsRunning,
  recordItemLifecycle,
  turnActivity,
} from "../../shared/activity";
import type { Turn } from "../../shared/types";
const newTurn = (): Turn => ({
  id: "t",
  prompt: "test",
  attachments: [],
  items: [],
  status: "inProgress",
  createdAt: 1,
});

test("reasoning, command, post-command thinking and streaming follow real item boundaries", () => {
  const turn = newTurn();
  assert.equal(turnActivity(turn), "waiting");
  recordItemLifecycle(turn, { id: "r", type: "reasoning" }, false);
  assert.equal(turnActivity(turn), "thinking");
  recordItemLifecycle(turn, { id: "r", type: "reasoning" }, true);
  recordItemLifecycle(
    turn,
    { id: "c", type: "commandExecution", status: "inProgress" },
    false,
  );
  assert.equal(turnActivity(turn), "tools");
  recordItemLifecycle(
    turn,
    { id: "c", type: "commandExecution", status: "completed" },
    true,
  );
  assert.equal(turnActivity(turn), "thinking");
  recordItemLifecycle(
    turn,
    { id: "m", type: "agentMessage", text: "hello" },
    false,
  );
  assert.equal(turnActivity(turn), "streaming");
  finishTurn(turn, "completed");
  assert.equal(turnActivity(turn), "idle");
  assert.equal(turn.items.some(itemIsRunning), false);
});

test("approval takes precedence and terminal turns cannot be resurrected by late events", () => {
  const turn = newTurn();
  recordItemLifecycle(
    turn,
    { id: "c", type: "commandExecution", status: "inProgress" },
    false,
  );
  recordItemLifecycle(
    turn,
    { id: "m", type: "agentMessage", text: "commentary" },
    false,
  );
  assert.equal(turnActivity(turn), "tools");
  assert.equal(turnActivity(turn, true), "approval");
  finishTurn(turn, "interrupted");
  recordItemLifecycle(
    turn,
    { id: "c", type: "commandExecution", status: "inProgress" },
    false,
  );
  recordItemLifecycle(turn, { id: "late", type: "reasoning" }, false);
  assert.equal(turnActivity(turn, true), "idle");
  assert.equal(turn.items.some(itemIsRunning), false);
});

test("completion without native status stops progress, preserving buffered output", () => {
  const turn = newTurn();
  recordItemLifecycle(
    turn,
    {
      id: "c",
      type: "commandExecution",
      aggregatedOutput: "partial",
      status: "inProgress",
    },
    false,
  );
  recordItemLifecycle(turn, { id: "c", type: "commandExecution" }, true);
  assert.equal(itemIsRunning(turn.items[0]), false);
  assert.equal(turn.items[0].aggregatedOutput, "partial");
  recordItemLifecycle(turn, { id: "c", type: "commandExecution" }, false);
  assert.equal(itemIsRunning(turn.items[0]), false);
});

test("failed turns settle legacy tool items without changing their upstream status", () => {
  const turn = newTurn();
  turn.items.push({
    id: "legacy",
    type: "commandExecution",
    status: "inProgress",
  });
  finishTurn(turn, "failed");
  assert.equal(itemIsRunning(turn.items[0]), false);
  assert.equal(turn.items[0].status, "inProgress");
  assert.equal(turn.items[0].lifecycleStatus, "failed");
});

test("a reply that so far is only whitespace keeps the turn thinking", () => {
  const turn = newTurn();
  recordItemLifecycle(
    turn,
    { id: "m", type: "agentMessage", text: " " },
    false,
  );
  assert.equal(turnActivity(turn), "thinking");
  recordItemLifecycle(
    turn,
    { id: "m", type: "agentMessage", text: " 你好" },
    false,
  );
  assert.equal(turnActivity(turn), "streaming");
});
