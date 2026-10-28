import test from "node:test";
import assert from "node:assert/strict";
import { agentPromptFromResponse } from "../../server/agent-prompt-observer";
const event = {
  type: "response.output_item.done",
  item: {
    type: "function_call",
    name: "spawn_agent",
    call_id: "call-fixture",
    arguments: JSON.stringify({
      task_name: "review",
      message: "Inspect synthetic UI",
    }),
  },
};
test("only completed spawn_agent arguments yield a bounded child prompt", () => {
  assert.deepEqual(agentPromptFromResponse(event, "parent-thread"), {
    parentThreadId: "parent-thread",
    callId: "call-fixture",
    message: "Inspect synthetic UI",
  });
  assert.equal(
    agentPromptFromResponse(
      { ...event, type: "response.function_call_arguments.delta" },
      "parent-thread",
    ),
    undefined,
  );
  assert.equal(
    agentPromptFromResponse(
      { ...event, item: { ...event.item, name: "exec_command" } },
      "parent-thread",
    ),
    undefined,
  );
  assert.equal(
    agentPromptFromResponse(
      { ...event, item: { ...event.item, arguments: "{bad" } },
      "parent-thread",
    ),
    undefined,
  );
  assert.equal(
    agentPromptFromResponse(
      {
        ...event,
        item: {
          ...event.item,
          arguments: JSON.stringify({ message: "a".repeat(100_001) }),
        },
      },
      "parent-thread",
    ),
    undefined,
  );
  assert.equal(agentPromptFromResponse(event, undefined), undefined);
  assert.deepEqual(
    agentPromptFromResponse(
      {
        ...event,
        item: {
          ...event.item,
          arguments: JSON.stringify({
            message: "Synthetic child",
            model: "fixture-child-model",
          }),
        },
      },
      "parent-thread",
    ),
    {
      parentThreadId: "parent-thread",
      callId: "call-fixture",
      message: "Synthetic child",
      model: "fixture-child-model",
    },
  );
});
