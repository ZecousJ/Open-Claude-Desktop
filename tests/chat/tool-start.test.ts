import assert from "node:assert/strict";
import test from "node:test";
import { streamChatResponse, toChat } from "../../electron/engine/gateway-chat";
import {
  parseToolStartSignal,
  toolStartFromResponse,
} from "../../shared/tool-start";

const frame = (value: unknown) =>
  `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;

test("an apply_patch call is reported when it opens, other tools are not", () => {
  const added = (item: object) => ({
    type: "response.output_item.added",
    item,
  });
  assert.deepEqual(
    toolStartFromResponse(
      added({
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "call_1",
      }),
      "thread",
    ),
    { threadId: "thread", callId: "call_1" },
  );
  assert.equal(
    toolStartFromResponse(
      added({ type: "function_call", name: "exec_command", call_id: "call_2" }),
      "thread",
    ),
    undefined,
  );
  assert.equal(
    toolStartFromResponse(
      {
        type: "response.output_item.done",
        item: { type: "custom_tool_call", name: "apply_patch", call_id: "c" },
      },
      "thread",
    ),
    undefined,
  );
  assert.equal(parseToolStartSignal({ threadId: "t", callId: "" }), undefined);
});

test("the Chat bridge reports a call as soon as its name and id arrive", async () => {
  const opened: any[] = [];
  const sent: any[] = [];
  const tools = [
    { type: "custom", name: "apply_patch", description: "Edit files." },
  ];
  const chunks = [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_9",
                function: { name: "apply_patch", arguments: "" },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: '{"input":"*** Begin Patch\\n*** End Patch"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ];
  await streamChatResponse(
    new Response(chunks.map(frame).join("") + frame("[DONE]")),
    (event) => sent.push(event),
    toChat({ tools }).mapping,
    "mock-model",
    undefined,
    (event) => opened.push({ event, sentBefore: sent.length }),
  );
  assert.equal(opened.length, 1);
  assert.deepEqual(toolStartFromResponse(opened[0].event, "t"), {
    threadId: "t",
    callId: "call_9",
  });
  // Codex hears of the call only once it is whole.
  assert.ok(
    sent.some(
      (event) =>
        event.type === "response.output_item.done" &&
        event.item.call_id === "call_9",
    ),
  );
});
