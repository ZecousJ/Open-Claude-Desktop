/**
 * The web snapshot's slim conversations (shared/conversation-slim.ts): only
 * commands' long texts are cut, everything else is the same object.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  slimConversation,
  slimTextLimit,
} from "../../shared/conversation-slim";
import type { Conversation, Item } from "../../shared/types";

const long = "x".repeat(slimTextLimit + 500);

function conversation(items: Item[]): Conversation {
  return {
    id: "c1",
    title: "t",
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [{ id: "t1", prompt: "hi", status: "completed", items } as never],
  };
}

test("a command's long output, command and actions are cut", () => {
  const command = {
    id: "i1",
    type: "commandExecution",
    command: long,
    aggregatedOutput: long,
    commandActions: [{ type: "unknown", command: long }],
    exitCode: 0,
  } as unknown as Item;
  const message = { id: "i2", type: "agentMessage", text: long } as Item;
  const slim = slimConversation(conversation([command, message]));
  assert.equal(slim.slim, true);
  const item = slim.turns[0]!.items[0] as unknown as Record<string, any>;
  assert.equal(item.command.length, slimTextLimit + 1);
  assert.ok(item.command.endsWith("…"));
  assert.equal(item.aggregatedOutput.length, slimTextLimit + 1);
  assert.equal(item.commandActions[0].command.length, slimTextLimit + 1);
  assert.equal(item.commandActions[0].type, "unknown");
  assert.equal(item.exitCode, 0);
  assert.equal(slim.turns[0]!.items[1], message, "messages are kept whole");
});

test("a conversation with nothing long is the same object", () => {
  const short = {
    id: "i1",
    type: "commandExecution",
    command: "ls",
    aggregatedOutput: "a.txt",
  } as unknown as Item;
  const whole = conversation([short]);
  assert.equal(slimConversation(whole), whole);
  assert.equal(slimConversation(whole).slim, undefined);
});

test("absent fields stay absent, and saved branches are cut too", () => {
  const onlyOutput = {
    id: "i1",
    type: "commandExecution",
    aggregatedOutput: long,
  } as unknown as Item;
  const c = conversation([onlyOutput]);
  c.savedBranches = [
    {
      id: "b1",
      turns: conversation([onlyOutput]).turns,
      providerId: "p",
      model: "m",
      visited: 1,
    },
  ];
  const slim = slimConversation(c);
  const item = slim.turns[0]!.items[0] as unknown as Record<string, unknown>;
  assert.equal("command" in item, false);
  assert.equal("commandActions" in item, false);
  const branchItem = slim.savedBranches![0]!.turns[0]!.items[0] as unknown as {
    aggregatedOutput: string;
  };
  assert.equal(branchItem.aggregatedOutput.length, slimTextLimit + 1);
  assert.equal(c.turns[0]!.items[0], onlyOutput, "the original is untouched");
});
