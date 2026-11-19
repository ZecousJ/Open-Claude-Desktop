import test from "node:test";
import assert from "node:assert/strict";
import { codeAgentActivityText } from "../electron/official-ui/native/code-tool-transcript";
import { convertCodeTranscript } from "../electron/official-ui/native/code-transcript";
import type { Conversation, Item } from "../shared/types";

function conversation(items: Item[]): Conversation {
  return {
    id: "c",
    title: "Observed activity",
    mode: "code",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1000,
    updatedAt: 1000,
    turns: [
      {
        id: "t",
        prompt: "Review",
        attachments: [],
        status: "completed",
        createdAt: 1000,
        items,
      },
    ],
  };
}
const collab = (extra: Record<string, unknown> = {}): Item => ({
  id: "call",
  type: "collabAgentToolCall",
  tool: "spawnAgent",
  status: "completed",
  lifecycleStatus: "completed",
  receiverThreadIds: ["child-1"],
  agentsStates: { "child-1": { status: "running" } },
  ...extra,
});

test("spawned child has an original Agent card and running task without a completion", () => {
  const c = conversation([
    collab({ prompt: "Inspect sources", agentPrompt: "Check the child" }),
  ]);
  const before = structuredClone(c);
  const result = convertCodeTranscript(c);
  assert.deepEqual(result.unsupported, []);
  const use = result.rows[1];
  assert.equal(use.uuid, "t:agent:call:child-1:use");
  assert.deepEqual(use.message.content, [
    {
      type: "tool_use",
      id: "t:agent:call:child-1",
      name: "Agent",
      input: {
        description: "Subagent",
        prompt: "Check the child",
        subagent_type: "general-purpose",
      },
    },
  ]);
  assert.equal(result.rows[2].toolUseResult?.agentId, "child-1");
  assert.ok(
    result.rows.some(
      (row) =>
        row.type === "system" &&
        row.subtype === "task_started" &&
        row.task_id === "child-1",
    ),
  );
  assert.ok(
    !result.rows.some(
      (row) => row.type === "system" && row.subtype === "task_notification",
    ),
  );
  assert.deepEqual(c, before);
  assert.deepEqual(convertCodeTranscript(c), result);
});

test("V2 events preserve observations and known child states without guessing missing status", () => {
  for (const status of [
    "pendingInit",
    "running",
    "completed",
    "errored",
    "interrupted",
    "shutdown",
    "stopped",
  ]) {
    const item: Item = {
      id: "activity",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child",
      agentsStates: { child: { status, message: "SECRET_MESSAGE" } },
      agentTokenUsage: { child: 1234 },
    };
    const text = codeAgentActivityText(item)!;
    assert.match(
      text,
      new RegExp(`Child child: ${status}; 1234 recorded tokens`),
    );
    assert.doesNotMatch(text, /SECRET_MESSAGE/);
  }
  const text = codeAgentActivityText({
    id: "a",
    type: "subAgentActivity",
    kind: "interrupted",
    agentThreadId: "child",
  })!;
  assert.match(text, /event: interrupted/);
  assert.match(text, /Child child: unknown/);
  assert.match(text, /Recorded child activity/);
});

test("unknown tools, missing identities and malformed events keep safe placeholders", () => {
  for (const item of [
    collab({ tool: "futureTool" }),
    collab({ receiverThreadIds: null }),
    collab({ receiverThreadIds: [] }),
    collab({ receiverThreadIds: [{ secret: "SECRET" }] }),
    {
      id: "a",
      type: "subAgentActivity",
      kind: "futureEvent",
      agentThreadId: "child",
    },
    {
      id: "a",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child\nSECRET",
    },
    { id: "a", type: "subAgentActivity", kind: "started" },
  ] as Item[]) {
    assert.equal(codeAgentActivityText(item), undefined);
    const result = convertCodeTranscript(conversation([item]));
    assert.deepEqual(result.unsupported, [item.type]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /SECRET|futureTool|futureEvent/,
    );
  }
});

test("projection bounds child records and rejects unknown states and invalid counters", () => {
  const item = collab({
    receiverThreadIds: [
      ...Array.from({ length: 10000 }, (_, i) => `child-${i}`),
      "SECRET_TAIL",
    ],
    agentsStates: {
      "child-0": { status: "SECRET_STATUS" },
      "child-1": { status: "completed" },
    },
    agentTokenUsage: {
      "child-0": Infinity,
      "child-1": -10,
      "child-2": "SECRET_TOKENS",
    },
    metadata: { secret: "SECRET_METADATA" },
  });
  const text = codeAgentActivityText(item)!;
  assert.equal((text.match(/^Child /gm) ?? []).length, 32);
  assert.match(text, /records omitted/);
  assert.match(text, /Child child-0: unknown/);
  assert.doesNotMatch(text, /SECRET|recorded tokens/);
  assert.ok(text.length < 6000);
  const malformed = codeAgentActivityText(
    collab({
      receiverThreadIds: ["child", null, "child"],
      agentsStates: [],
      agentTokenUsage: [],
    }),
  )!;
  assert.equal((malformed.match(/^Child /gm) ?? []).length, 1);
  assert.match(malformed, /records omitted/);
});

test("supported Workflow projection remains untouched", () => {
  const item = collab({
    tool: "workflow",
    workflowName: "Review",
    workflowDescription: "Check",
    prompt: "Inspect",
    workflowPhases: ["Review"],
  });
  assert.equal(codeAgentActivityText(item), undefined);
  const result = convertCodeTranscript(conversation([item]));
  const use = (result.rows[1].message.content as any[])[0];
  assert.equal(use.type, "tool_use");
  assert.equal(use.name, "Workflow");
  assert.deepEqual(use.input, {
    name: "Review",
    description: "Check",
    prompt: "Inspect",
    phases: ["Review"],
  });
  assert.deepEqual(result.unsupported, []);
});

test("child stop settles its task while preserving the Agent tool identity", () => {
  const c = conversation([collab()]);
  const running = convertCodeTranscript(c).rows;
  c.turns[0].items[0].agentsStates["child-1"].status = "interrupted";
  const stopped = convertCodeTranscript(c).rows;
  assert.deepEqual(stopped[1], running[1]);
  assert.ok(
    stopped.some(
      (row) =>
        row.type === "system" &&
        row.subtype === "task_notification" &&
        row.status === "stopped",
    ),
  );
});

test("nested child transcript retains its immediate parent tool and child identity", () => {
  const c = conversation([
    collab({
      agentThreads: {
        "child-1": {
          id: "child-1",
          backfilled: true,
          turns: [
            {
              id: "child-turn",
              prompt: "Child",
              attachments: [],
              createdAt: 1000,
              status: "completed",
              items: [
                {
                  id: "nested-spawn",
                  type: "subAgentActivity",
                  kind: "started",
                  agentThreadId: "grandchild",
                  agentThreads: {
                    grandchild: {
                      id: "grandchild",
                      turns: [
                        {
                          id: "grandchild-turn",
                          prompt: "Nested work",
                          attachments: [],
                          createdAt: 1000,
                          status: "completed",
                          items: [
                            {
                              id: "answer",
                              type: "agentMessage",
                              text: "Nested result",
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    }),
  ]);
  const rows = convertCodeTranscript(c).rows;
  const nested = rows.find(
    (row) =>
      row.agentId === "grandchild" &&
      JSON.stringify(row.message).includes("Nested result"),
  );
  assert.equal(
    nested?.parent_tool_use_id,
    "child-turn:agent:nested-spawn:grandchild",
  );
  assert.ok(
    rows.some(
      (row) =>
        row.agentId === "child-1" &&
        JSON.stringify(row.message).includes("nested-spawn"),
    ),
  );
});
