import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "../../shared/types";
import { sessionContributions } from "../../src/session-rail/usage-contributions";

test("a session's contributions: MCP servers by their calls", () => {
  const conversation = {
    id: "c",
    mode: "code",
    turns: [
      {
        id: "t",
        status: "completed",
        items: [
          { id: "1", type: "mcpToolCall", server: "github" },
          { id: "2", type: "mcpToolCall", server: "github" },
          { id: "3", type: "mcpToolCall", server: "linear" },
        ],
      },
    ],
  } as unknown as Conversation;
  assert.deepEqual(sessionContributions(conversation), [
    { category: "MCP", name: "github", amount: 2, unit: "calls" },
    { category: "MCP", name: "linear", amount: 1, unit: "calls" },
  ]);
});
