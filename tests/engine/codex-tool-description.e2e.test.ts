/**
 * R7 end to end with the real bundled Codex app-server: Codex → the real
 * local Gateway (which adds a `description` parameter to the shell tools and
 * reads it back from the model's call) → a loopback Responses fixture. No
 * credentials, no network beyond 127.0.0.1.
 *
 * It pins down what R7 relies on and would break on a Codex upgrade:
 * - Codex runs a shell call that carries the extra `description` field;
 * - the command item id is the call's `call_id`, both live (item/started)
 *   and in `thread/read` (which the Workflow panel uses for child agents);
 * - the next request replays the original arguments, description included.
 * Skipped when the Codex binary is not installed.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Gateway } from "../../electron/engine/gateway";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { resolveRuntime } from "../../electron/engine/runtime";
import { projectAgentTranscript } from "../../electron/conversations/agent-transcript";
import {
  ToolDescriptionStore,
  applyToolDescriptions,
  releaseToolDescriptions,
  toolDescriptionsFor,
} from "../../electron/engine/tool-description-store";
import { readWorkflowAgent } from "../../electron/ipc/workflow";
import { rebuildChildCommands } from "../../electron/ipc/workflow-rollout";
import {
  CodexHost,
  FAKE_KEY,
  MODEL,
  MockResponses,
  findTool,
  functionCall,
  message,
  stopAllHosts,
  tempRoot,
  until,
  type Json,
} from "../spikes/harness";
import type { ToolDescriptionEvent } from "../../shared/tool-description";
import { agentThreadIds } from "../../shared/workflow-usage";
import type { Conversation } from "../../shared/types";

let binary: string | undefined;
try {
  binary = resolveRuntime();
} catch {
  binary = undefined;
}

after(() => stopAllHosts());

test("CodexHost.stop waits for process close before callers remove the writable profile", async () => {
  const host = new CodexHost("unused", {} as MockResponses);
  let close!: () => void;
  host.processClosed = new Promise<void>((resolve) => {
    close = resolve;
  });
  host.rpc.stop = async () => {};
  let stopped = false;
  const stopping = host.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    stopped,
    false,
    "an exited process can still have pending pipes/writers",
  );
  close();
  await stopping;
  assert.equal(stopped, true);
});

test("CodexHost.turn correlates buffered completion and items with the turn/start ID", async () => {
  const host = new CodexHost("unused", {} as MockResponses);
  host.rpc.call = async () => {
    // A single stdio read can include a terminal notification from an older
    // turn and the new turn's items/completion. A thread ID alone is not a
    // causal completion barrier for the turn this caller just started.
    host.notifications.push(
      {
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "older",
          item: { id: "old-command", type: "commandExecution" },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { id: "older", status: "interrupted" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "actual",
          item: { id: "actual-command", type: "commandExecution" },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { id: "actual", status: "completed" },
        },
      },
    );
    return { turn: { id: "actual", status: "inProgress" } };
  };
  const result = await host.turn("thread", "Run the actual turn");
  assert.equal(result.completed.turn.id, "actual");
  assert.equal(result.completed.turn.status, "completed");
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["actual-command"],
  );
});

test(
  "a shell call with a model-written description runs and the description reaches the command item",
  {
    skip: !binary && "the bundled Codex binary is not installed",
    timeout: 120_000,
  },
  async () => {
    const root = tempRoot("r7-e2e");
    const mock = await new MockResponses().start();
    const events: ToolDescriptionEvent[] = [];
    const store = new Store(path.join(root, "profile"));
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    const internals = engine as any;
    const gateway = new Gateway(
      () => ({
        provider: {
          id: "e2e",
          name: "Fixture",
          model: MODEL,
          models: [],
          baseUrl: mock.url,
          protocol: "responses",
        },
        apiKey: FAKE_KEY,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        onToolDescription: (event) => {
          events.push(event);
          internals.signals.toolDescription(event);
        },
      },
    );
    await gateway.start();
    const host = new CodexHost(
      path.join(root, "codex-home"),
      { url: gateway.url } as MockResponses,
      {},
      { SPIKE_GATEWAY_TOKEN: gateway.token },
    );
    try {
      let shellTool: Json | undefined;
      mock.script = (body, index) => {
        if (index > 0) return [message("R7_DONE")];
        shellTool = findTool(body, (name) =>
          ["exec_command", "shell_command", "shell"].includes(name),
        );
        if (!shellTool) return [message("NO_SHELL_TOOL")];
        const command = "echo hello-r7";
        return [
          functionCall(shellTool, "call_r7", {
            ...(shellTool.name === "exec_command"
              ? { cmd: command }
              : { command }),
            description: "Print a greeting",
          }),
        ];
      };
      host.onRequest = (req) =>
        req.method.endsWith("/requestApproval")
          ? { decision: "accept" }
          : undefined;
      await host.start();
      const cwd = path.join(root, "work");
      const threadId = await host.thread(MODEL, cwd, {
        approvalPolicy: "never",
      });
      const conversation: Conversation = {
        id: "c",
        title: "R7",
        mode: "code",
        providerId: "e2e",
        model: MODEL,
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        threadId,
        cwd,
        turns: [
          {
            id: "turn",
            prompt: "Say hello",
            attachments: [],
            createdAt: 1,
            status: "inProgress",
            items: [],
          },
        ],
      };
      store.conversations = [conversation];
      internals.routes.set(threadId, conversation.id);
      host.rpc.on("notification", (msg) => internals.notification(msg));

      const { items, completed } = await host.turn(threadId, "Say hello");

      // (a) The gateway asked the model for a description.
      assert.ok(shellTool, "Codex offered a shell tool");
      const upstreamTool = findTool(
        mock.requests[0],
        (name) => name === shellTool!.name,
      )!;
      assert.equal(
        upstreamTool.parameters.properties.description.type,
        "string",
      );
      assert.ok(upstreamTool.parameters.required.includes("description"));

      // (b) Codex ran the call despite the extra field; the item id is the call id.
      const started = host.notifications.find(
        (n) =>
          n.method === "item/started" &&
          n.params?.item?.type === "commandExecution",
      );
      const diagnostics = () =>
        JSON.stringify({
          shell: shellTool?.name,
          turnId: completed.turn?.id,
          turnStatus: completed.turn?.status,
          turnError: JSON.stringify(completed.turn?.error ?? null).slice(
            0,
            600,
          ),
          items: items
            .slice(-12)
            .map((item) => ({ type: item.type, id: item.id })),
          notifications: host.notifications.slice(-24).map((notification) => ({
            method: notification.method,
            threadId: notification.params?.threadId,
            turnId:
              notification.params?.turnId ?? notification.params?.turn?.id,
            itemType: notification.params?.item?.type,
            itemId: notification.params?.item?.id,
          })),
          fixtureToolOutputs: (mock.requests.at(-1)?.input ?? [])
            .filter(
              (item: Json) =>
                item.type === "function_call_output" &&
                item.call_id === "call_r7",
            )
            .slice(-2)
            .map((item: Json) => String(item.output ?? "").slice(0, 600)),
        });
      assert.equal(completed.turn?.status, "completed", diagnostics());
      assert.equal(started?.params.item.id, "call_r7", diagnostics());
      const command = items.find((item) => item.type === "commandExecution");
      assert.equal(command?.id, "call_r7");
      assert.equal(command?.exitCode, 0);
      assert.match(String(command?.aggregatedOutput ?? ""), /hello-r7/);
      assert.deepEqual(events, [
        { threadId, callId: "call_r7", description: "Print a greeting" },
      ]);
      const recorded = conversation.turns[0].items.find(
        (item) => item.id === "call_r7",
      );
      assert.equal(recorded?.type, "commandExecution");
      assert.equal(recorded?.description, "Print a greeting");

      // (c) The next request replays the original arguments.
      assert.equal(mock.requests.length, 2);
      const replayed = (mock.requests[1].input as Json[]).find(
        (entry) =>
          entry.type === "function_call" && entry.call_id === "call_r7",
      );
      assert.equal(
        JSON.parse(replayed!.arguments).description,
        "Print a greeting",
      );

      // (d) thread/read keeps the call id, so stored child descriptions fit.
      const read = await host.rpc.call("thread/read", {
        threadId,
        includeTurns: true,
      });
      const thread = read.thread;
      const reported = thread.turns
        .flatMap((turn: Json) => turn.items)
        .filter((item: Json) => item.type === "commandExecution");
      if (reported.length) {
        // A later Codex reports commands itself: they must keep the call id.
        assert.deepEqual(
          reported.map((item: Json) => item.id),
          ["call_r7"],
        );
      } else {
        // 0.144.1 keeps only messages; the Workflow panel rebuilds commands.
        assert.equal(await rebuildChildCommands(thread), 1);
      }
      const descriptions = new ToolDescriptionStore(
        path.join(root, "descriptions"),
      );
      descriptions.put(threadId, "call_r7", "Print a greeting", {
        conversationId: conversation.id,
        persist: false,
      });
      applyToolDescriptions(thread, descriptions);
      const transcript = projectAgentTranscript(thread, MODEL, "Say hello");
      assert.deepEqual(
        transcript.items
          .filter((item) => item.type !== "userMessage")
          .map((item) => [item.type, item.id]),
        [
          ["commandExecution", "call_r7"],
          ["agentMessage", thread.turns[0].items.at(-1).id],
        ],
      );
      const projected = transcript.items.find(
        (item) => item.type === "commandExecution",
      )!;
      assert.equal(projected.description, "Print a greeting");
      assert.equal(projected.exitCode, 0);
      assert.equal(projected.status, "completed");
      assert.match(String(projected.aggregatedOutput), /hello-r7/);
    } finally {
      await host.stop().catch(() => {});
      await gateway.close();
      await mock.close();
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a child agent's described command shows in the Workflow panel transcript",
  {
    skip: !binary && "the bundled Codex binary is not installed",
    timeout: 120_000,
  },
  async () => {
    const root = tempRoot("r7-e2e-child");
    const mock = await new MockResponses().start();
    const store = new Store(path.join(root, "profile"));
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    const internals = engine as any;
    const gateway = new Gateway(
      () => ({
        provider: {
          id: "e2e",
          name: "Fixture",
          model: MODEL,
          models: [],
          baseUrl: mock.url,
          protocol: "responses",
        },
        apiKey: FAKE_KEY,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        onToolDescription: (event) => internals.signals.toolDescription(event),
      },
    );
    await gateway.start();
    // Codex's home is in the profile, as the engine starts it.
    const host = new CodexHost(
      path.join(store.root, "codex-home"),
      { url: gateway.url } as MockResponses,
      { "features.multi_agent": true, "features.multi_agent_v2": true },
      { SPIKE_GATEWAY_TOKEN: gateway.token },
    );
    try {
      let parentId = "";
      mock.script = (body) => {
        const thread = body.client_metadata?.thread_id;
        const step = mock.forThread(thread).length - 1;
        if (thread !== parentId) {
          if (step > 0) return [message("CHILD_DONE")];
          const shell = findTool(body, (name) => name === "exec_command");
          if (!shell) return [message("NO_SHELL_TOOL")];
          return [
            functionCall(shell, "call_child", {
              cmd: "echo greet-checked",
              description: "Check greet against README",
            }),
          ];
        }
        const tool = (name: string) => findTool(body, (n) => n === name)!;
        if (step === 0)
          return [
            functionCall(tool("spawn_agent"), "call_spawn", {
              task_name: "check_greet",
              message: "Check greet against README",
              fork_turns: "none",
            }),
          ];
        if (step === 1)
          return [
            functionCall(tool("wait_agent"), "call_wait", {
              timeout_ms: 30_000,
            }),
          ];
        return [message("PARENT_DONE")];
      };
      await host.start();
      const cwd = path.join(root, "work");
      parentId = await host.thread(MODEL, cwd, { approvalPolicy: "never" });
      const conversation: Conversation = {
        id: "c",
        title: "R7 child",
        mode: "code",
        providerId: "e2e",
        model: MODEL,
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        threadId: parentId,
        cwd,
        turns: [
          {
            id: "turn",
            prompt: "Check greet",
            attachments: [],
            createdAt: 1,
            status: "inProgress",
            items: [],
          },
        ],
      };
      store.conversations = [conversation];
      internals.routes.set(parentId, conversation.id);
      const descriptions = toolDescriptionsFor(
        engine,
        store.root,
        () => store.conversations,
      );
      host.rpc.on("notification", (msg) => internals.notification(msg));

      await host.turn(parentId, "Check greet");
      const childId = conversation.turns[0].items
        .flatMap(agentThreadIds)
        .find((id) => id !== parentId);
      assert.ok(childId, "the parent recorded its child agent");
      await until(
        () =>
          host.notifications.some(
            (n) =>
              n.method === "turn/completed" && n.params?.threadId === childId,
          ),
        "the child's turn",
      );

      // The gateway's signal for the child's call reached the store.
      assert.equal(
        descriptions.get(childId, "call_child"),
        "Check greet against README",
      );

      engine.rpc = host.rpc;
      engine.state = { state: "ready" };
      const transcript = await readWorkflowAgent(
        { store, engine },
        conversation.id,
        childId,
      );
      const command = transcript.items.find(
        (item) => item.type === "commandExecution",
      );
      assert.equal(command?.id, "call_child");
      assert.equal(command?.description, "Check greet against README");
      assert.equal(command?.command, "echo greet-checked");
      assert.equal(command?.exitCode, 0);
      assert.equal(transcript.items.at(-1)?.text, "CHILD_DONE");
    } finally {
      releaseToolDescriptions(engine);
      await host.stop().catch(() => {});
      await gateway.close();
      await mock.close();
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
