import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { stopWorkflowAgent } from "../../electron/ipc/workflow";
import type { Engine } from "../../electron/engine/engine";
import type { Conversation } from "../../shared/types";

test("only child threads recorded in the account can be interrupted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-workflow-stop-"));
  try {
    const store = new Store(root);
    const conversation: Conversation = {
      id: "conversation",
      title: "Fixture",
      mode: "code",
      providerId: "default",
      model: "fixture",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [
        {
          id: "turn",
          prompt: "test",
          attachments: [],
          createdAt: 1,
          status: "completed",
          items: [
            {
              id: "spawn",
              type: "collabAgentToolCall",
              tool: "spawnAgent",
              status: "completed",
              receiverThreadIds: ["child"],
              agentsStates: { child: { status: "running", message: null } },
            },
          ],
        },
      ],
    };
    store.conversations = [conversation];
    const calls: string[] = [];
    const engine = {
      elsewhereFor: () => undefined,
      state: { state: "ready" },
      rpc: {
        call: async (method: string) => {
          calls.push(method);
          return method === "thread/read"
            ? {
                thread: { id: "child", turns: [{ id: "child-turn", status: "inProgress" }] },
              }
            : {};
        },
      },
      gateway: {
        abortThread: (id: string) => {
          calls.push(`abort:${id}`);
        },
      },
    } as unknown as Engine;
    const context = { store, engine };
    await assert.rejects(
      stopWorkflowAgent(context, "conversation", "other"),
      /not part/,
    );
    assert.deepEqual(calls, []);
    const changed = await stopWorkflowAgent(context, "conversation", "child");
    assert.deepEqual(calls, ["thread/read", "turn/interrupt", "abort:child"]);
    assert.equal(changed.turns[0].items.at(-1)?.notice, "agents_killed");
    assert.equal(
      changed.turns[0].items[0].agentsStates.child.status,
      "interrupted",
    );
    assert.equal(
      new Store(root).conversation("conversation").turns[0].items[0]
        .agentsStates.child.status,
      "interrupted",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a completed child is not interrupted, and RPC failure leaves data unchanged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-workflow-stop-"));
  try {
    const store = new Store(root);
    store.conversations = [
      {
        id: "c",
        title: "Fixture",
        mode: "code",
        providerId: "default",
        model: "fixture",
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        turns: [
          {
            id: "t",
            prompt: "test",
            attachments: [],
            createdAt: 1,
            status: "completed",
            items: [
              {
                id: "s",
                type: "collabAgentToolCall",
                receiverThreadIds: ["child"],
                agentsStates: { child: { status: "running", message: null } },
              },
            ],
          },
        ],
      },
    ];
    const calls: string[] = [];
    const engine = {
      elsewhereFor: () => undefined,
      state: { state: "ready" },
      rpc: {
        call: async (method: string) => {
          calls.push(method);
          return { thread: { id: "child", turns: [{ id: "done", status: "completed" }] } };
        },
      },
    } as unknown as Engine;
    const result = await stopWorkflowAgent({ store, engine }, "c", "child");
    assert.deepEqual(calls, ["thread/read"]);
    assert.equal(
      result.turns[0].items[0].agentsStates.child.status,
      "completed",
    );
    const failed = {
      elsewhereFor: () => undefined,
      state: { state: "ready" },
      rpc: {
        call: async () => {
          throw Error("unavailable");
        },
      },
    } as unknown as Engine;
    await assert.rejects(
      stopWorkflowAgent({ store, engine: failed }, "c", "child"),
      /unavailable/,
    );
    assert.equal(
      store.conversation("c").turns[0].items[0].agentsStates.child.status,
      "completed",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background status refresh reads a hosted workflow's children from its space engine", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-workflow-refresh-"),
  );
  try {
    const store = new Store(root);
    store.conversations = [
      {
        id: "c",
        title: "Fixture",
        mode: "code",
        environment: { kind: "space", spaceId: "workflow-space" },
        providerId: "default",
        model: "fixture",
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        turns: [
          {
            id: "t",
            prompt: "test",
            attachments: [],
            createdAt: 1,
            status: "completed",
            items: [
              {
                id: "s",
                type: "collabAgentToolCall",
                tool: "workflow",
                receiverThreadIds: ["child"],
                agentsStates: {
                  child: { status: "running", message: "Working" },
                },
              },
            ],
          },
        ],
      },
    ];
    let calls = 0;
    const peer = {
      state: { state: "ready" },
      rpc: {
        call: async (method: string, params: any) => {
          assert.equal(method, "thread/read");
          assert.equal(params.threadId, "child");
          calls++;
          return {
            thread: {
              id: "child",
              status: { type: "idle" },
              turns: [{ id: "done", status: "completed" }],
            },
          };
        },
      },
    } as unknown as Engine;
    const engine = { elsewhereFor: () => peer } as unknown as Engine;
    const { refreshWorkflowAgents } =
      await import("../../electron/ipc/workflow");
    const first = await refreshWorkflowAgents({ store, engine }, "c");
    assert.equal(
      first.turns[0].items[0].agentsStates.child.status,
      "completed",
    );
    assert.equal(
      new Store(root).conversation("c").turns[0].items[0].agentsStates.child
        .status,
      "completed",
    );
    await refreshWorkflowAgents({ store, engine }, "c");
    assert.equal(calls, 2);
    await assert.rejects(
      refreshWorkflowAgents({ store, engine }, "missing"),
      /Conversation not found/,
    );
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native V2 child activity authorizes stop and status refresh without a collab tool item", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-workflow-v2-"));
  try {
    const store = new Store(root);
    store.conversations = [
      {
        id: "parent",
        title: "Fixture",
        mode: "code",
        providerId: "default",
        model: "fixture",
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        turns: [
          {
            id: "turn",
            prompt: "test",
            attachments: [],
            createdAt: 1,
            status: "completed",
            items: [
              {
                id: "child",
                type: "subAgentActivity",
                kind: "started",
                agentThreadId: "native-child",
                agentPath: "/root/review",
              },
            ],
          },
        ],
      },
    ];
    const methods: string[] = [];
    const engine = {
      elsewhereFor: () => undefined,
      state: { state: "ready" },
      rpc: {
        call: async (method: string) => {
          methods.push(method);
          return method === "thread/read"
            ? {
                thread: {
                  id: "native-child",
                  createdAt: 42,
                  updatedAt: 43,
                  status: { type: "idle" },
                  turns: [
                    {
                      id: "done",
                      status: "completed",
                      items: [
                        {
                          id: "command",
                          type: "commandExecution",
                          status: "completed",
                          command: "echo fixture",
                        },
                      ],
                    },
                  ],
                },
              }
            : {};
        },
      },
    } as unknown as Engine;
    const { refreshWorkflowAgents } =
      await import("../../electron/ipc/workflow");
    const updated = await refreshWorkflowAgents({ store, engine }, "parent");
    assert.equal(
      updated.turns[0].items[0].agentsStates["native-child"].status,
      "completed",
    );
    assert.equal(
      updated.turns[0].items[0].agentDurationMs["native-child"],
      1000,
    );
    assert.equal(updated.turns[0].items[0].agentToolUses["native-child"], 1);
    await assert.rejects(
      stopWorkflowAgent({ store, engine }, "parent", "other"),
      /not part/,
    );
    await stopWorkflowAgent({ store, engine }, "parent", "native-child");
    assert.equal(
      methods.filter((method) => method === "turn/interrupt").length,
      0,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("child stop uses its environment engine and refuses an account retired during read", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-child-environment-"),
  );
  const store = new Store(root);
  store.conversations = [
    {
      id: "parent",
      title: "Parent",
      mode: "code",
      model: "fixture",
      providerId: "fixture",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [
        {
          id: "turn",
          prompt: "Inspect",
          attachments: [],
          status: "completed",
          createdAt: 1,
          items: [
            {
              id: "spawn",
              type: "subAgentActivity",
              kind: "started",
              agentThreadId: "child",
            },
          ],
        },
      ],
    },
  ];
  const calls: string[] = [];
  let current = true;
  let retire = false;
  const peer = {
    state: { state: "ready" },
    rpc: {
      call: async (method: string) => {
        calls.push(method);
        if (method === "thread/read") {
          if (retire) current = false;
          return {
            thread: {
              id: "child",
              turns: [{ id: "child-turn", status: "inProgress" }],
            },
          };
        }
        return {};
      },
    },
  } as unknown as Engine;
  const engine = { elsewhereFor: () => peer } as unknown as Engine;
  try {
    await stopWorkflowAgent(
      { store, engine, current: () => current },
      "parent",
      "child",
    );
    assert.deepEqual(calls, ["thread/read", "turn/interrupt"]);
    calls.length = 0;
    retire = true;
    await assert.rejects(
      stopWorkflowAgent(
        { store, engine, current: () => current },
        "parent",
        "child",
      ),
      /connection changed/,
    );
    assert.deepEqual(calls, ["thread/read"]);
  } finally {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
